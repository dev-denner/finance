import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createDatabase, runMigrations } from './client';

/** Frase exigida no prompt interativo do reset. */
export const CONFIRMATION_PHRASE = 'APAGAR';
/** Frase exigida no prompt interativo da restauração. */
export const RESTORE_CONFIRMATION_PHRASE = 'RESTAURAR';

/**
 * Escopo do reset de movimentações. A ordem respeita as chaves estrangeiras:
 * rejeições e vínculos de transferência antes dos lançamentos, lotes por
 * último. As tabelas dos lembretes entram no fim — as notificações antes dos
 * lotes, porque `bill_reminder_notifications.batch_id` referencia
 * `bill_reminder_batches`.
 */
export const DATA_RESET_TABLES = [
  'purchase_settlements',
  'payment_balance_adjustments',
  'purchase_items',
  'purchases',
  'transfer_rejections',
  'transfers',
  'transactions',
  'import_batches',
  'bill_reminder_notifications',
  'bill_reminder_batches',
] as const;

/** Escopo do reset completo: também apaga categorias e formas de pagamento. */
export const ALL_RESET_TABLES = [...DATA_RESET_TABLES, 'categories', 'payment_methods'] as const;

/** Tabelas que identificam um backup válido do Finance. */
const CORE_TABLES = ['transactions', 'categories', 'payment_methods', 'import_batches'] as const;

export type DatabaseResetMode = 'data' | 'all';

export interface DatabaseResetOptions {
  databasePath: string;
  backupDir: string;
  mode: DatabaseResetMode;
  /** Frase de confirmação; somente a frase exata executa o reset. */
  confirmation: string;
  /** Escape explícito (não recomendado) para ambientes de produção. */
  allowProduction?: boolean;
  /** Ambiente lógico; por padrão lê NODE_ENV (ausente = desenvolvimento). */
  nodeEnv?: string;
}

export interface DatabaseResetSummary {
  databasePath: string;
  backupPath: string;
  mode: DatabaseResetMode;
  deleted: { table: string; count: number }[];
  preserved: { table: string; count: number }[];
}

export interface RestoreBackupOptions {
  databasePath: string;
  backupPath: string;
  backupDir: string;
  confirmation: string;
  allowProduction?: boolean;
  nodeEnv?: string;
}

export interface RestoreBackupSummary {
  databasePath: string;
  backupPath: string;
  /** Backup de segurança do estado anterior, criado antes da restauração. */
  previousBackupPath: string | null;
  /** Cópia bruta do banco substituído, mantida como ponto extra de recuperação. */
  previousPath: string | null;
}

/** Erro lançado quando o reset é bloqueado por política de ambiente ou confirmação. */
export class ResetBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResetBlockedError';
  }
}

/**
 * Bloqueia execução em produção por padrão. NODE_ENV ausente é tratado como
 * desenvolvimento; produção exige a liberação explícita por variável.
 */
