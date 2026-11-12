import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { HttpError } from '../lib/errors';
import type { NfceState } from './nfce-browser';

export const NFCE_QUERY_WINDOW_MS = 24 * 60 * 60 * 1000;
export const NFCE_QUERY_MIN_INTERVAL_MS = 30 * 1000;
export const NFCE_QUERY_MAX_ATTEMPTS = 10;
export const RJ_PORTAL_PAUSE_MS = 72 * 60 * 60 * 1000;

interface AttemptRecord {
  state: NfceState;
  at: number;
}

interface GuardState {
  version: 1;
  attempts: AttemptRecord[];
  rjPausedUntil: number | null;
}

const EMPTY_STATE: GuardState = { version: 1, attempts: [], rjPausedUntil: null };
const DEFAULT_STATE_FILE = path.resolve(__dirname, '../../data/nfce-query-guard.json');

export class NfceQueryStopError extends HttpError {
  constructor(status: number, message: string) {
    super(status, message);
  }
}

export class NfceQueryGuardError extends NfceQueryStopError {
  constructor(message: string) {
    super(429, message);
    this.name = 'NfceQueryGuardError';
  }
}

export class NfcePortalPausedError extends NfceQueryGuardError {
  constructor(remainingMs: number) {
    super(`Consultas à SEFAZ-RJ pausadas por bloqueio do portal. Tente novamente em aproximadamente ${formatDuration(remainingMs)}.`);
    this.name = 'NfcePortalPausedError';
  }
}

export class NfceQueryPersistenceError extends NfceQueryStopError {
  constructor() {
    super(503, 'O controle local de consultas não está disponível. O Finance bloqueou novas consultas por segurança. Verifique o armazenamento local antes de tentar novamente.');
    this.name = 'NfceQueryPersistenceError';
  }
}

function formatDuration(milliseconds: number): string {
  const totalMinutes = Math.max(1, Math.ceil(milliseconds / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes} minuto(s)`;
  if (minutes === 0) return `${hours} hora(s)`;
  return `${hours} hora(s) e ${minutes} minuto(s)`;
}

function isState(value: unknown): value is NfceState {
  return value === 'RJ' || value === 'SP' || value === 'TO';
}

function parseState(value: unknown): GuardState {
  if (!value || typeof value !== 'object') throw new Error('invalid-state');
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || !Array.isArray(record.attempts)) throw new Error('invalid-state');
  const attempts: AttemptRecord[] = record.attempts.map((attempt) => {
    if (!attempt || typeof attempt !== 'object') throw new Error('invalid-state');
    const item = attempt as Record<string, unknown>;
    if (!isState(item.state) || !Number.isSafeInteger(item.at) || (item.at as number) < 0) {
      throw new Error('invalid-state');
    }
    return { state: item.state, at: item.at as number };
  });
  if (record.rjPausedUntil !== null && (!Number.isSafeInteger(record.rjPausedUntil) || (record.rjPausedUntil as number) < 0)) {
    throw new Error('invalid-state');
  }
  return {
    version: 1,
    attempts,
    rjPausedUntil: record.rjPausedUntil as number | null,
  };
}

export class NfceQueryGuard {
  private emergencyRjPausedUntil: number | null = null;

  constructor(private readonly stateFile = DEFAULT_STATE_FILE) {}

  private read(): GuardState {
    try {
      return parseState(JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...EMPTY_STATE, attempts: [] };
      throw new NfceQueryPersistenceError();
    }
  }

  private write(state: GuardState): void {
    const directory = path.dirname(this.stateFile);
    let temporaryFile: string | null = null;
    try {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      temporaryFile = path.join(directory, `.nfce-query-guard-${process.pid}-${randomUUID()}.tmp`);
      const descriptor = fs.openSync(temporaryFile, 'wx', 0o600);
      try {
        fs.writeFileSync(descriptor, JSON.stringify(state), { encoding: 'utf8' });
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
      fs.renameSync(temporaryFile, this.stateFile);
      fs.chmodSync(this.stateFile, 0o600);
    } catch {
      if (temporaryFile) {
        try {
          fs.unlinkSync(temporaryFile);
        } catch (cleanupError) {
          if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw new NfceQueryPersistenceError();
          }
        }
      }
      throw new NfceQueryPersistenceError();
    }
  }

  beginAttempt(state: NfceState, now = Date.now()): void {
    const current = this.read();
    const rjPausedUntil = Math.max(current.rjPausedUntil ?? 0, this.emergencyRjPausedUntil ?? 0);
    if (state === 'RJ' && rjPausedUntil > now) {
      throw new NfcePortalPausedError(rjPausedUntil - now);
    }

    const recent = current.attempts.filter((attempt) => now - attempt.at < NFCE_QUERY_WINDOW_MS);
    const sameState = recent.filter((attempt) => attempt.state === state).sort((left, right) => right.at - left.at);
    const last = sameState[0];
    if (last && now - last.at < NFCE_QUERY_MIN_INTERVAL_MS) {
      throw new NfceQueryGuardError(`Aguarde aproximadamente ${Math.ceil((NFCE_QUERY_MIN_INTERVAL_MS - (now - last.at)) / 1000)} segundo(s) antes da próxima consulta à SEFAZ-${state}.`);
    }
    if (sameState.length >= NFCE_QUERY_MAX_ATTEMPTS) {
      const oldest = sameState[sameState.length - 1];
      const remaining = oldest ? oldest.at + NFCE_QUERY_WINDOW_MS - now : NFCE_QUERY_WINDOW_MS;
      throw new NfceQueryGuardError(`Limite local de ${NFCE_QUERY_MAX_ATTEMPTS} consultas à SEFAZ-${state} em 24 horas atingido. Tente novamente em aproximadamente ${formatDuration(remaining)}.`);
    }

    this.write({
      version: 1,
      attempts: [...recent, { state, at: now }],
      rjPausedUntil: current.rjPausedUntil,
    });
  }

  pauseRjAfterPortalBlock(now = Date.now()): void {
    this.emergencyRjPausedUntil = now + RJ_PORTAL_PAUSE_MS;
    const current = this.read();
    this.write({ ...current, rjPausedUntil: this.emergencyRjPausedUntil });
  }
}

export function isNfceQueryStopError(error: unknown): error is NfceQueryStopError {
  return error instanceof NfceQueryStopError;
}
