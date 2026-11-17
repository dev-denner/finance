import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase } from '../src/db/client';

const realMigrations = path.resolve(__dirname, '../drizzle');
const BEFORE_TAG = '0015_bill_templates_and_payments';

let tempRoot: string;

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'finance-purchases-migration-'));
});

afterEach(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

/** Pasta de migrações truncada na última migração anterior à 0016. */
function migrationsUntil(tag: string): string {
  const folder = path.join(tempRoot, 'drizzle');
  fs.mkdirSync(path.join(folder, 'meta'), { recursive: true });
  const journal = JSON.parse(fs.readFileSync(path.join(realMigrations, 'meta/_journal.json'), 'utf8')) as { entries: { tag: string }[] };
  const index = journal.entries.findIndex((entry) => entry.tag === tag);
  expect(index).toBeGreaterThan(0);
  const entries = journal.entries.slice(0, index + 1);
  for (const entry of entries) {
    fs.copyFileSync(path.join(realMigrations, `${entry.tag}.sql`), path.join(folder, `${entry.tag}.sql`));
  }
  fs.writeFileSync(path.join(folder, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }, null, 2));
  return folder;
}

const rows = (sqlite: ReturnType<typeof createDatabase>['sqlite'], table: string) =>
  sqlite.prepare(`SELECT * FROM ${table} ORDER BY id`).all();

describe('migração 0016 — remove purchases.transaction_id (R4)', () => {
  it('remove a coluna e o índice único sem perder itens, liquidações nem ajustes da compra', () => {
    const handle = createDatabase(':memory:');
    const { sqlite } = handle;
    try {
      migrate(handle.db, { migrationsFolder: migrationsUntil(BEFORE_TAG) });
      const card = sqlite.prepare("INSERT INTO payment_methods (name, normalized_name, balance_type) VALUES ('Cartão', 'cartao', 'credit')").run().lastInsertRowid;
      const wallet = sqlite.prepare("INSERT INTO payment_methods (name, normalized_name, balance_type) VALUES ('Carteira', 'carteira', 'wallet')").run().lastInsertRowid;
      const category = sqlite.prepare("INSERT INTO categories (name, normalized_name) VALUES ('Mercado', 'mercado')").run().lastInsertRowid;
      const movement = sqlite.prepare("INSERT INTO transactions (purchase_date, due_date, description, amount_cents, payment_method_id, category_id) VALUES ('2026-10-20', '2026-10-20', 'Compra', -3000, ?, ?)").run(card, category).lastInsertRowid;
      const purchase = sqlite.prepare("INSERT INTO purchases (access_key, supplier_name, supplier_cnpj, invoice_number, series, issued_at, total_cents, category_id, transaction_id, reconciled_at) VALUES (?, 'Fornecedor', '12345678000195', '1', '1', '2026-10-20T10:00:00Z', 5000, ?, ?, '2026-10-21T10:00:00Z')").run('7'.repeat(44), category, movement).lastInsertRowid;
      sqlite.prepare("INSERT INTO purchases (access_key, supplier_name, supplier_cnpj, invoice_number, series, issued_at, total_cents) VALUES (?, 'Outro', '12345678000195', '2', '1', '2026-10-22T10:00:00Z', 900)").run('8'.repeat(44));
      const insertItem = sqlite.prepare("INSERT INTO purchase_items (purchase_id, position, description, quantity, unit, unit_price_cents, total_cents, category_id) VALUES (?, ?, ?, '1', 'UN', ?, ?, ?)");
      insertItem.run(purchase, 1, 'Arroz', 3000, 3000, category);
      insertItem.run(purchase, 2, 'Sabonete', 2000, 2000, null);
      sqlite.prepare("INSERT INTO purchase_settlements (purchase_id, transaction_id, payment_method_id, amount_cents, settlement_type, effective_date) VALUES (?, ?, ?, 3000, 'movement', '2026-10-20')").run(purchase, movement, card);
      sqlite.prepare("INSERT INTO purchase_settlements (purchase_id, transaction_id, payment_method_id, amount_cents, settlement_type, effective_date) VALUES (?, NULL, ?, 2000, 'wallet', '2026-10-20')").run(purchase, wallet);
      sqlite.prepare("INSERT INTO payment_balance_adjustments (payment_method_id, effective_date, amount_cents, reason, description, purchase_id) VALUES (?, '2026-10-19', 2000, 'opening_balance', 'Saldo inicial', ?)").run(wallet, purchase);
      sqlite.prepare("INSERT INTO payment_balance_adjustments (payment_method_id, effective_date, amount_cents, reason, description) VALUES (?, '2026-10-01', 500, 'bonus', 'Bônus avulso')").run(wallet);

      const before = Object.fromEntries(['purchase_items', 'purchase_settlements', 'payment_balance_adjustments'].map((table) => [table, rows(sqlite, table)]));
      const purchasesBefore = sqlite.prepare('SELECT id, access_key, category_id, reconciled_at FROM purchases ORDER BY id').all();

      migrate(handle.db, { migrationsFolder: realMigrations });

      const columns = (sqlite.prepare('PRAGMA table_info(purchases)').all() as { name: string }[]).map((column) => column.name);
      expect(columns).not.toContain('transaction_id');
      const indexes = (sqlite.prepare('PRAGMA index_list(purchases)').all() as { name: string }[]).map((index) => index.name);
      expect(indexes).not.toContain('purchases_transaction_id_uq');
      expect(indexes).toEqual(expect.arrayContaining(['purchases_access_key_uq', 'purchases_issued_at_idx']));

      expect(sqlite.prepare('SELECT id, access_key, category_id, reconciled_at FROM purchases ORDER BY id').all()).toEqual(purchasesBefore);
      for (const [table, expected] of Object.entries(before)) expect(rows(sqlite, table)).toEqual(expected);
      const leftovers = (sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[])
        .map((table) => table.name).filter((name) => name.startsWith('__') && name !== '__drizzle_migrations');
      expect(leftovers).toEqual([]);
      expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);

      // As chaves dos filhos apontam para a tabela nova: excluir a compra ainda cascateia.
      sqlite.prepare('DELETE FROM payment_balance_adjustments WHERE purchase_id = ?').run(purchase);
      sqlite.prepare('DELETE FROM purchases WHERE id = ?').run(purchase);
      expect(sqlite.prepare('SELECT COUNT(*) AS n FROM purchase_items').get()).toEqual({ n: 0 });
      expect(sqlite.prepare('SELECT COUNT(*) AS n FROM purchase_settlements').get()).toEqual({ n: 0 });
    } finally {
      sqlite.close();
    }
  });
});