export function assertResetAllowed(nodeEnv?: string, allowProduction = false): void {
  const env = (nodeEnv ?? process.env.NODE_ENV ?? 'development').toLowerCase();
  if (env === 'production' && !allowProduction) {
    throw new ResetBlockedError(
      'Reset bloqueado: ambiente de produção. Defina DATABASE_RESET_ALLOW_PRODUCTION=true para liberar explicitamente.',
    );
  }
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/**
 * Cria um snapshot consistente com `VACUUM INTO` (inclui dados ainda no WAL).
 * O arquivo é novo por definição: backups existentes nunca são sobrescritos.
 */
export function createBackupSnapshot(databasePath: string, backupDir: string, label: string): string {
  if (databasePath !== ':memory:' && !fs.existsSync(databasePath)) {
    throw new Error(`Banco não encontrado em ${databasePath}.`);
  }

  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = timestamp();
  let targetPath = path.join(backupDir, `finance-${label}-${stamp}.db`);
  let suffix = 1;
  while (fs.existsSync(targetPath)) {
    suffix += 1;
    if (suffix > 100) {
      throw new Error(`Não foi possível gerar um nome único de backup em ${backupDir}.`);
    }
    targetPath = path.join(backupDir, `finance-${label}-${stamp}-${suffix}.db`);
  }

  const handle = createDatabase(databasePath);
  try {
    handle.sqlite.prepare('VACUUM INTO ?').run(targetPath);
  } finally {
    handle.sqlite.close();
  }
  return targetPath;
}

/** Conta registros das tabelas informadas (identificadores vêm de lista fixa). */
export function collectCounts(
  sqlite: Database.Database,
  tables: readonly string[],
): { table: string; count: number }[] {
  return tables.map((table) => {
    const row = sqlite.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get() as { count: number };
    return { table, count: Number(row.count) };
  });
}

/**
 * Executa as exclusões dentro de uma transação, na ordem das chaves
 * estrangeiras. Retorna a contagem real apagada por tabela.
 */
export function performReset(
  sqlite: Database.Database,
  mode: DatabaseResetMode,
): { table: string; count: number }[] {
  const tables = mode === 'all' ? ALL_RESET_TABLES : DATA_RESET_TABLES;
  const counts = collectCounts(sqlite, tables);

  sqlite.pragma('foreign_keys = ON');
  sqlite.exec('BEGIN IMMEDIATE');
  try {
    for (const { table } of counts) {
      sqlite.prepare(`DELETE FROM "${table}"`).run();
    }
    sqlite.exec('COMMIT');
  } catch (error) {
    sqlite.exec('ROLLBACK');
    throw error;
  }
  return counts;
}

/** Verifica integridade física e de chaves estrangeiras após a operação. */
export function verifyIntegrity(sqlite: Database.Database): void {
  const integrity = sqlite.pragma('integrity_check', { simple: true });
  if (integrity !== 'ok') {
    throw new Error(`Verificação de integridade falhou: ${String(integrity)}`);
  }
  const fkIssues = sqlite.pragma('foreign_key_check') as unknown[];
  if (fkIssues.length > 0) {
    throw new Error(`Verificação de chaves estrangeiras falhou: ${fkIssues.length} violação(ões).`);
  }
}

/**
 * Orquestra o reset: valida ambiente e confirmação, cria backup, apaga em
 * transação, verifica integridade e reaplica migrações oficiais (no-op quando
 * o histórico já está atualizado, preservando-o).
 */
export function runDatabaseReset(options: DatabaseResetOptions): DatabaseResetSummary {
  if (options.databasePath === ':memory:') {
    throw new Error('Reset não suporta banco em memória; informe um caminho de arquivo.');
  }

  assertResetAllowed(options.nodeEnv, options.allowProduction);

  if (options.confirmation !== CONFIRMATION_PHRASE) {
    throw new ResetBlockedError(
      `Confirmação inválida. Digite ${CONFIRMATION_PHRASE} para executar o reset; qualquer outro valor cancela.`,
    );
  }

  // Backup antes de qualquer alteração; falha na criação aborta o procedimento.
  const backupPath = createBackupSnapshot(options.databasePath, options.backupDir, `reset-${options.mode}`);

  const handle = createDatabase(options.databasePath);
  try {
    handle.sqlite.pragma('busy_timeout = 5000');
    const deleted = performReset(handle.sqlite, options.mode);
    verifyIntegrity(handle.sqlite);
    runMigrations(handle);

    const preservedTables = options.mode === 'data' ? ['categories', 'payment_methods'] : [];
    return {
      databasePath: options.databasePath,
      backupPath,
      mode: options.mode,
      deleted,
      preserved: collectCounts(handle.sqlite, preservedTables),
    };
  } finally {
    handle.sqlite.close();
  }
}

/** Abre o backup somente leitura e confere integridade e tabelas essenciais. */
export function validateBackupFile(backupPath: string): void {
  const sqlite = new Database(backupPath, { readonly: true, fileMustExist: true });
  try {
    const integrity = sqlite.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok') {
      throw new Error(`Backup corrompido (${backupPath}): integridade reportou ${String(integrity)}.`);
    }
    const rows = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
      name: string;
    }[];
    const present = new Set(rows.map((row) => row.name));
    for (const table of CORE_TABLES) {
      if (!present.has(table)) {
        throw new Error(`Backup inválido (${backupPath}): tabela essencial "${table}" ausente.`);
      }
    }
  } finally {
    sqlite.close();
  }
}

