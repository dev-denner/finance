import { lookup } from 'node:dns/promises';
import { existsSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { chromium, type Page, type Response as PlaywrightResponse, type Route } from 'playwright-core';
import { badRequest, HttpError } from '../lib/errors';

export const MAX_NFCE_NAVIGATION_MS = 20_000;
export const MAX_NFCE_DOCUMENT_BYTES = 2 * 1024 * 1024;
export const MAX_NFCE_REQUESTS = 80;

export type NfceState = 'RJ' | 'SP' | 'TO';

const ACCESS_BLOCKED_MESSAGE =
  'A SEFAZ-RJ bloqueou a consulta por reputação do IP de origem. O Finance interrompeu o lote para evitar novas tentativas. Aguarde ou consulte a SEFAZ por um canal oficial antes de tentar novamente.';

export class NfcePortalAccessBlockedError extends HttpError {
  constructor() {
    super(503, ACCESS_BLOCKED_MESSAGE);
    this.name = 'NfcePortalAccessBlockedError';
  }
}

/** Reconhece apenas o aviso público de bloqueio da SEFAZ-RJ, sem guardar seu HTML. */
export function isNfcePortalAccessBlocked(state: NfceState, pageText: string): boolean {
  if (state !== 'RJ') return false;
  const normalized = pageText.normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
  return normalized.includes('bloqueia acessos provenientes desses enderecos ip') ||
    normalized.includes('endereco ip atual esteja listado em uma dessas bases de dados');
}

export interface BrowserRequest {
  url: string;
  method: string;
  resourceType: string;
}

export interface NfceBrowserPolicy {
  state: NfceState;
  url: URL;
  hosts: string[];
  isAllowedRequest: (request: BrowserRequest) => boolean;
  isAllowedFinalUrl: (url: URL) => boolean;
  allowHttpRequest?: (request: BrowserRequest) => boolean;
  upgradeHttpHosts?: string[];
  onResponse?: (response: PlaywrightResponse) => Promise<void>;
  headersForRequest?: (requestUrl: URL, headers: Record<string, string>) => Record<string, string>;
}

function ipv6Value(address: string): bigint | null {
  const normalized = address.toLowerCase();
  if (net.isIP(normalized) !== 6) return null;
  const halves = normalized.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if ([...left, ...right].some((part) => !/^[\da-f]{1,4}$/.test(part))) return null;
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const parts = [...left, ...Array.from({ length: missing }, () => '0'), ...right];
  return parts.reduce((value, part) => (value << 16n) | BigInt(`0x${part}`), 0n);
}

function ipv6InCidr(value: bigint, network: bigint, prefix: number): boolean {
  const shift = BigInt(128 - prefix);
  return (value >> shift) === (network >> shift);
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
      (a === 192 && b === 88 && octets[2] === 99) ||
      a >= 224
    );
  }
  if (family === 6) {
    const value = ipv6Value(address);
    if (value === null || (value >> 125n) !== 1n) return false;
    const reserved = [
      ['2000::', 16], // IETF protocol assignments
      ['2001::', 23], // special protocol assignments
      ['2001:db8::', 32], // documentation
      ['2001:2::', 48], // benchmarking
      ['2002::', 16], // deprecated 6to4
      ['3fff::', 20], // documentation
    ] as const;
    return !reserved.some(([network, prefix]) => {
      const networkValue = ipv6Value(network);
      return networkValue !== null && ipv6InCidr(value, networkValue, prefix);
    });
  }
  return false;
}

export interface NfceDnsRecord {
  address: string;
  family: number;
}

/** Valida todas as respostas DNS e prefere IPv6 global, com fallback IPv4. */
export function selectPublicAddress(records: NfceDnsRecord[], state: NfceState): string {
  const addresses = records.map((record) => record.address);
  if (!addresses.length || addresses.some((address) => !isPublicIp(address))) {
    throw badRequest(`O endereço da SEFAZ-${state} não passou pela validação de segurança.`);
  }
  const ipv6 = addresses.find((address) => net.isIP(address) === 6);
  if (ipv6) return ipv6;
  const ipv4 = addresses.find((address) => net.isIP(address) === 4);
  if (!ipv4) throw badRequest(`A SEFAZ-${state} não apresentou um endereço compatível com esta instalação.`);
  return ipv4;
}

export function formatHostResolverRule(host: string, address: string): string {
  return `MAP ${host} ${net.isIP(address) === 6 ? `[${address}]` : address}`;
}

export function shouldUpgradeHttpRedirect(url: URL, officialHosts: string[]): boolean {
  return url.protocol === 'http:' && officialHosts.includes(url.hostname);
}

export function isAllowedBrowserRequestProtocol(
  request: BrowserRequest,
  allowHttpRequest?: (request: BrowserRequest) => boolean,
): boolean {
  try {
    const protocol = new URL(request.url).protocol;
    return protocol === 'https:' || (protocol === 'http:' && allowHttpRequest?.(request) === true);
  } catch {
    return false;
  }
}

async function resolvePublicAddress(hostname: string, state: NfceState): Promise<string> {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return selectPublicAddress(records, state);
}

