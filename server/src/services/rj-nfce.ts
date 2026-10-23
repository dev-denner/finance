import { lookup } from 'node:dns/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import net from 'node:net';
import { chromium, type Page } from 'playwright-core';
import { badRequest, HttpError } from '../lib/errors';

const ALLOWED_HOST = 'consultadfe.fazenda.rj.gov.br';
const ALLOWED_LEGACY_REDIRECTOR_HOST = 'www4.fazenda.rj.gov.br';
const ALLOWED_SCRIPT_HOST = 'code.jquery.com';
const ALLOWED_SCRIPT_PATH = '/jquery-1.9.1.js';
const MAX_NAVIGATION_MS = 20_000;
const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
const MAX_REQUESTS = 80;
const MAX_ITEMS = 300;

export interface PurchaseItemInput {
  description: string;
  quantity: string;
  unit: string;
  unitPriceCents: number;
  discountCents: number | null;
  totalCents: number;
}

export interface PurchaseInput {
  accessKey: string;
  supplierName: string;
  supplierCnpj: string;
  invoiceNumber: string;
  series: string;
  issuedAt: string;
  totalCents: number;
  paymentMethod: string | null;
  items: PurchaseItemInput[];
}

interface RjNfceDomSnapshot {
  supplierName: string;
  supplierCnpjText: string;
  generalInfo: string;
  accessKeyText: string;
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

function isPublicIp(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) {
    const octets = address.split('.').map(Number);
    const [a, b] = octets;
    return !(
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19 || b === 51)) ||
      (a === 203 && b === 0) ||
      a >= 224
    );
  }
  if (family === 6) {
    const normalized = address.toLowerCase();
    const firstHextet = Number.parseInt(normalized.split(':')[0] || '0', 16);
    return firstHextet >= 0x2000 && firstHextet <= 0x3fff && !normalized.startsWith('2001:db8:');
  }
  return false;
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
  const validQrPayload = /^\d{44}\|3\|1$/.test(qr) || /^\d{44}\|2\|1\|3\|[a-f\d]{40}$/i.test(qr);
  if (
    (!isCurrentPortal && !isLegacyRedirector) || url.port ||
    url.username || url.password || url.hash || url.pathname !== '/consultaNFCe/QRCode' ||
    params.length !== 1 || params[0]?.[0] !== 'p' || !validQrPayload
  ) {
    throw badRequest('A URL deve ser o QR Code oficial da NFC-e da SEFAZ-RJ.');
  }
  return url;
}

async function assertPublicDestination(hostname: string): Promise<string[]> {
  const records = await lookup(hostname, { all: true, verbatim: true });
  const addresses = records.map((record) => record.address);
  if (!addresses.length || addresses.some((address) => !isPublicIp(address))) {
    throw badRequest('O endereço da SEFAZ-RJ não passou pela validação de segurança.');
  }
  const ipv4 = addresses.filter((address) => net.isIP(address) === 4);
  if (!ipv4.length) throw badRequest('A SEFAZ-RJ não apresentou um endereço compatível com esta instalação.');
  return ipv4;
}

export function isAllowedBrowserRequest(request: { url: string; method: string; resourceType: string }): boolean {
  let requestUrl: URL;
  try {
    requestUrl = new URL(request.url);
  } catch {
    return false;
  }
  if (requestUrl.port || requestUrl.username || requestUrl.password) return false;
  if (requestUrl.hostname === ALLOWED_HOST && requestUrl.protocol === 'https:') return true;
  if (requestUrl.hostname === ALLOWED_LEGACY_REDIRECTOR_HOST) {
    try {
      validateRjQrUrl(requestUrl.toString());
      return request.method === 'GET' && request.resourceType === 'document';
    } catch {
      return false;
    }
  }
  return requestUrl.hostname === ALLOWED_SCRIPT_HOST &&
    requestUrl.pathname === ALLOWED_SCRIPT_PATH && requestUrl.search === '' && requestUrl.hash === '' &&
    request.method === 'GET' && request.resourceType === 'script';
}

export function withoutReferer(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => name.toLowerCase() !== 'referer'));
}

