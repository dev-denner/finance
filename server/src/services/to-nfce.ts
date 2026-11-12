import type { Page } from 'playwright-core';
import { badRequest } from '../lib/errors';
import { MAX_NFCE_DOCUMENT_BYTES, MAX_NFCE_NAVIGATION_MS, withNfceBrowser, type BrowserRequest } from './nfce-browser';
import type { PurchaseInput } from './purchase-input';

const ALLOWED_HOST = 'www.sefaz.to.gov.br';
const ALLOWED_PATHS = new Set(['/nfce/qrcode', '/nfce', '/nfce/']);

export interface ToNfceParseArgs {
  xml: string;
  expectedAccessKey: string;
}

export interface ToNfceParseResult {
  purchase?: PurchaseInput;
  error?: 'xml-invalid' | 'invoice-mismatch' | 'missing-fields' | 'invalid-items' | 'total-mismatch';
}

function validAccessKey(key: string): boolean {
  if (!/^17\d{4}\d{14}65\d{22}$/.test(key)) return false;
  const digits = [...key.slice(0, 43)].map(Number);
  let weight = 2;
  let sum = 0;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    sum += (digits[index] ?? 0) * weight;
    weight = weight === 9 ? 2 : weight + 1;
  }
  const remainder = sum % 11;
  return (remainder < 2 ? 0 : 11 - remainder) === Number(key[43]);
}

export function validateToQrUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw badRequest('Informe uma URL válida de consulta NFC-e da SEFAZ-TO.');
  }
  const params = [...url.searchParams.entries()];
  const parts = (url.searchParams.get('p') ?? '').split('|');
  const accessKey = parts[0] ?? '';
  const validPayload = parts.length === 5 && /^\d{44}$/.test(accessKey) && validAccessKey(accessKey) &&
    parts[1] === '2' && (parts[2] === '1' || parts[2] === '2') &&
    /^[1-9]\d{0,5}$/.test(parts[3] ?? '') && /^[a-f\d]{40}$/i.test(parts[4] ?? '');
  if (
    !['http:', 'https:'].includes(url.protocol) || url.hostname !== ALLOWED_HOST || url.port ||
    url.username || url.password || url.hash || url.pathname !== '/nfce/qrcode' ||
    params.length !== 1 || params[0]?.[0] !== 'p' || !validPayload
  ) {
    throw badRequest('A URL deve ser um QR Code válido da NFC-e da SEFAZ-TO.');
  }
  // O próprio portal começa em HTTP e redireciona para HTTPS; nunca navegamos
  // ou enviamos dados pelo protocolo inseguro.
  url.protocol = 'https:';
  return url;
}

export function isAllowedToBrowserRequest(request: BrowserRequest): boolean {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.hostname !== ALLOWED_HOST || url.port || url.username || url.password) return false;
  if (request.resourceType === 'document') {
    if (request.method !== 'GET') return false;
    if (url.pathname === '/nfce/qrcode') {
      try {
        validateToQrUrl(url.toString());
        return true;
      } catch {
        return false;
      }
    }
    return url.pathname === '/nfce' || url.pathname === '/nfce/';
  }
  if (url.pathname === '/nfce/api/nfe') return request.method === 'POST' && ['fetch', 'xhr'].includes(request.resourceType);
  return request.method === 'GET' && ['script', 'stylesheet', 'image', 'font', 'fetch', 'xhr'].includes(request.resourceType) &&
    (url.pathname.startsWith('/nfce/_next/') || url.pathname.startsWith('/nfce/'));
}

export function isAllowedToFinalUrl(url: URL): boolean {
  return url.protocol === 'https:' && url.hostname === ALLOWED_HOST && !url.port &&
    !url.username && !url.password && ALLOWED_PATHS.has(url.pathname);
}