export function classifyNfcePortalStatus(state: NfceState, status: number): HttpError | null {
  if (status < 500) return null;
  return new HttpError(503, `A SEFAZ-${state} respondeu com indisponibilidade temporária (HTTP ${status}). Tente novamente mais tarde.`);
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

async function abort(route: Route): Promise<void> {
  await route.abort();
}

/** Navega em Chromium com DNS pinning, política por requisição e limites comuns. */
export async function withNfceBrowser<T>(
  policy: NfceBrowserPolicy,
  readPage: (page: Page, setPhase: (phase: string) => void, waitForResponses: () => Promise<void>) => Promise<T>,
): Promise<T> {
  const addresses = await Promise.all(policy.hosts.map((host) => resolvePublicAddress(host, policy.state)));
  const executablePath = findBrowserExecutable();
  if (!executablePath) throw badRequest('Instale o Google Chrome ou Chromium para importar NFC-e.');
  const hostRules = policy.hosts.map((host, index) => formatHostResolverRule(host, addresses[index] ?? '')).join(',');
  const browser = await chromium.launch({
    headless: true,
    executablePath,
    args: [`--host-resolver-rules=${hostRules}`],
    timeout: MAX_NFCE_NAVIGATION_MS,
  });
  let phase = 'abrir a página da consulta';
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    page.setDefaultNavigationTimeout(MAX_NFCE_NAVIGATION_MS);
    page.setDefaultTimeout(5_000);
    let requestCount = 0;
    const pendingResponseHandlers: Promise<void>[] = [];
    let responseHandlerError: unknown;
    await context.route('**/*', async (route) => {
      requestCount += 1;
      let requestUrl: URL;
      try {
        requestUrl = new URL(route.request().url());
      } catch {
        await abort(route);
        return;
      }
      const shouldUpgrade = shouldUpgradeHttpRedirect(requestUrl, policy.upgradeHttpHosts ?? []);
      if (shouldUpgrade) requestUrl.protocol = 'https:';
      const browserRequest = {
        url: requestUrl.toString(),
        method: route.request().method(),
        resourceType: route.request().resourceType(),
      };
      if (
        requestCount > MAX_NFCE_REQUESTS || !isAllowedBrowserRequestProtocol(browserRequest, policy.allowHttpRequest) || requestUrl.port ||
        requestUrl.username || requestUrl.password ||
        !policy.isAllowedRequest(browserRequest)
      ) {
        await abort(route);
        return;
      }
      const headers = policy.headersForRequest?.(requestUrl, route.request().headers());
      await route.continue(shouldUpgrade ? { url: requestUrl.toString(), ...(headers ? { headers } : {}) } : headers ? { headers } : undefined);
    });
    let responseBytes = 0;
    page.on('response', (response) => {
      const contentLength = Number(response.headers()['content-length'] ?? 0);
      if (Number.isFinite(contentLength)) responseBytes += contentLength;
      if (policy.onResponse) {
        pendingResponseHandlers.push(policy.onResponse(response).catch((error: unknown) => {
          responseHandlerError ??= error;
        }));
      }
    });
    const waitForResponses = async () => {
      while (pendingResponseHandlers.length > 0) await Promise.all(pendingResponseHandlers.splice(0));
      if (responseHandlerError) throw responseHandlerError;
    };
    await page.goto(policy.url.toString(), { waitUntil: 'domcontentloaded' });
    phase = 'validar a resposta do portal';
    const finalUrl = new URL(page.url());
    if (!policy.isAllowedFinalUrl(finalUrl)) {
      throw badRequest(`A consulta da NFC-e foi redirecionada para um endereço não autorizado.`);
    }
    const initialPageText = await page.evaluate(() => document.body?.innerText ?? '');
    if (isNfcePortalAccessBlocked(policy.state, initialPageText)) {
      throw new NfcePortalAccessBlockedError();
    }
    if (responseBytes > MAX_NFCE_DOCUMENT_BYTES) {
      throw badRequest(`A resposta da SEFAZ-${policy.state} excedeu o limite de tamanho.`);
    }
    const initialRenderedBytes = await page.evaluate(() =>
      new TextEncoder().encode(document.documentElement.outerHTML).byteLength,
    );
    if (initialRenderedBytes > MAX_NFCE_DOCUMENT_BYTES) {
      throw badRequest('A página renderizada excedeu o limite de tamanho.');
    }
    const result = await readPage(page, (nextPhase) => { phase = nextPhase; }, waitForResponses);
    if (responseBytes > MAX_NFCE_DOCUMENT_BYTES) {
      throw badRequest(`A resposta da SEFAZ-${policy.state} excedeu o limite de tamanho.`);
    }
    const renderedBytes = await page.evaluate(() =>
      new TextEncoder().encode(document.documentElement.outerHTML).byteLength,
    );
    if (renderedBytes > MAX_NFCE_DOCUMENT_BYTES) {
      throw badRequest('A página renderizada excedeu o limite de tamanho.');
    }
    const extractedBytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
    if (extractedBytes > MAX_NFCE_DOCUMENT_BYTES) {
      throw badRequest('Os dados extraídos excederam o limite de tamanho.');
    }
    return result;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, `Não foi possível ${phase}. Verifique se o portal está disponível e tente novamente.`);
  } finally {
    await browser.close();
  }
}
