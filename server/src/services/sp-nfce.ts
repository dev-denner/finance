import type { Page } from 'playwright-core';
import { badRequest } from '../lib/errors';
import { MAX_NFCE_NAVIGATION_MS, withNfceBrowser, type BrowserRequest } from './nfce-browser';
import type { PurchaseInput } from './purchase-input';

const ALLOWED_HOST = 'www.nfce.fazenda.sp.gov.br';
const QR_PATHS = new Set(['/qrcode', '/NFCeConsultaPublica/Paginas/ConsultaQRCode.aspx']);
const MAX_ITEMS = 300;

interface SpItemSnapshot {
  leftText: string;
  rightText: string;
  descriptionText: string;
  quantityText: string;
  unitText: string;
  unitPriceText: string;
  discountText: string | null;
  totalText: string;
}

export interface SpNfceDomSnapshot {
  supplierName: string;
  supplierCnpjText: string;
  generalInfo: string;
  accessKeyText: string;
  grossTotalText: string | null;
  discountText: string | null;
  totalText: string;
  paymentMethod: string | null;
  items: SpItemSnapshot[];
}

function validAccessKey(key: string): boolean {
  if (!/^35\d{4}\d{14}65\d{22}$/.test(key)) return false;
  const digits = [...key.slice(0, 43)].map(Number);
  let weight = 2;
  let sum = 0;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    sum += (digits[index] ?? 0) * weight;
    weight = weight === 9 ? 2 : weight + 1;
  }
  const remainder = sum % 11;
  const checkDigit = remainder < 2 ? 0 : 11 - remainder;
  return checkDigit === Number(key[43]);
}

export function validateSpQrUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw badRequest('Informe uma URL válida de consulta NFC-e da SEFAZ-SP.');
  }
  const params = [...url.searchParams.entries()];
  const payload = url.searchParams.get('p') ?? '';
  const parts = payload.split('|');
  const accessKey = parts[0] ?? '';
  const validPayload = parts.length === 5 &&
    /^\d{44}$/.test(accessKey) && validAccessKey(accessKey) &&
    parts[1] === '2' && (parts[2] === '1' || parts[2] === '2') &&
    /^[1-9]\d{0,5}$/.test(parts[3] ?? '') && /^[a-f\d]{40}$/i.test(parts[4] ?? '');
  if (
    url.protocol !== 'https:' || url.hostname !== ALLOWED_HOST || url.port ||
    url.username || url.password || url.hash || !QR_PATHS.has(url.pathname) ||
    params.length !== 1 || params[0]?.[0] !== 'p' || !validPayload
  ) {
    throw badRequest('A URL deve ser um QR Code válido da NFC-e da SEFAZ-SP.');
  }
  return url;
}

export function isAllowedSpBrowserRequest(request: BrowserRequest): boolean {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.hostname !== ALLOWED_HOST || url.port || url.username || url.password) {
    return false;
  }
  if (request.resourceType === 'document') {
    if (request.method !== 'GET') return false;
    try {
      validateSpQrUrl(url.toString());
      return true;
    } catch {
      return false;
    }
  }
  return ['GET', 'POST'].includes(request.method) &&
    ['script', 'stylesheet', 'image', 'font', 'xhr', 'fetch'].includes(request.resourceType) &&
    (url.pathname === '/qrcode' || url.pathname.startsWith('/NFCeConsultaPublica/'));
}

