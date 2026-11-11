import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, runMigrations, type DatabaseHandle } from '../src/db/client';

const realMigrations = path.resolve(__dirname, '../drizzle');
const LEGACY_TAG = '0014_wakeful_killer_shrike';

let tempRoot: string;

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'finance-bills-migration-'));
});

afterEach(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

/** Pasta de migrações truncada no último estado anterior ao Módulo 1 novo. */
function legacyMigrationsFolder(): string {
  const folder = path.join(tempRoot, 'drizzle');
  fs.mkdirSync(path.join(folder, 'meta'), { recursive: true });
  const journal = JSON.parse(
    fs.readFileSync(path.join(realMigrations, 'meta/_journal.json'), 'utf8'),
  ) as { entries: { tag: string }[] };
  const index = journal.entries.findIndex((entry) => entry.tag === LEGACY_TAG);
  expect(index).toBeGreaterThan(0);
  const entries = journal.entries.slice(0, index + 1);
  for (const entry of entries) {
    fs.copyFileSync(
      path.join(realMigrations, `${entry.tag}.sql`),
      path.join(folder, `${entry.tag}.sql`),
    );
  }
  fs.writeFileSync(
    path.join(folder, 'meta/_journal.json'),
    JSON.stringify({ ...journal, entries }, null, 2),
  );
  return folder;
}

function openLegacyDatabase(): DatabaseHandle {
  const handle = createDatabase(':memory:');
  migrate(handle.db, { migrationsFolder: legacyMigrationsFolder() });
  return handle;
}

describe('migração 0015 — contas a pagar (AC12)', () => {
  it('converte status legado em state/datas e preserva as linhas', () => {
    const handle = openLegacyDatabase();
    const { sqlite } = handle;
    try {
      const columns = sqlite.prepare('PRAGMA table_info(scheduled_bills)').all() as { name: string }[];
      expect(columns.map((c) => c.name)).toContain('status');
      expect(columns.map((c) => c.name)).not.toContain('state');

      sqlite
        .prepare("INSERT INTO categories (name, normalized_name) VALUES ('Moradia', 'moradia')")
        .run();
      const insert = sqlite.prepare(
        'INSERT INTO scheduled_bills (description, amount_cents, due_date, status, category_id, repeated_from_id) VALUES (?, ?, ?, ?, 1, ?)',
      );
      insert.run('Aberta', 1000, '2026-10-05', '', null);
      insert.run('Agendada', 2000, '2026-10-10', 'AG', null);
      const paid = insert.run('Paga', 3000, '2026-10-15', 'PG', null);
      insert.run('Repetida', 3000, '2026-11-15', '', Number(paid.lastInsertRowid));
      // Lembretes já existentes referenciam a conta e precisam sobreviver ao rebuild.
      const batch = sqlite
        .prepare("INSERT INTO bill_reminder_batches (milestone, send_date, state, recipient) VALUES ('d-3', '2026-10-02', 'sent', 'eu@example.com')")
        .run();
      sqlite
        .prepare("INSERT INTO bill_reminder_notifications (bill_id, milestone, due_date, send_date, state, batch_id) VALUES (1, 'd-3', '2026-10-05', '2026-10-02', 'sent', ?)")
        .run(Number(batch.lastInsertRowid));
      sqlite
        .prepare("INSERT INTO bill_reminder_notifications (bill_id, milestone, due_date, send_date, state) VALUES (2, 'd-1', '2026-10-10', '2026-10-09', 'pending')")
        .run();

      runMigrations(handle);

      const notifications = sqlite
        .prepare('SELECT bill_id, milestone, state, batch_id FROM bill_reminder_notifications ORDER BY id')
        .all();
      expect(notifications).toEqual([
        { bill_id: 1, milestone: 'd-3', state: 'sent', batch_id: Number(batch.lastInsertRowid) },
        { bill_id: 2, milestone: 'd-1', state: 'pending', batch_id: null },
      ]);

      const after = sqlite.prepare('PRAGMA table_info(scheduled_bills)').all() as { name: string }[];
      expect(after.map((c) => c.name)).not.toContain('status');
      expect(after.map((c) => c.name)).toEqual(
        expect.arrayContaining(['state', 'scheduled_for', 'paid_at', 'paid_cents', 'template_id', 'sequence']),
      );

      const rows = sqlite
        .prepare(
          'SELECT description, state, scheduled_for, paid_at, paid_cents, migrated_payment, repeated_from_id FROM scheduled_bills ORDER BY id',
        )
        .all() as Record<string, unknown>[];
      expect(rows).toHaveLength(4);
      expect(rows[0]).toMatchObject({ state: 'open', scheduled_for: null, paid_at: null, paid_cents: null, migrated_payment: 0 });
      expect(rows[1]).toMatchObject({ state: 'open', scheduled_for: '2026-10-10', paid_at: null, migrated_payment: 0 });
      expect(rows[2]).toMatchObject({ state: 'paid', paid_at: '2026-10-15', paid_cents: 3000, migrated_payment: 1 });
      expect(rows[3]).toMatchObject({ state: 'open', repeated_from_id: Number(paid.lastInsertRowid) });

      expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect((sqlite.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check).toBe('ok');

      const tables = (sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as { name: string }[]).map((t) => t.name);
      expect(tables).toEqual(expect.arrayContaining(['bill_templates', 'bill_payments', 'scheduled_bills']));
      expect(tables).not.toContain('__new_scheduled_bills');
      expect(tables).not.toContain('__scheduled_bills_repeat_backup');
      expect(tables).not.toContain('__bill_reminder_notifications_backup');
    } finally {
      sqlite.close();
    }
  });

  it('novos checks: state, paid consistente e sequence positiva', () => {
    const handle = createDatabase(':memory:');
    runMigrations(handle);
    const { sqlite } = handle;
    try {
      sqlite.prepare("INSERT INTO categories (name, normalized_name) VALUES ('Moradia', 'moradia')").run();
      const insert = (state: string, paidAt: string | null, paidCents: number | null, sequence: number | null) =>
        sqlite
          .prepare(
            'INSERT INTO scheduled_bills (description, amount_cents, due_date, state, paid_at, paid_cents, sequence, category_id) VALUES (?, 100, ?, ?, ?, ?, ?, 1)',
          )
          .run('X', '2026-10-10', state, paidAt, paidCents, sequence);
      expect(() => insert('PG', null, null, null)).toThrow();
      expect(() => insert('paid', null, null, null)).toThrow();
      expect(() => insert('paid', '2026-10-10', 0, null)).toThrow();
      expect(() => insert('open', null, null, 0)).toThrow();
      expect(() => insert('paid', '2026-10-10', 100, null)).not.toThrow();
      expect(() => insert('open', null, null, null)).not.toThrow();
    } finally {
      sqlite.close();
    }
  });
});
