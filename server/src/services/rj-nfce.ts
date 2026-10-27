import type { Page } from 'playwright-core';
import { badRequest } from '../lib/errors';
import { classifyNfcePortalStatus, MAX_NFCE_NAVIGATION_MS, withNfceBrowser, type BrowserRequest } from './nfce-browser';
import type { PurchaseInput } from './purchase-input';
export type { PurchaseInput, PurchaseItemInput } from './purchase-input';

const ALLOWED_HOST = 'consultadfe.fazenda.rj.gov.br';
const ALLOWED_LEGACY_REDIRECTOR_HOST = 'www4.fazenda.rj.gov.br';
const ALLOWED_SCRIPT_HOST = 'code.jquery.com';
const ALLOWED_SCRIPT_PATH = '/jquery-1.9.1.js';
const MAX_ITEMS = 300;

interface RjNfceDomSnapshot {
  supplierName: string;
  supplierCnpjText: string;
  generalInfo: string;
  accessKeyText: string;
  grossTotalText: string | null;
  discountText: string | null;
  totalText: string;
  paymentMethod: string | null;
  items: {
    description: string;
    quantityText: string;
    unitText: string;
    unitPriceText: string;
    discountText: string | null;
    totalText: string;
  }[];
}

export function validateRjQrUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw badRequest('Informe uma URL válida de consulta NFC-e da SEFAZ-RJ.');
  }
  const params = [...url.searchParams.entries()];
  const qr = url.searchParams.get('p') ?? '';
  const isCurrentPortal = url.protocol === 'https:' && url.hostname === ALLOWED_HOST;
  // Older RJ QR codes use this exact HTTP redirector and an extended payload.
  const isLegacyRedirector = url.protocol === 'http:' && url.hostname === ALLOWED_LEGACY_REDIRECTOR_HOST;
  const validCurrentQrPayload = /^\d{44}\|3\|1$/.test(qr) ||
    /^\d{44}\|2\|[12]\|[1-9]\d{0,5}\|[a-f\d]{40}$/i.test(qr);
  const validLegacyQrPayload = /^\d{44}\|2\|1\|3\|[a-f\d]{40}$/i.test(qr);
  if (
    (!isCurrentPortal && !isLegacyRedirector) || url.port ||
    url.username || url.password || url.hash || url.pathname !== '/consultaNFCe/QRCode' ||
    params.length !== 1 || params[0]?.[0] !== 'p' ||
    !(isCurrentPortal ? validCurrentQrPayload : validLegacyQrPayload)
  ) {
    throw badRequest('A URL deve ser o QR Code oficial da NFC-e da SEFAZ-RJ.');
  }
  return url;
}

export function isAllowedBrowserRequest(request: BrowserRequest): boolean {
  let requestUrl: URL;
  try {
    requestUrl = new URL(request.url);
  } catch {
    return false;
  }
  if (requestUrl.port || requestUrl.username || requestUrl.password) return false;
  if (requestUrl.hostname === ALLOWED_HOST && requestUrl.protocol === 'https:') return true;
  if (requestUrl.hostname === ALLOWED_LEGACY_REDIRECTOR_HOST) return isAllowedLegacyRjHttpRequest(request);
  return requestUrl.hostname === ALLOWED_SCRIPT_HOST &&
    requestUrl.pathname === ALLOWED_SCRIPT_PATH && requestUrl.search === '' && requestUrl.hash === '' &&
    request.method === 'GET' && request.resourceType === 'script';
}

export function isAllowedLegacyRjHttpRequest(request: BrowserRequest): boolean {
  if (request.method !== 'GET' || request.resourceType !== 'document') return false;
  try {
    const url = validateRjQrUrl(request.url);
    return url.protocol === 'http:' && url.hostname === ALLOWED_LEGACY_REDIRECTOR_HOST &&
      url.pathname === '/consultaNFCe/QRCode';
  } catch {
    return false;
  }
}

export function withoutReferer(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => name.toLowerCase() !== 'referer'));
}

