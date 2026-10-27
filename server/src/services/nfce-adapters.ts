import { randomUUID } from 'node:crypto';
import { badRequest } from '../lib/errors';
import type { NfceState } from './nfce-browser';
import type { PurchaseInput } from './purchase-input';
import { NfcePortalAccessBlockedError } from './nfce-browser';
import { importPurchase, findPurchaseByAccessKey } from './purchases';
import type { AppDatabase } from '../db/client';
import { NfceQueryGuard } from './nfce-query-guard';
import { previewRjNfce, validateRjQrUrl } from './rj-nfce';
import { previewSpNfce, validateSpQrUrl } from './sp-nfce';
import { previewToNfce, validateToQrUrl } from './to-nfce';

export type { NfceState } from './nfce-browser';

export interface ValidatedNfceUrl {
  state: NfceState;
  url: URL;
}

export interface NfceQueryDependencies {
  guard?: Pick<NfceQueryGuard, 'beginAttempt' | 'pauseRjAfterPortalBlock'>;
  preview?: (state: NfceState, url: URL) => Promise<PurchaseInput>;
}

export interface NfcePurchasePreview {
  state: NfceState;
  previewToken: string | null;
  purchase: PurchaseInput | null;
  alreadyImported: boolean;
  existingPurchaseId: number | null;
}

const queryGuard = new NfceQueryGuard();
const PREVIEW_TOKEN_TTL_MS = 10 * 60 * 1000;
const MAX_PREVIEW_TOKENS = 100;
const pendingPreviews = new Map<string, { purchase: PurchaseInput; expiresAt: number }>();

function issuePreviewToken(purchase: PurchaseInput): string {
  const now = Date.now();
  for (const [token, entry] of pendingPreviews) if (entry.expiresAt <= now) pendingPreviews.delete(token);
  while (pendingPreviews.size >= MAX_PREVIEW_TOKENS) {
    const oldest = pendingPreviews.keys().next().value as string | undefined;
    if (!oldest) break;
    pendingPreviews.delete(oldest);
  }
  const token = randomUUID();
  pendingPreviews.set(token, { purchase, expiresAt: now + PREVIEW_TOKEN_TTL_MS });
  return token;
}

export function accessKeyFromNfceQrUrl(url: URL): string {
  return (url.searchParams.get('p') ?? '').slice(0, 44);
}

export function validateNfceQrUrl(input: string): ValidatedNfceUrl {
  let hostname: string;
  try {
    hostname = new URL(input).hostname;
  } catch {
    throw badRequest('Informe uma URL válida de consulta NFC-e.');
  }
  if (hostname === 'www.sefaz.to.gov.br') {
    return { state: 'TO', url: validateToQrUrl(input) };
  }
  if (hostname === 'www.nfce.fazenda.sp.gov.br') {
    return { state: 'SP', url: validateSpQrUrl(input) };
  }
  if (hostname === 'consultadfe.fazenda.rj.gov.br' || hostname === 'www4.fazenda.rj.gov.br') {
    return { state: 'RJ', url: validateRjQrUrl(input) };
  }
  throw badRequest('A URL deve ser um QR Code oficial suportado da SEFAZ.');
}

async function queryValidatedNfce(validated: ValidatedNfceUrl, deps: NfceQueryDependencies = {}): Promise<PurchaseInput> {
  const guard = deps.guard ?? queryGuard;
  guard.beginAttempt(validated.state);
  try {
    if (deps.preview) return await deps.preview(validated.state, validated.url);
    const preview = validated.state === 'SP' ? previewSpNfce : validated.state === 'TO' ? previewToNfce : previewRjNfce;
    return await preview(validated.url.toString());
  } catch (error) {
    if (validated.state === 'RJ' && error instanceof NfcePortalAccessBlockedError) {
      guard.pauseRjAfterPortalBlock();
    }
    throw error;
  }
}

export async function previewNfceWithState(
  input: string,
  deps: NfceQueryDependencies = {},
): Promise<{ state: NfceState; purchase: PurchaseInput }> {
  const validated = validateNfceQrUrl(input);
  const purchase = await queryValidatedNfce(validated, deps);
  return { state: validated.state, purchase };
}

export async function previewNfce(input: string, deps: NfceQueryDependencies = {}): Promise<PurchaseInput> {
  return (await previewNfceWithState(input, deps)).purchase;
}

export async function previewNfceForPurchase(
  db: AppDatabase,
  input: string,
  deps: NfceQueryDependencies = {},
): Promise<NfcePurchasePreview> {
  const validated = validateNfceQrUrl(input);
  const accessKey = accessKeyFromNfceQrUrl(validated.url);
  const existingBeforeQuery = findPurchaseByAccessKey(db, accessKey);
  if (existingBeforeQuery !== null) {
    return { state: validated.state, previewToken: null, purchase: null, alreadyImported: true, existingPurchaseId: existingBeforeQuery };
  }

  const purchase = await queryValidatedNfce(validated, deps);
  if (purchase.accessKey !== accessKey) throw badRequest('A chave retornada pela consulta NFC-e não confere com o QR Code.');
  const existingAfterQuery = findPurchaseByAccessKey(db, accessKey);
  if (existingAfterQuery !== null) {
    return { state: validated.state, previewToken: null, purchase: null, alreadyImported: true, existingPurchaseId: existingAfterQuery };
  }
  return { state: validated.state, previewToken: issuePreviewToken(purchase), purchase, alreadyImported: false, existingPurchaseId: null };
}

export function importPreviewedNfceForPurchase(db: AppDatabase, token: string): { id: number; duplicate: boolean } {
  const entry = pendingPreviews.get(token);
  pendingPreviews.delete(token);
  if (!entry || entry.expiresAt <= Date.now()) throw badRequest('A prévia expirou. Consulte o QR Code novamente.');
  return importPurchase(db, entry.purchase);
}

export async function importNfceForPurchase(
  db: AppDatabase,
  input: string,
  deps: NfceQueryDependencies = {},
): Promise<{ id: number; duplicate: boolean }> {
  const validated = validateNfceQrUrl(input);
  const accessKey = accessKeyFromNfceQrUrl(validated.url);
  const existingId = findPurchaseByAccessKey(db, accessKey);
  if (existingId !== null) return { id: existingId, duplicate: true };
  const purchase = await queryValidatedNfce(validated, deps);
  if (purchase.accessKey !== accessKey) throw badRequest('A chave retornada pela consulta NFC-e não confere com o QR Code.');
  return importPurchase(db, purchase);
}