export function isAllowedSpFinalUrl(url: URL): boolean {
  return url.protocol === 'https:' && url.hostname === ALLOWED_HOST && !url.port &&
    !url.username && !url.password && QR_PATHS.has(url.pathname);
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function safePaymentMethod(value: string | null): string | null {
  if (!value) return null;
  const normalized = normalizeText(value);
  const method = normalized.match(/pix|dinheiro|cart[aã]o\s+de\s+cr[eé]dito|cart[aã]o\s+de\s+d[eé]bito|vale[-\s]?(?:refei[cç][aã]o|alimenta[cç][aã]o|presente)|cheque|boleto|transfer[eê]ncia|outros?/i)?.[0];
  return method ? normalizeText(method).slice(0, 100) : null;
}

function moneyToCents(text: string, field: string): number {
  const match = normalizeText(text).match(/-?\d[\d.]*,\d{1,2}/);
  if (!match) throw badRequest(`Não foi possível interpretar ${field} da NFC-e de SP.`);
  const value = Math.round(Number(match[0].replace(/\./g, '').replace(',', '.')) * 100);
  if (!Number.isSafeInteger(value) || value < 0) throw badRequest(`Valor inválido em ${field} da NFC-e de SP.`);
  return value;
}

function valueAfterLabel(text: string, label: string): string | null {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return normalizeText(text).match(new RegExp(`${escaped}\\s*:?\\s*([^\\n]+?)(?=\\s+(?:Número|Série|Emissão|Protocolo|Ambiente)\\b|$)`, 'i'))?.[1] ?? null;
}

function parseIssuedAt(info: string): string {
  const match = info.match(/Emissão\s*:?\s*(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}:\d{2}(?::\d{2})?)(?:([+-]\d{2}:\d{2}))?/i);
  if (!match) throw badRequest('Não foi possível ler a data de emissão da NFC-e de SP.');
  const time = match[4]?.length === 5 ? `${match[4]}:00` : match[4];
  return `${match[3]}-${match[2]}-${match[1]}T${time}${match[5] ?? '-03:00'}`;
}

function parseQuantity(text: string): string {
  const match = normalizeText(text).match(/(?:Qtde\.?\s*:?\s*)?([0-9]+(?:[,.][0-9]+)?)/i);
  if (!match || Number(match[1]?.replace(',', '.')) <= 0) {
    throw badRequest('Não foi possível ler a quantidade de um item da NFC-e de SP.');
  }
  return (match[1] ?? '').replace(',', '.');
}

function deriveUnitPriceCents(totalCents: number, quantity: string, discountCents: number | null): number | null {
  const scaledQuantity = Number(quantity) * 1_000_000;
  if (!Number.isSafeInteger(scaledQuantity) || scaledQuantity <= 0) return null;
  const numerator = (totalCents + (discountCents ?? 0)) * 1_000_000;
  const unitPriceCents = numerator / scaledQuantity;
  return Number.isSafeInteger(unitPriceCents) && Number.isInteger(unitPriceCents) && unitPriceCents >= 0 ? unitPriceCents : null;
}