function textValue(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function moneyToCents(text: string, field: string): number {
  const match = textValue(text).match(/-?\d[\d.]*,\d{1,2}/);
  if (!match) throw badRequest(`Não foi possível ler ${field} da NFC-e.`);
  const value = Math.round(Number(match[0].replace(/\./g, '').replace(',', '.')) * 100);
  if (!Number.isSafeInteger(value) || value < 0) throw badRequest(`Valor inválido em ${field}.`);
  return value;
}

function parseQuantity(text: string): string {
  const match = textValue(text).match(/(?:Qtde\.?\s*:\s*)?([0-9]+(?:[,.][0-9]+)?)/i);
  if (!match) throw badRequest('Não foi possível ler a quantidade de um item da NFC-e.');
  const quantity = match[1].replace(',', '.');
  if (!Number.isFinite(Number(quantity)) || Number(quantity) <= 0) {
    throw badRequest('Quantidade inválida em um item da NFC-e.');
  }
  return quantity;
}

function readInfoValue(info: string, label: string): string | null {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return textValue(info).match(new RegExp(`${escaped}\\s*:?\\s*([^\\n]+?)(?=\\s+(?:Série|Emissão|Via Consumidor|Protocolo de Autorização|Ambiente de Produção)\\b|$)`, 'i'))?.[1] ?? null;
}

function parseIssuedAt(info: string): string {
  const match = info.match(/Emissão\s*:\s*(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}:\d{2}:\d{2})(?:([+-]\d{2}:\d{2}))?/i);
  if (!match) throw badRequest('Não foi possível ler a data de emissão da NFC-e.');
  return `${match[3]}-${match[2]}-${match[1]}T${match[4]}${match[5] ?? '-03:00'}`;
}

/** Parser independente do modelo do Finance; recebe somente campos selecionados do DOM permitido. */
export function parseRjNfceSnapshot(snapshot: RjNfceDomSnapshot): PurchaseInput {
  const supplierName = textValue(snapshot.supplierName);
  const cnpjMatch = snapshot.supplierCnpjText.match(/\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/);
  const supplierCnpj = cnpjMatch?.[0].replace(/\D/g, '') ?? '';
  const accessKey = snapshot.accessKeyText.replace(/\D/g, '');
  const number = readInfoValue(snapshot.generalInfo, 'Número');
  const series = readInfoValue(snapshot.generalInfo, 'Série');
  if (!supplierName) throw badRequest('Não foi possível ler o fornecedor da NFC-e do RJ.');
  if (supplierCnpj.length !== 14) throw badRequest('Não foi possível ler o CNPJ do fornecedor na NFC-e do RJ.');
  if (accessKey.length !== 44) throw badRequest('Não foi possível ler a chave de acesso na NFC-e do RJ.');
  if (!number) throw badRequest('Não foi possível ler o número da NFC-e do RJ.');
  if (!series) throw badRequest('Não foi possível ler a série da NFC-e do RJ.');
  if (snapshot.items.length === 0 || snapshot.items.length > MAX_ITEMS) {
    throw badRequest('A NFC-e não contém uma quantidade válida de itens.');
  }
  const items = snapshot.items.map((item) => ({
    description: textValue(item.description).replace(/\s*\(Código:\s*[^)]*\)/i, ''),
    quantity: parseQuantity(item.quantityText),
    unit: textValue(item.unitText).replace(/^UN\s*:\s*/i, '').slice(0, 20),
    unitPriceCents: moneyToCents(item.unitPriceText, 'preço unitário'),
    discountCents: item.discountText ? moneyToCents(item.discountText, 'desconto') : null,
    totalCents: moneyToCents(item.totalText, 'total do item'),
  }));
  if (items.some((item) => !item.description || !item.unit)) {
    throw badRequest('Um item da NFC-e está sem descrição ou unidade.');
  }
  const totalCents = moneyToCents(snapshot.totalText, 'total a pagar da nota');
  const invoiceDiscountCents = snapshot.discountText
    ? moneyToCents(snapshot.discountText, 'desconto total da nota')
    : 0;
  const grossTotalCents = snapshot.grossTotalText
    ? moneyToCents(snapshot.grossTotalText, 'valor total dos itens da nota')
    : totalCents + invoiceDiscountCents;
  if (
    items.reduce((sum, item) => sum + item.totalCents, 0) !== grossTotalCents ||
    grossTotalCents - invoiceDiscountCents !== totalCents
  ) {
    throw badRequest('Os itens, descontos e total a pagar não conferem com os valores informados pela SEFAZ-RJ.');
  }
  const invoiceNumber = number.replace(/\D/g, '');
  const invoiceSeries = series.replace(/\D/g, '');
  if (!invoiceNumber || !invoiceSeries) throw badRequest('Número ou série da NFC-e inválido.');
  return {
    accessKey,
    supplierName,
    supplierCnpj,
    invoiceNumber,
    series: invoiceSeries,
    issuedAt: parseIssuedAt(snapshot.generalInfo),
    totalCents,
    invoiceDiscountCents,
    paymentMethod: snapshot.paymentMethod ? textValue(snapshot.paymentMethod).slice(0, 100) : null,
    items,
  };
}