/** Extrai somente os campos necessários do XML que o portal já carregou no navegador. */
export function parseToNfceXml(xml: string, Parser: typeof DOMParser, expectedAccessKey: string): ToNfceParseResult {
  const maxDocumentSize = 2 * 1024 * 1024;
  const maxItems = 300;
  if (xml.length === 0 || xml.length > maxDocumentSize || /<!DOCTYPE|<!ENTITY/i.test(xml)) return { error: 'xml-invalid' };
  const document = new Parser().parseFromString(xml, 'application/xml');
  if (document.getElementsByTagName('parsererror').length > 0) return { error: 'xml-invalid' };
  const all = (root: Document | Element, localName: string): Element[] => Array.from(root.getElementsByTagNameNS('*', localName));
  const first = (root: Document | Element, localName: string): Element | null => all(root, localName)[0] ?? null;
  const text = (root: Document | Element | null, localName: string): string => first(root ?? document, localName)?.textContent?.trim() ?? '';
  const infNfe = first(document, 'infNFe');
  const ide = first(infNfe ?? document, 'ide');
  const emit = first(infNfe ?? document, 'emit');
  const totals = first(first(infNfe ?? document, 'total') ?? document, 'ICMSTot');
  const prot = first(first(document, 'protNFe') ?? document, 'infProt');
  const xmlAccessKey = text(prot ?? document, 'chNFe') || (infNfe?.getAttribute('Id') ?? '').replace(/^NFe/, '');
  const supplierName = text(emit ?? document, 'xNome');
  const supplierCnpj = text(emit ?? document, 'CNPJ').replace(/\D/g, '');
  const invoiceNumber = text(ide ?? document, 'nNF').replace(/\D/g, '');
  const series = text(ide ?? document, 'serie').replace(/\D/g, '');
  const model = text(ide ?? document, 'mod');
  const issuedAt = text(ide ?? document, 'dhEmi') || text(ide ?? document, 'dEmi');
  const accessKeyValid = (key: string): boolean => {
    if (!/^17\d{4}\d{14}65\d{22}$/.test(key)) return false;
    const digits = [...key.slice(0, 43)].map(Number);
    let weight = 2;
    let sum = 0;
    for (let index = digits.length - 1; index >= 0; index -= 1) {
      sum += (digits[index] ?? 0) * weight;
      weight = weight === 9 ? 2 : weight + 1;
    }
    const remainder = sum % 11;
    return (remainder < 2 ? 0 : 11 - remainder) === Number(key[43]);
  };
  if (
    !accessKeyValid(expectedAccessKey) || !accessKeyValid(xmlAccessKey) || xmlAccessKey !== expectedAccessKey || model !== '65' || expectedAccessKey.slice(6, 20) !== supplierCnpj || !supplierName || supplierCnpj.length !== 14 ||
    !invoiceNumber || !series || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)?$/.test(issuedAt) ||
    !Number.isFinite(Date.parse(issuedAt)) || Number(invoiceNumber) !== Number(expectedAccessKey.slice(25, 34)) ||
    Number(series) !== Number(expectedAccessKey.slice(22, 25))
  ) return { error: 'invoice-mismatch' };

  const parseCents = (value: string): number | null => {
    const match = value.trim().match(/^(\d{1,15})(?:\.(\d+))?$/);
    if (!match) return null;
    try {
      const fraction = (match[2] ?? '').padEnd(3, '0');
      let cents = BigInt(match[1] ?? '0') * 100n + BigInt(fraction.slice(0, 2));
      if (Number(fraction[2] ?? '0') >= 5) cents += 1n;
      const result = Number(cents);
      return Number.isSafeInteger(result) ? result : null;
    } catch {
      return null;
    }
  };
  const totalCents = parseCents(text(totals ?? document, 'vNF'));
  const invoiceDiscountCents = parseCents(text(totals ?? document, 'vDesc'));
  const grossProductsCents = parseCents(text(totals ?? document, 'vProd'));
  const detRows = all(infNfe ?? document, 'det');
  if (totalCents === null || invoiceDiscountCents === null || grossProductsCents === null || detRows.length === 0 || detRows.length > maxItems) {
    return { error: 'missing-fields' };
  }
  const paymentCodes = all(first(infNfe ?? document, 'pag') ?? document, 'tPag').map((node) => node.textContent?.trim() ?? '').filter(Boolean);
  const paymentLabels: Record<string, string> = {
    '01': 'Dinheiro', '02': 'Cheque', '03': 'Cartão de crédito', '04': 'Cartão de débito',
    '10': 'Vale-alimentação', '11': 'Vale-refeição', '12': 'Vale-presente', '13': 'Vale-combustível',
    '15': 'Boleto', '16': 'Depósito bancário', '17': 'Pix', '18': 'Transferência',
    '19': 'Programa de fidelidade', '90': 'Sem pagamento', '99': 'Outros',
  };
  const paymentMethods = [...new Set(paymentCodes.map((code) => paymentLabels[code] ?? 'Outros'))];
  const items = detRows.map((det) => {
    const product = first(det, 'prod');
    const description = text(product ?? det, 'xProd').slice(0, 500);
    const quantityRaw = text(product ?? det, 'qCom');
    const quantity = quantityRaw.replace(',', '.');
    const unit = text(product ?? det, 'uCom').slice(0, 20);
    const unitPriceCents = parseCents(text(product ?? det, 'vUnCom'));
    const totalItemCents = parseCents(text(product ?? det, 'vProd'));
    const discountText = text(product ?? det, 'vDesc');
    const discountCents = discountText ? parseCents(discountText) : null;
    if (!description || !/^\d+(?:\.\d+)?$/.test(quantity) || Number(quantity) <= 0 || !unit || unitPriceCents === null || totalItemCents === null || (discountText && discountCents === null)) return null;
    return { description, quantity, unit, unitPriceCents, discountCents: discountCents && discountCents > 0 ? discountCents : null, totalCents: totalItemCents };
  });
  if (items.some((item) => item === null)) return { error: 'invalid-items' };
  const normalizedItems = items as NonNullable<(typeof items)[number]>[];
  const itemGrossTotal = normalizedItems.reduce((sum, item) => sum + item.totalCents, 0);
  if (!Number.isSafeInteger(itemGrossTotal) || itemGrossTotal !== grossProductsCents) return { error: 'total-mismatch' };
  return {
    purchase: {
      accessKey: expectedAccessKey,
      supplierName: supplierName.slice(0, 200),
      supplierCnpj,
      invoiceNumber,
      series,
      issuedAt: issuedAt.length === 10 ? `${issuedAt}T00:00:00Z` : issuedAt,
      totalCents,
      invoiceDiscountCents,
      paymentMethod: paymentMethods.length > 1 ? 'Pagamento misto' : paymentMethods[0] ?? null,
      items: normalizedItems,
    },
  };
}