export function parseSpNfceSnapshot(snapshot: SpNfceDomSnapshot): PurchaseInput {
  const supplierName = normalizeText(snapshot.supplierName);
  const supplierCnpj = snapshot.supplierCnpjText.match(/\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/)?.[0].replace(/\D/g, '') ?? '';
  const accessKey = snapshot.accessKeyText.replace(/\D/g, '');
  const invoiceNumber = valueAfterLabel(snapshot.generalInfo, 'Número')?.replace(/\D/g, '') ?? '';
  const series = valueAfterLabel(snapshot.generalInfo, 'Série')?.replace(/\D/g, '') ?? '';
  if (!supplierName) throw badRequest('Não foi possível ler o fornecedor da NFC-e de SP.');
  if (supplierCnpj.length !== 14) throw badRequest('Não foi possível ler o CNPJ do fornecedor na NFC-e de SP.');
  if (!validAccessKey(accessKey) || accessKey.slice(6, 20) !== supplierCnpj) {
    throw badRequest('A chave de acesso da NFC-e de SP é inválida ou não confere com o fornecedor.');
  }
  if (!invoiceNumber || !series) throw badRequest('Não foi possível ler o número ou a série da NFC-e de SP.');
  if (snapshot.items.length === 0 || snapshot.items.length > MAX_ITEMS) {
    throw badRequest('A NFC-e de SP não contém uma quantidade válida de itens.');
  }
  const items = snapshot.items.map((item) => {
    const description = normalizeText(item.descriptionText || item.leftText)
      .replace(/\s*\(\s*Código\s*:\s*[^)]*\)/i, '')
      .replace(/\s*(?:Qtde\.?\s*:|Quantidade\s*:|UN\s*:|Unidade\s*:|Vl\.?\s*Unit\.?\s*:|Valor unitário\s*:|Vl\.?\s*Desc\.?\s*:).*$/i, '')
      .trim();
    const quantityText = item.quantityText || item.leftText.match(/Qtde\.?\s*:?\s*[0-9]+(?:[,.][0-9]+)?/i)?.[0] || '';
    const unitText = item.unitText || item.leftText.match(/(?:UN|Unidade)\s*:?\s*[\p{L}\d._-]+/iu)?.[0] || '';
    const unitPriceText = item.unitPriceText || item.leftText.match(/(?:Vl\.?\s*Unit\.?|Valor unitário)\s*:?\s*(?:R\$\s*)?[\d.]+(?:,\d{1,2})?/i)?.[0] || '';
    const discountText = item.discountText || item.leftText.match(/(?:Vl\.?\s*Desc\.?|Desconto)\s*:?\s*(?:R\$\s*)?[\d.]+,\d{1,2}/i)?.[0] || null;
    const unit = unitText.replace(/^(?:UN|Unidade)\s*:?\s*/i, '').slice(0, 20);
    if (!description || !unit) throw badRequest('Um item da NFC-e de SP está sem descrição ou unidade.');
    const quantity = parseQuantity(quantityText);
    const discountCents = discountText ? moneyToCents(discountText, 'desconto do item') : null;
    const totalCents = moneyToCents(item.totalText || item.rightText, 'total do item');
    const unitPriceHasCents = /(?:Vl\.?\s*Unit\.?|Valor unitário)\s*:?\s*(?:R\$\s*)?[\d.]+,\d{1,2}/i.test(unitPriceText);
    const unitPriceIsIntegerOnly = /(?:Vl\.?\s*Unit\.?|Valor unitário)\s*:?\s*(?:R\$\s*)?\d{1,6}\s*$/i.test(unitPriceText);
    const derivedUnitPrice = unitPriceIsIntegerOnly ? deriveUnitPriceCents(totalCents, quantity, discountCents) : null;
    if (unitPriceIsIntegerOnly && derivedUnitPrice === null) throw badRequest('O preço unitário incompleto da NFC-e de SP não pode ser calculado com segurança.');
    return {
      description,
      quantity,
      unit,
      unitPriceCents: unitPriceHasCents ? moneyToCents(unitPriceText, 'preço unitário') : derivedUnitPrice ?? moneyToCents(unitPriceText, 'preço unitário'),
      discountCents,
      totalCents,
    };
  });
  const totalCents = moneyToCents(snapshot.totalText, 'total a pagar');
  const invoiceDiscountCents = snapshot.discountText ? moneyToCents(snapshot.discountText, 'desconto total') : 0;
  const grossTotalCents = snapshot.grossTotalText
    ? moneyToCents(snapshot.grossTotalText, 'valor bruto')
    : totalCents + invoiceDiscountCents;
  if (
    items.reduce((sum, item) => sum + item.totalCents, 0) !== grossTotalCents ||
    grossTotalCents - invoiceDiscountCents !== totalCents
  ) {
    throw badRequest('Os itens, descontos e total a pagar não conferem com os valores informados pela SEFAZ-SP.');
  }
  return {
    accessKey,
    supplierName,
    supplierCnpj,
    invoiceNumber,
    series,
    issuedAt: parseIssuedAt(snapshot.generalInfo),
    totalCents,
    invoiceDiscountCents,
    paymentMethod: safePaymentMethod(snapshot.paymentMethod),
    items,
  };
}

