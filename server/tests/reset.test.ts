import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { openMigratedDatabase, type DatabaseHandle } from '../src/db/client';
import {
  CONFIRMATION_PHRASE,
  RESTORE_CONFIRMATION_PHRASE,
  ResetBlockedError,
  createBackupSnapshot,
  restoreDatabaseBackup,
  runDatabaseReset,
} from '../src/db/reset';
import { seedTransaction } from './helpers';

let tempRoot: string;

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'finance-reset-test-'));
});

afterEach(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

function createTempDatabase(): { handle: DatabaseHandle; databasePath: string } {
  const databasePath = path.join(tempRoot, 'finance.db');
  const handle = openMigratedDatabase(databasePath);
  return { handle, databasePath };
}

function countRows(sqlite: Database.Database, table: string): number {
  return Number(sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count ?? 0);
}

function seedOperationalData(handle: DatabaseHandle): void {
  seedTransaction(handle.db, {
    description: 'Saída para conciliar',
    amount: '-R$ 100,00',
    dueDate: '2026-01-05',
    category: 'Transferência',
    payment: 'Conta A',
  });
  seedTransaction(handle.db, {
    description: 'Entrada conciliada',
    amount: 'R$ 100,00',
    dueDate: '2026-01-05',
    category: 'Transferência',
    payment: 'Conta B',
  });

  const rows = handle.sqlite.prepare('SELECT id FROM transactions ORDER BY id').all() as {
    id: number;
  }[];
  const [outgoing, incoming] = rows;

  handle.sqlite
    .prepare(
      "INSERT INTO transfers (outgoing_transaction_id, incoming_transaction_id, confidence, origin) VALUES (?, ?, 'manual', 'manual')",
    )
    .run(outgoing.id, incoming.id);
  handle.sqlite
    .prepare(
      "INSERT INTO transfer_rejections (outgoing_transaction_id, incoming_transaction_id, signature) VALUES (?, ?, 'assinatura-teste')",
    )
    .run(incoming.id, outgoing.id);
  handle.sqlite
    .prepare(
      "INSERT INTO import_batches (filename, total_rows, imported_rows, rejected_rows) VALUES ('arquivo.csv', 10, 8, 2)",
    )
    .run();
}

describe('procedimento de reset do banco', () => {
  it('reset de movimentações apaga lançamentos e preserva categorias e formas de pagamento', () => {
    const { handle, databasePath } = createTempDatabase();
    try {
      seedOperationalData(handle);
      const backupDir = path.join(tempRoot, 'backups');

      const summary = runDatabaseReset({
        databasePath,
        backupDir,
        mode: 'data',
        confirmation: CONFIRMATION_PHRASE,
      });

      expect(countRows(handle.sqlite, 'transactions')).toBe(0);
      expect(countRows(handle.sqlite, 'transfers')).toBe(0);
      expect(countRows(handle.sqlite, 'transfer_rejections')).toBe(0);
      expect(countRows(handle.sqlite, 'import_batches')).toBe(0);
      expect(countRows(handle.sqlite, 'categories')).toBeGreaterThan(0);
      expect(countRows(handle.sqlite, 'payment_methods')).toBeGreaterThan(0);
      expect(summary.deleted.find((entry) => entry.table === 'transactions')?.count).toBe(2);
      expect(summary.preserved.every((entry) => entry.count > 0)).toBe(true);
      expect(fs.existsSync(summary.backupPath)).toBe(true);
      // Histórico de migrações preservado pela operação.
      expect(countRows(handle.sqlite, '__drizzle_migrations')).toBeGreaterThan(0);
    } finally {
      handle.sqlite.close();
    }
  });

  it('reset completo limpa também cadastros, preservando o schema e as migrações', () => {
    const { handle, databasePath } = createTempDatabase();
    try {
      seedOperationalData(handle);
      const backupDir = path.join(tempRoot, 'backups');

      runDatabaseReset({
        databasePath,
        backupDir,
        mode: 'all',
        confirmation: CONFIRMATION_PHRASE,
      });

      for (const table of [
        'transactions',
        'transfers',
        'transfer_rejections',
        'import_batches',
        'categories',
        'payment_methods',
      ]) {
        expect(countRows(handle.sqlite, table)).toBe(0);
      }

      const tables = handle.sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as { name: string }[];
      const names = tables.map((row) => row.name);
      expect(names).toContain('transactions');
      expect(names).toContain('categories');
      expect(countRows(handle.sqlite, '__drizzle_migrations')).toBeGreaterThan(0);
    } finally {
      handle.sqlite.close();
    }
  });

  it('aplicação inicia e responde normalmente após o reset', async () => {
    const { handle, databasePath } = createTempDatabase();
    try {
      seedOperationalData(handle);
      runDatabaseReset({
        databasePath,
        backupDir: path.join(tempRoot, 'backups'),
        mode: 'data',
        confirmation: CONFIRMATION_PHRASE,
      });

      const app = await buildApp({ db: handle.db, logger: false });
      try {
        const response = await app.inject({ method: 'GET', url: '/api/transactions' });
        expect(response.statusCode).toBe(200);
      } finally {
        await app.close();
      }
    } finally {
      handle.sqlite.close();
    }
  });

  it('confirmação inválida cancela sem alterar dados e sem criar backup', () => {
    const { handle, databasePath } = createTempDatabase();
    try {
      seedOperationalData(handle);
      const backupDir = path.join(tempRoot, 'backups');

      expect(() =>
        runDatabaseReset({ databasePath, backupDir, mode: 'data', confirmation: 'sim' }),
      ).toThrow(ResetBlockedError);

      expect(countRows(handle.sqlite, 'transactions')).toBe(2);
      expect(countRows(handle.sqlite, 'transfers')).toBe(1);
      expect(fs.existsSync(backupDir)).toBe(false);
    } finally {
      handle.sqlite.close();
    }
  });

  it('falha na criação do backup aborta sem alterar dados', () => {
    const { handle, databasePath } = createTempDatabase();
    try {
      seedOperationalData(handle);
      // Um arquivo no lugar do diretório de backups impede a criação do backup.
      const backupDir = path.join(tempRoot, 'backups');
      fs.writeFileSync(backupDir, 'bloqueio');

      expect(() =>
        runDatabaseReset({ databasePath, backupDir, mode: 'data', confirmation: CONFIRMATION_PHRASE }),
      ).toThrow();

      expect(countRows(handle.sqlite, 'transactions')).toBe(2);
      expect(countRows(handle.sqlite, 'transfers')).toBe(1);
    } finally {
      handle.sqlite.close();
    }
  });

  it('bloqueia execução em ambiente de produção por padrão', () => {
    const { handle, databasePath } = createTempDatabase();
    try {
      seedOperationalData(handle);

      expect(() =>
        runDatabaseReset({
          databasePath,
          backupDir: path.join(tempRoot, 'backups'),
          mode: 'data',
          confirmation: CONFIRMATION_PHRASE,
          nodeEnv: 'production',
        }),
      ).toThrow(ResetBlockedError);

      expect(countRows(handle.sqlite, 'transactions')).toBe(2);
    } finally {
      handle.sqlite.close();
    }
  });

  it('restauração devolve o estado capturado no backup', () => {
    const { handle, databasePath } = createTempDatabase();
    const backupDir = path.join(tempRoot, 'backups');
    seedOperationalData(handle);
    const backupPath = createBackupSnapshot(databasePath, backupDir, 'teste');
    handle.sqlite.close(); // libera o arquivo para a troca em disco

    runDatabaseReset({
      databasePath,
      backupDir,
      mode: 'all',
      confirmation: CONFIRMATION_PHRASE,
    });

    const summary = restoreDatabaseBackup({
      databasePath,
      backupPath,
      backupDir,
      confirmation: RESTORE_CONFIRMATION_PHRASE,
    });

    const reopened = openMigratedDatabase(databasePath);
    try {
      expect(countRows(reopened.sqlite, 'transactions')).toBe(2);
      expect(countRows(reopened.sqlite, 'categories')).toBeGreaterThan(0);
      expect(countRows(reopened.sqlite, 'payment_methods')).toBeGreaterThan(0);
      expect(fs.existsSync(summary.previousBackupPath ?? '')).toBe(true);
    } finally {
      reopened.sqlite.close();
    }
  });

  it('restauração rejeita arquivo que não é um backup válido', () => {
    const { handle, databasePath } = createTempDatabase();
    try {
      seedOperationalData(handle);
      const fakeBackup = path.join(tempRoot, 'falso.db');
      fs.writeFileSync(fakeBackup, 'isto não é um banco sqlite');

      expect(() =>
        restoreDatabaseBackup({
          databasePath,
          backupPath: fakeBackup,
          backupDir: path.join(tempRoot, 'backups'),
          confirmation: RESTORE_CONFIRMATION_PHRASE,
        }),
      ).toThrow();

      expect(countRows(handle.sqlite, 'transactions')).toBe(2);
    } finally {
      handle.sqlite.close();
    }
  });
});
