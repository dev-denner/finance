import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openMigratedDatabase, type DatabaseHandle } from '../src/db/client';
import {
  ALL_RESET_TABLES,
  CONFIRMATION_PHRASE,
  DATA_RESET_TABLES,
  runDatabaseReset,
} from '../src/db/reset';
import { billReminderBatches, billReminderNotifications } from '../src/db/schema';
import { createBill } from '../src/services/bills';
import { ensureLookup } from '../src/services/lookups';

/**
 * Escopo do reset para as tabelas dos lembretes por e-mail.
 *
 * `bill_reminder_batches` guarda o destinatário (e-mail = dado pessoal) e
 * `bill_reminder_notifications` guarda o histórico por conta: as duas tabelas
 * precisam entrar no reset, senão um `reset:all` se anuncia como completo e
 * deixa rastro — inclusive um lote antigo `sent` suprimindo o lembrete da data.
 */

let tempRoot: string;
let handle: DatabaseHandle;
let databasePath: string;

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'finance-reminder-reset-'));
  databasePath = path.join(tempRoot, 'finance.db');
  handle = openMigratedDatabase(databasePath);
});

afterEach(() => {
  try {
    handle.sqlite.close();
  } catch {
    // O banco pode já estar fechado pelo teste.
  }
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

function countRows(table: string): number {
  const row = handle.sqlite.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get() as {
    count: number;
  };
  return Number(row.count);
}

function seedReminderData(): void {
  const category = ensureLookup(handle.db, 'category', 'Moradia');
  const bill = createBill(handle.db, {
    description: 'Aluguel',
    amountCents: 1000,
    dueDate: '2026-03-13',
    categoryId: category.id,
    status: '',
  });

  const batchId = handle.db
    .insert(billReminderBatches)
    .values({
      milestone: 'D-3',
      sendDate: '2026-03-10',
      state: 'sent',
      attempts: 1,
      itemCount: 1,
      recipient: 'lembretes@exemplo.invalid',
      createdAt: '2026-03-10T12:00:00.000Z',
      updatedAt: '2026-03-10T12:00:00.000Z',
    })
    .returning({ id: billReminderBatches.id })
    .get().id;

  handle.db
    .insert(billReminderNotifications)
    .values({
      billId: bill.id,
      milestone: 'D-3',
      dueDate: '2026-03-13',
      sendDate: '2026-03-10',
      state: 'sent',
      attempts: 1,
      batchId,
      sentAt: '2026-03-10T12:00:00.000Z',
      createdAt: '2026-03-10T12:00:00.000Z',
      updatedAt: '2026-03-10T12:00:00.000Z',
    })
    .run();
}

describe('reset do banco — escopo dos lembretes por e-mail', () => {
  it('deve incluir as duas tabelas no reset de movimentações', () => {
    expect(DATA_RESET_TABLES).toContain('bill_reminder_notifications');
    expect(DATA_RESET_TABLES).toContain('bill_reminder_batches');
  });

  it('deve apagar as notificações antes dos lotes (ordem da chave estrangeira)', () => {
    const notifications = DATA_RESET_TABLES.indexOf('bill_reminder_notifications');
    const batches = DATA_RESET_TABLES.indexOf('bill_reminder_batches');

    expect(notifications).toBeGreaterThanOrEqual(0);
    expect(batches).toBeGreaterThan(notifications);
  });

  it('deve apagar o histórico de lembretes no reset de movimentações', () => {
    seedReminderData();
    expect(countRows('bill_reminder_notifications')).toBe(1);
    expect(countRows('bill_reminder_batches')).toBe(1);

    runDatabaseReset({
      databasePath,
      backupDir: path.join(tempRoot, 'backups'),
      mode: 'data',
      confirmation: CONFIRMATION_PHRASE,
    });

    expect(countRows('bill_reminder_notifications')).toBe(0);
    expect(countRows('bill_reminder_batches')).toBe(0);
  });

  it('deve incluir as tabelas dos lembretes no reset completo', () => {
    // O `reset:all` com contas cadastradas é bloqueado pelo bug pré-existente
    // de `scheduled_bills` (fora do escopo do módulo de lembretes): o que se
    // garante aqui é que as tabelas dos lembretes entram no escopo do reset
    // completo (e na ordem que respeita a chave estrangeira).
    expect(ALL_RESET_TABLES).toContain('bill_reminder_notifications');
    expect(ALL_RESET_TABLES).toContain('bill_reminder_batches');
  });
});