/** Extração DOM sem cabeçalhos semânticos; `#tabResult` usa exatamente duas células por item. */
export function extractSpNfceSnapshotFromDocument(doc: Document): SpNfceDomSnapshot {
  // Esta função é serializada e executada no contexto do Chromium via
  // `page.evaluate`; mantenha suas dependências locais/autocontidas.
  const normalize = (value: string): string => value.replace(/\s+/g, ' ').trim();
  const maxItems = 300;
  const value = (selector: string, root: ParentNode = doc): string => {
    const node = root.querySelector(selector);
    return normalize((node as HTMLElement | null)?.innerText || node?.textContent || '');
  };
  const panel = (label: RegExp): string => {
    const heading = Array.from(doc.querySelectorAll('h4.ui-collapsible-heading, h3, h4'))
      .find((node) => label.test(normalize(node.textContent ?? '')));
    return heading?.parentElement?.querySelector('.ui-collapsible-content')?.textContent ?? heading?.parentElement?.textContent ?? '';
  };
  const generalInfo = panel(/informações gerais da nota/i);
  const accessKeyText = panel(/chave de acesso/i);
  const totalRows = Array.from(doc.querySelectorAll('#totalNota #linhaTotal'));
  const totalRow = (label: RegExp): string | null => {
    const row = totalRows.find((item) => label.test(item.textContent ?? ''));
    return row ? value('.totalNumb', row) || normalize(row.textContent ?? '') : null;
  };
  const tableRows = Array.from(doc.querySelectorAll<HTMLTableRowElement>('#tabResult tr'));
  if (tableRows.length > maxItems) throw new Error('item-limit');
  const items = tableRows.map((row) => {
    const left = row.cells[0];
    const right = row.cells[1];
    const leftText = normalize(left?.innerText || left?.textContent || '');
    const rightText = normalize(right?.innerText || right?.textContent || '');
    return {
      leftText,
      rightText,
      descriptionText: value('.txtTit', left ?? row),
      quantityText: value('.Rqtd', left ?? row),
      unitText: value('.RUN', left ?? row),
      unitPriceText: value('.RvlUnit', left ?? row),
      discountText: value('.RvlDesc', left ?? row) || null,
      totalText: value('.valor', right ?? row),
    };
  });
  const paymentHeader = doc.querySelector('#linhaForma');
  const paymentMethod = paymentHeader?.nextElementSibling?.querySelector('.txtTit, .tx')?.textContent ?? null;
  const supplierRoot = doc.querySelector('.txtCenter') ?? doc;
  return {
    supplierName: value('.txtTopo', supplierRoot),
    supplierCnpjText: value('.text', supplierRoot),
    generalInfo,
    accessKeyText,
    grossTotalText: totalRow(/valor total/i),
    discountText: totalRow(/descontos?/i),
    totalText: totalRow(/valor a pagar/i) ?? totalRow(/valor total/i) ?? '',
    paymentMethod: paymentMethod ? normalize(paymentMethod) : null,
    items,
  };
}

async function readRenderedNfce(page: Page): Promise<SpNfceDomSnapshot> {
  // The transpiler may add a `__name` helper that is absent in Chromium.
  return page.evaluate<SpNfceDomSnapshot>(`(() => { const __name = (fn) => fn; return (${extractSpNfceSnapshotFromDocument.toString()})(document); })()`);
}

export async function previewSpNfce(qrUrl: string): Promise<PurchaseInput> {
  const url = validateSpQrUrl(qrUrl);
  return withNfceBrowser({
    state: 'SP',
    url,
    hosts: [ALLOWED_HOST],
    isAllowedRequest: isAllowedSpBrowserRequest,
    isAllowedFinalUrl: isAllowedSpFinalUrl,
  }, async (page, setPhase) => {
    setPhase('carregar os itens da NFC-e de SP');
    await page.locator('#tabResult tr').first().waitFor({ state: 'attached', timeout: MAX_NFCE_NAVIGATION_MS });
    setPhase('carregar os dados de identificação da NFC-e de SP');
    for (const label of [/informações gerais da nota/i, /chave de acesso/i]) {
      const heading = page.locator('h4.ui-collapsible-heading, h3, h4').filter({ hasText: label }).first();
      const currentClass = await heading.getAttribute('class').catch(() => null);
      if (currentClass?.includes('collapsed')) await heading.click();
    }
    setPhase('extrair e validar os dados da NFC-e de SP');
    return parseSpNfceSnapshot(await readRenderedNfce(page));
  });
}