export async function previewToNfce(qrUrl: string): Promise<PurchaseInput> {
  const url = validateToQrUrl(qrUrl);
  const expectedAccessKey = url.searchParams.get('p')?.split('|')[0] ?? '';
  let xml: string | undefined;
  return withNfceBrowser({
    state: 'TO',
    url,
    hosts: [ALLOWED_HOST],
    upgradeHttpHosts: [ALLOWED_HOST],
    isAllowedRequest: isAllowedToBrowserRequest,
    isAllowedFinalUrl: isAllowedToFinalUrl,
    onResponse: async (response) => {
      const responseUrl = new URL(response.url());
      if (responseUrl.pathname !== '/nfce/api/nfe' || response.request().method() !== 'POST') return;
      if (!response.ok()) throw badRequest('A consulta XML da SEFAZ-TO não foi concluída.');
      const payload = await response.json() as { xml?: unknown };
      if (typeof payload.xml !== 'string' || Buffer.byteLength(payload.xml, 'utf8') > MAX_NFCE_DOCUMENT_BYTES) {
        throw badRequest('A resposta fiscal da SEFAZ-TO excedeu o limite permitido.');
      }
      xml = payload.xml;
    },
  }, async (page, setPhase, waitForResponses) => {
    setPhase('consultar a NFC-e de TO no navegador');
    await page.locator('table tr th').first().waitFor({ state: 'attached', timeout: MAX_NFCE_NAVIGATION_MS });
    await page.locator('table tbody tr').first().waitFor({ state: 'attached', timeout: MAX_NFCE_NAVIGATION_MS });
    await waitForResponses();
    if (!xml) throw badRequest('O portal da SEFAZ-TO não retornou o documento fiscal para consulta.');
    const renderedItems = await page.locator('table tbody tr').count();
    setPhase('interpretar o documento fiscal de TO');
    const parserArgs = JSON.stringify({ xml, expectedAccessKey });
    const parserExpression = `(() => { const __name = (fn) => fn; const args = ${parserArgs}; try { return (${parseToNfceXml.toString()})(args.xml, DOMParser, args.expectedAccessKey); } catch { return { error: 'xml-invalid' }; } })()`;
    const result = await page.evaluate<ToNfceParseResult>(parserExpression);
    if (!result.purchase) {
      const messages: Record<NonNullable<ToNfceParseResult['error']>, string> = {
        'xml-invalid': 'O portal da SEFAZ-TO retornou um documento fiscal inválido.',
        'invoice-mismatch': 'Os dados do portal da SEFAZ-TO não conferem com a chave do QR Code.',
        'missing-fields': 'O documento da SEFAZ-TO não contém os campos necessários para importar a compra.',
        'invalid-items': 'O documento da SEFAZ-TO contém um item inválido.',
        'total-mismatch': 'Os itens do documento da SEFAZ-TO não conferem com o total de produtos.',
      };
      throw badRequest(messages[result.error ?? 'xml-invalid']);
    }
    if (renderedItems !== result.purchase.items.length) throw badRequest('Os itens exibidos pelo portal da SEFAZ-TO não conferem com o documento fiscal.');
    return result.purchase;
  });
}