function findBrowserExecutable(): string | undefined {
  const candidates = process.platform === 'win32'
    ? [
        path.join(process.env.PROGRAMFILES ?? 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe'),
        path.join(process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)', 'Google/Chrome/Application/chrome.exe'),
        path.join(process.env.LOCALAPPDATA ?? '', 'Google/Chrome/Application/chrome.exe'),
      ]
    : process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium']
      : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  return candidates.find((candidate) => candidate && existsSync(candidate));
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
  const totalCents = moneyToCents(snapshot.totalText, 'total da nota');
  if (items.reduce((sum, item) => sum + item.totalCents, 0) !== totalCents) {
    throw badRequest('A soma dos itens não confere com o total informado pela SEFAZ-RJ.');
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
    const totalRow = Array.from(document.querySelectorAll('#totalNota > #linhaTotal'))
      .find((row) => /Valor a pagar/i.test(row.textContent ?? ''));
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
      totalText: totalRow?.querySelector('.totalNumb')?.textContent ?? '',
      paymentMethod,
      items,
    };
  })()`);
}

export async function previewRjNfce(qrUrl: string): Promise<PurchaseInput> {
  const url = validateRjQrUrl(qrUrl);
  const addresses = await assertPublicDestination(ALLOWED_HOST);
  const redirectorAddresses = await assertPublicDestination(ALLOWED_LEGACY_REDIRECTOR_HOST);
  const scriptAddresses = await assertPublicDestination(ALLOWED_SCRIPT_HOST);
  const executablePath = findBrowserExecutable();
  if (!executablePath) throw badRequest('Instale o Google Chrome ou Chromium para importar NFC-e.');
  const browser = await chromium.launch({
    headless: false,
    executablePath,
    args: [`--host-resolver-rules=MAP ${ALLOWED_HOST} ${addresses[0]},MAP ${ALLOWED_LEGACY_REDIRECTOR_HOST} ${redirectorAddresses[0]},MAP ${ALLOWED_SCRIPT_HOST} ${scriptAddresses[0]}`],
    timeout: MAX_NAVIGATION_MS,
  });
  let phase = 'abrir a página da consulta';
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    page.setDefaultNavigationTimeout(MAX_NAVIGATION_MS);
    page.setDefaultTimeout(5_000);
    let requestCount = 0;
    await context.route('**/*', async (route) => {
      requestCount += 1;
      let requestUrl: URL;
      try {
        requestUrl = new URL(route.request().url());
      } catch {
        await route.abort();
        return;
      }
      if (requestCount > MAX_REQUESTS || !isAllowedBrowserRequest({
        url: requestUrl.toString(),
        method: route.request().method(),
        resourceType: route.request().resourceType(),
      })) {
        await route.abort();
        return;
      }
      const headers = requestUrl.hostname === ALLOWED_SCRIPT_HOST
        ? withoutReferer(route.request().headers())
        : undefined;
      await route.continue(headers ? { headers } : undefined);
    });
    let responseBytes = 0;
    page.on('response', (response) => {
      const contentLength = Number(response.headers()['content-length'] ?? 0);
      if (Number.isFinite(contentLength)) responseBytes += contentLength;
    });
    phase = 'carregar os itens da NFC-e';
    await page.goto(url.toString(), { waitUntil: 'domcontentloaded' });
    await page.locator('#tabResult tr').first().waitFor({ state: 'attached', timeout: MAX_NAVIGATION_MS });
    phase = 'carregar os painéis de identificação da NFC-e';
    await page.locator('h4.ui-collapsible-heading').first().waitFor({ state: 'attached', timeout: MAX_NAVIGATION_MS });
    for (const headingText of ['Informações gerais da Nota', 'Chave de acesso']) {
      const heading = page.locator('h4.ui-collapsible-heading').filter({ hasText: headingText }).first();
      const headingClass = await heading.getAttribute('class').catch(() => null);
      if (headingClass?.includes('collapsed')) await heading.click();
      await heading.locator('xpath=..').locator('.ui-collapsible-content').waitFor({ state: 'visible', timeout: 5_000 });
    }
    phase = 'validar a resposta do portal';
    if (responseBytes > MAX_DOCUMENT_BYTES) throw badRequest('A resposta da SEFAZ-RJ excedeu o limite de tamanho.');
    const finalUrl = new URL(page.url());
    if (finalUrl.protocol !== 'https:' || finalUrl.hostname !== ALLOWED_HOST) {
      throw badRequest('A consulta da NFC-e foi redirecionada para um endereço não autorizado.');
    }
    const renderedBytes = await page.evaluate(() =>
      new TextEncoder().encode(document.documentElement.outerHTML).byteLength,
    );
    if (renderedBytes > MAX_DOCUMENT_BYTES) throw badRequest('A página renderizada excedeu o limite de tamanho.');
    phase = 'extrair os dados da NFC-e';
    const snapshot = await readRenderedNfce(page);
    phase = 'validar o tamanho dos dados extraídos';
    const extractedBytes = Buffer.byteLength(JSON.stringify(snapshot), 'utf8');
    if (extractedBytes > MAX_DOCUMENT_BYTES) throw badRequest('Os dados extraídos excederam o limite de tamanho.');
    phase = 'interpretar os dados extraídos';
    return parseRjNfceSnapshot(snapshot);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, `Não foi possível ${phase}. Verifique se o portal está disponível e tente novamente.`);
  } finally {
    await browser.close();
  }
}