function discardDatabaseFiles(databasePath: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    const file = databasePath + suffix;
    if (fs.existsSync(file)) {
      fs.rmSync(file, { force: true });
    }
  }
}

function rollbackSwap(databasePath: string, previousPath: string): void {
  discardDatabaseFiles(databasePath);
  fs.renameSync(previousPath, databasePath);
  for (const suffix of ['-wal', '-shm']) {
    const sidecar = previousPath + suffix;
    if (fs.existsSync(sidecar)) {
      fs.renameSync(sidecar, databasePath + suffix);
    }
  }
}

/**
 * Substitui o banco atual pelo backup. O banco anterior (e sidecars WAL/SHM)
 * é renomeado para `*.pre-restore-<data>` e devolvido ao lugar se a validação
 * do banco restaurado falhar. Requer o aplicativo parado.
 */
function swapDatabaseFiles(databasePath: string, backupPath: string): string | null {
  const dir = path.dirname(databasePath);
  const base = path.basename(databasePath);
  const previousPath = path.join(dir, `${base}.pre-restore-${timestamp()}`);

  let renamed = false;
  if (fs.existsSync(databasePath)) {
    fs.renameSync(databasePath, previousPath);
    renamed = true;
    for (const suffix of ['-wal', '-shm']) {
      const sidecar = databasePath + suffix;
      if (fs.existsSync(sidecar)) {
        fs.renameSync(sidecar, previousPath + suffix);
      }
    }
  }

  try {
    fs.copyFileSync(backupPath, databasePath);
  } catch (error) {
    if (renamed) {
      rollbackSwap(databasePath, previousPath);
    }
    throw error;
  }
  return renamed ? previousPath : null;
}

/**
 * Restaura um backup: valida o arquivo, cria backup de segurança do estado
 * atual, substitui os arquivos e confirma que o banco abre, migra e passa na
 * verificação de integridade.
 */
export function restoreDatabaseBackup(options: RestoreBackupOptions): RestoreBackupSummary {
  assertResetAllowed(options.nodeEnv, options.allowProduction);

  if (options.confirmation !== RESTORE_CONFIRMATION_PHRASE) {
    throw new ResetBlockedError(
      `Confirmação inválida. Digite ${RESTORE_CONFIRMATION_PHRASE} para restaurar; qualquer outro valor cancela.`,
    );
  }

  const databasePath = path.resolve(options.databasePath);
  const backupPath = path.resolve(options.backupPath);
  if (!fs.existsSync(backupPath) || !fs.statSync(backupPath).isFile()) {
    throw new Error(`Backup não encontrado em ${backupPath}.`);
  }
  validateBackupFile(backupPath);

  // Segurança extra: snapshot do estado atual antes de sobrescrever.
  const previousBackupPath = fs.existsSync(databasePath)
    ? createBackupSnapshot(databasePath, options.backupDir, 'pre-restore')
    : null;

  const previousPath = swapDatabaseFiles(databasePath, backupPath);
  const handle = createDatabase(databasePath);
  try {
    runMigrations(handle);
    verifyIntegrity(handle.sqlite);
  } catch (error) {
    handle.sqlite.close();
    if (previousPath) {
      rollbackSwap(databasePath, previousPath);
    } else {
      discardDatabaseFiles(databasePath);
    }
    throw error;
  }
  handle.sqlite.close();

  return { databasePath, backupPath, previousBackupPath, previousPath };
}
