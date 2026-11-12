import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NfcePortalAccessBlockedError } from '../src/services/nfce-browser';
import { previewNfceWithState } from '../src/services/nfce-adapters';
import {
  NfcePortalPausedError,
  NfceQueryGuard,
  NfceQueryGuardError,
  NfceQueryPersistenceError,
  NFCE_QUERY_MAX_ATTEMPTS,
  NFCE_QUERY_MIN_INTERVAL_MS,
  NFCE_QUERY_WINDOW_MS,
  RJ_PORTAL_PAUSE_MS,
} from '../src/services/nfce-query-guard';

const tempDirs: string[] = [];

function makeGuard(): { guard: NfceQueryGuard; directory: string; file: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'finance-nfce-guard-'));
  tempDirs.push(directory);
  const file = path.join(directory, 'guard.json');
  return { guard: new NfceQueryGuard(file), directory, file };
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('limites locais de consulta NFC-e', () => {
  it('impõe o intervalo mínimo e persiste as tentativas ao recriar o guard', () => {
    const { guard, file } = makeGuard();
    const start = 1_800_000_000_000;
    guard.beginAttempt('RJ', start);
    expect(() => new NfceQueryGuard(file).beginAttempt('RJ', start + NFCE_QUERY_MIN_INTERVAL_MS - 1))
      .toThrow(NfceQueryGuardError);
    new NfceQueryGuard(file).beginAttempt('RJ', start + NFCE_QUERY_MIN_INTERVAL_MS);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(file, 'utf8')).not.toMatch(/https?:|accessKey|html|cnpj/i);
  });

  it('limita a dez tentativas por UF na janela móvel de 24 horas', () => {
    const { guard } = makeGuard();
    const start = 1_800_000_000_000;
    for (let index = 0; index < NFCE_QUERY_MAX_ATTEMPTS; index += 1) {
      guard.beginAttempt('SP', start + index * NFCE_QUERY_MIN_INTERVAL_MS);
    }
    expect(() => guard.beginAttempt('SP', start + NFCE_QUERY_MAX_ATTEMPTS * NFCE_QUERY_MIN_INTERVAL_MS))
      .toThrow(/Limite local de 10 consultas à SEFAZ-SP em 24 horas/);
    expect(() => guard.beginAttempt('SP', start + NFCE_QUERY_WINDOW_MS)).not.toThrow();
    expect(() => guard.beginAttempt('TO', start + NFCE_QUERY_WINDOW_MS)).not.toThrow();
  });

  it('falha de forma fechada quando o estado local está ilegível', () => {
    const { guard, file } = makeGuard();
    fs.writeFileSync(file, '{inválido');
    expect(() => guard.beginAttempt('RJ')).toThrow(NfceQueryPersistenceError);
  });

  it('não consulta o adaptador quando não consegue ler o arquivo de controle', async () => {
    const { directory } = makeGuard();
    const guard = new NfceQueryGuard(directory);
    const preview = vi.fn(async () => { throw new Error('not expected'); });
    const url = `https://consultadfe.fazenda.rj.gov.br/consultaNFCe/QRCode?p=${'8'.repeat(44)}%7C3%7C1`;
    await expect(previewNfceWithState(url, { guard, preview })).rejects.toThrow(NfceQueryPersistenceError);
    expect(preview).not.toHaveBeenCalled();
  });

  it('persiste pausa de 72 horas após bloqueio RJ e mantém SP/TO independentes', async () => {
    const { guard, file } = makeGuard();
    const url = `http://www4.fazenda.rj.gov.br/consultaNFCe/QRCode?p=${'9'.repeat(44)}%7C2%7C1%7C3%7C${'a'.repeat(40)}`;
    const preview = vi.fn(async () => { throw new NfcePortalAccessBlockedError(); });
    await expect(previewNfceWithState(url, { guard, preview })).rejects.toThrow(NfcePortalAccessBlockedError);

    const persisted = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      version: number;
      attempts: { state: string; at: number }[];
      rjPausedUntil: number;
    };
    expect(persisted.attempts).toHaveLength(1);
    expect(persisted.attempts[0]).toMatchObject({ state: 'RJ', at: expect.any(Number) });
    expect(persisted.rjPausedUntil - Date.now()).toBeGreaterThan(RJ_PORTAL_PAUSE_MS - 1000);
    expect(fs.readFileSync(file, 'utf8')).not.toMatch(/www4|accessKey|\b9{44}\b|html/i);
    const nextPreview = vi.fn(async () => { throw new Error('not expected'); });
    await expect(previewNfceWithState(url, { guard: new NfceQueryGuard(file), preview: nextPreview }))
      .rejects.toThrow(NfcePortalPausedError);
    expect(nextPreview).not.toHaveBeenCalled();

    const independentGuard = new NfceQueryGuard(file);
    expect(() => independentGuard.beginAttempt('SP')).not.toThrow();
    expect(() => independentGuard.beginAttempt('TO')).not.toThrow();
  });
});