async function readRenderedNfce(page: Page): Promise<RjNfceDomSnapshot> {
  return page.evaluate<RjNfceDomSnapshot>(String.raw`(() => {
    const value = (selector, root = document) =>
      root.querySelector(selector)?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
    const info = (heading) => {
      const title = Array.from(document.querySelectorAll('h4.ui-collapsible-heading'))
        .find((candidate) => candidate.textContent?.replace(/click to (?:expand|collapse) contents/gi, '').trim() === heading);
      return title?.parentElement?.querySelector('.ui-collapsible-content')?.textContent ?? '';
    };
    const totalRows = Array.from(document.querySelectorAll('#totalNota > #linhaTotal'));
    const payableRow = totalRows.find((row) => /Valor a pagar/i.test(row.textContent ?? ''));
    const grossTotalRow = totalRows.find((row) => /Valor total/i.test(row.textContent ?? ''));
    const discountRow = totalRows.find((row) => /Descontos?/i.test(row.textContent ?? ''));
    const paymentHeader = document.querySelector('#linhaForma');
    const paymentRow = paymentHeader?.nextElementSibling;
    const paymentMethod = paymentRow?.querySelector('.txtTit, .tx')?.textContent?.trim() ?? null;
    const rows = Array.from(document.querySelectorAll('#tabResult tr'));
    if (rows.length > 300) throw new Error('item-limit');
    const items = rows.map((row) => {
      const left = row.cells[0];
      const right = row.cells[1];
      return {
        description: value('.txtTit', left),
        quantityText: value('.Rqtd', left),
        unitText: value('.RUN', left),
        unitPriceText: value('.RvlUnit', left),
        discountText: value('.RvlDesc', left) || null,
        totalText: value('.valor', right),
      };
    });
    return {
      supplierName: value('.txtTopo', document.querySelector('.txtCenter') ?? document),
      supplierCnpjText: value('.text', document.querySelector('.txtCenter') ?? document),
      generalInfo: info('Informações gerais da Nota'),
      accessKeyText: info('Chave de acesso'),
      grossTotalText: grossTotalRow?.querySelector('.totalNumb')?.textContent ?? null,
      discountText: discountRow?.querySelector('.totalNumb')?.textContent ?? null,
      totalText: payableRow?.querySelector('.totalNumb')?.textContent ??
        grossTotalRow?.querySelector('.totalNumb')?.textContent ?? '',
      paymentMethod,
      items,
    };
  })()`);
}

export async function previewRjNfce(qrUrl: string): Promise<PurchaseInput> {
  const url = validateRjQrUrl(qrUrl);
  return withNfceBrowser({
    state: 'RJ',
    url,
    hosts: [ALLOWED_HOST, ALLOWED_LEGACY_REDIRECTOR_HOST, ALLOWED_SCRIPT_HOST],
    upgradeHttpHosts: [ALLOWED_HOST],
    allowHttpRequest: isAllowedLegacyRjHttpRequest,
    isAllowedRequest: isAllowedBrowserRequest,
    isAllowedFinalUrl: (finalUrl) => finalUrl.protocol === 'https:' && finalUrl.hostname === ALLOWED_HOST,
    onResponse: async (response) => {
      if (response.request().isNavigationRequest()) {
        const error = classifyNfcePortalStatus('RJ', response.status());
        if (error) throw error;
      }
    },
    headersForRequest: (requestUrl, headers) => requestUrl.hostname === ALLOWED_SCRIPT_HOST
      ? withoutReferer(headers)
      : headers,
  }, async (page, setPhase, waitForResponses) => {
    await waitForResponses();
    setPhase('carregar os itens da NFC-e');
    await page.locator('#tabResult tr').first().waitFor({ state: 'attached', timeout: MAX_NFCE_NAVIGATION_MS });
    setPhase('carregar os painéis de identificação da NFC-e');
    await page.locator('h4.ui-collapsible-heading').first().waitFor({ state: 'attached', timeout: MAX_NFCE_NAVIGATION_MS });
    for (const headingText of ['Informações gerais da Nota', 'Chave de acesso']) {
      const heading = page.locator('h4.ui-collapsible-heading').filter({ hasText: headingText }).first();
      const headingClass = await heading.getAttribute('class').catch(() => null);
      if (headingClass?.includes('collapsed')) await heading.click();
      await heading.locator('xpath=..').locator('.ui-collapsible-content').waitFor({ state: 'visible', timeout: 5_000 });
    }
    setPhase('extrair os dados da NFC-e');
    const snapshot = await readRenderedNfce(page);
    setPhase('interpretar os dados extraídos');
    return parseRjNfceSnapshot(snapshot);
  });
}
