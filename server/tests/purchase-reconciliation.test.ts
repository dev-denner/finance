import { bulkUpdateTransactions, deleteTransaction, updateTransaction } from "../src/services/transactions";
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { createDatabase } from '../src/db/client';
import { createTestDatabase, seedTransaction } from './helpers';
import { ensureLookup } from '../src/services/lookups';
import { getPurchase, importPurchase, updatePurchaseCategory, updatePurchaseItemsCategory } from '../src/services/purchases';
import {
  getPurchaseReconciliationCandidates,
  getAccountBalance,
  getPaymentBalanceHistory,
  reconcilePurchase,
  reconcilePurchaseWithTransaction,
  undoPurchaseReconciliation,
} from '../src/services/purchase-reconciliation';
import type { PurchaseInput } from '../src/services/rj-nfce';

function purchaseInput(keyDigit: string, totalCents = 4598): PurchaseInput {
  return {
    accessKey: keyDigit.repeat(44),
    supplierName: 'Fornecedor Sintético',
    supplierCnpj: '12345678000195',
    invoiceNumber: keyDigit,
    series: '1',
    issuedAt: '2026-10-20T12:00:00-03:00',
    totalCents,
    invoiceDiscountCents: 0,
    paymentMethod: 'Cartão de Crédito',
    items: [
      { description: 'Item A sintético', quantity: '1', unit: 'UN', unitPriceCents: 2000, discountCents: null, totalCents: 2000 },
      { description: 'Item B sintético', quantity: '1', unit: 'UN', unitPriceCents: totalCents - 2000, discountCents: null, totalCents: totalCents - 2000 },
    ],
  };
}

describe('conciliação manual de compras', () => {
  it('migra CC/CD existentes e preserva a conciliação singular anterior', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'finance-migration-test-'));
    const folder = path.join(temp, 'drizzle');
    const meta = path.join(folder, 'meta');
    fs.mkdirSync(meta, { recursive: true });
    const source = path.resolve(process.cwd(), 'drizzle');
    const journal = JSON.parse(fs.readFileSync(path.join(source, 'meta/_journal.json'), 'utf8')) as { entries: Array<{ idx: number; tag: string }> };
    const entries = journal.entries.filter((entry) => entry.idx <= 11);
    fs.writeFileSync(path.join(meta, '_journal.json'), JSON.stringify({ ...journal, entries }));
    for (const entry of entries) {
      fs.copyFileSync(path.join(source, `${entry.tag}.sql`), path.join(folder, `${entry.tag}.sql`));
      fs.copyFileSync(path.join(source, `meta/${String(entry.idx).padStart(4, '0')}_snapshot.json`), path.join(meta, `${String(entry.idx).padStart(4, '0')}_snapshot.json`));
    }
    const handle = createDatabase(':memory:');
    try {
      migrate(handle.db, { migrationsFolder: folder });
      const cc = handle.sqlite.prepare("INSERT INTO payment_methods (name, normalized_name) VALUES ('CC Teste', 'cc teste')").run().lastInsertRowid;
      const cd = handle.sqlite.prepare("INSERT INTO payment_methods (name, normalized_name) VALUES ('CD Teste', 'cd teste')").run().lastInsertRowid;
      const pix = handle.sqlite.prepare("INSERT INTO payment_methods (name, normalized_name) VALUES ('Pix', 'pix')").run().lastInsertRowid;
      handle.sqlite.prepare("INSERT INTO categories (name, normalized_name) VALUES ('Mercado', 'mercado')").run();
      const transactionId = handle.sqlite.prepare("INSERT INTO transactions (purchase_date, due_date, description, amount_cents, payment_method_id, category_id) VALUES ('2026-10-20', '2026-10-20', 'Compra sintética', -2500, ?, 1)").run(cc).lastInsertRowid;
      handle.sqlite.prepare("INSERT INTO purchases (access_key, supplier_name, supplier_cnpj, invoice_number, series, issued_at, total_cents, transaction_id) VALUES (?, 'Fornecedor Sintético', '12345678000195', '1', '1', '2026-10-20T10:00:00Z', 2500, ?)").run('9'.repeat(44), transactionId);
      migrate(handle.db, { migrationsFolder: path.resolve(process.cwd(), 'drizzle') });
      const types = handle.sqlite.prepare('SELECT id, balance_type FROM payment_methods ORDER BY id').all();
      expect(types).toEqual([{ id: cc, balance_type: 'credit' }, { id: cd, balance_type: 'debit' }, { id: pix, balance_type: 'unclassified' }]);
      expect(handle.sqlite.prepare('SELECT transaction_id, payment_method_id, amount_cents FROM purchase_settlements').get()).toEqual({ transaction_id: transactionId, payment_method_id: cc, amount_cents: 2500 });
    } finally {
      handle.sqlite.close();
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it('sugere apenas saídas de mesmo valor até sete dias da data da NFC-e', () => {
    const handle = createTestDatabase();
    try {
      const purchaseId = importPurchase(handle.db, purchaseInput('1')).id;
      const close = seedTransaction(handle.db, { purchaseDate: '2026-10-22', dueDate: '2026-11-01', amount: '-R$ 45,98', description: 'Compra correspondente' });
      seedTransaction(handle.db, { purchaseDate: '2026-10-29', dueDate: '2026-11-01', amount: '-R$ 45,98', description: 'Muito distante' });
      seedTransaction(handle.db, { purchaseDate: '2026-10-21', dueDate: '2026-11-01', amount: '-R$ 45,97', description: 'Valor diferente' });
      seedTransaction(handle.db, { purchaseDate: '2026-10-21', dueDate: '2026-11-01', amount: 'R$ 45,98', description: 'Entrada' });

      const result = getPurchaseReconciliationCandidates(handle.db, purchaseId);
      expect(result.toleranceDays).toBe(7);
      expect(result.candidates).toHaveLength(2);
      expect(result.candidates[0]).toMatchObject({ transactionId: close.id, description: 'Compra correspondente', amountCents: -4598, dayDistance: 2 });
      expect(result.linkedMovement).toBeNull();
    } finally { handle.sqlite.close(); }
  });

  it('só vincula após seleção explícita, propaga categoria e desfaz restaurando categorias anteriores', () => {
    const handle = createTestDatabase();
    try {
      const purchaseId = importPurchase(handle.db, purchaseInput('2')).id;
      const previousPurchase = ensureLookup(handle.db, 'category', 'Categoria anterior da compra');
      const previousItem = ensureLookup(handle.db, 'category', 'Categoria anterior do item');
      const destination = ensureLookup(handle.db, 'category', 'Categoria da movimentação');
      updatePurchaseCategory(handle.db, purchaseId, previousPurchase.id);
      const itemIds = getPurchase(handle.db, purchaseId).items.map((item) => item.id);
      updatePurchaseItemsCategory(handle.db, purchaseId, [itemIds[0]!], previousItem.id);
      const movement = seedTransaction(handle.db, {
        purchaseDate: '2026-10-20', dueDate: '2026-11-01', amount: '-R$ 45,98',
        description: 'Movimentação compatível', category: 'Categoria da movimentação',
      });
      const originalMovement = handle.sqlite.prepare('SELECT category_id, amount_cents, purchase_date FROM transactions WHERE id = ?').get(movement.id);

      const result = reconcilePurchaseWithTransaction(handle.db, purchaseId, movement.id);
      expect(result).toMatchObject({ transactionId: movement.id, categoryId: destination.id, reconciledAt: expect.any(String) });
      expect(result.items).toMatchObject([
        { id: itemIds[0], categoryId: destination.id, categoryName: 'Categoria da movimentação' },
        { id: itemIds[1], categoryId: destination.id, categoryName: 'Categoria da movimentação' },
      ]);
      expect(handle.sqlite.prepare('SELECT category_id, amount_cents, purchase_date FROM transactions WHERE id = ?').get(movement.id)).toEqual(originalMovement);
      expect(getPurchaseReconciliationCandidates(handle.db, purchaseId).settlements[0]?.transactionId).toBe(movement.id);
      expect(() => reconcilePurchaseWithTransaction(handle.db, purchaseId, movement.id)).toThrow(/já está conciliada/i);

      // Uma alteração manual feita depois da conciliação deve sobreviver ao desfazer.
      const manual = ensureLookup(handle.db, 'category', 'Categoria manual pós conciliação');
      updatePurchaseItemsCategory(handle.db, purchaseId, [itemIds[1]!], manual.id);
      const undone = undoPurchaseReconciliation(handle.db, purchaseId);
      expect(undone).toMatchObject({ transactionId: null, categoryId: previousPurchase.id });
      expect(undone.items).toMatchObject([
        { id: itemIds[0], categoryId: previousItem.id },
        { id: itemIds[1], categoryId: manual.id },
      ]);
    } finally { handle.sqlite.close(); }
  });

  it('liquida com vários movimentos e carteira, confere o total e preserva o ajuste ao desfazer', () => {
    const handle = createTestDatabase();
    try {
      const purchaseId = importPurchase(handle.db, purchaseInput('5', 3000)).id;
      const first = seedTransaction(handle.db, { purchaseDate: '2026-10-20', dueDate: '2026-10-20', amount: '-R$ 12,00', description: 'Parcela A' });
      const second = seedTransaction(handle.db, { purchaseDate: '2026-10-20', dueDate: '2026-10-20', amount: '-R$ 8,00', description: 'Parcela B' });
      const wallet = ensureLookup(handle.db, 'payment', 'Cashback Wallet');
      const walletTwo = ensureLookup(handle.db, 'payment', 'Bônus Wallet');
      handle.sqlite.prepare("UPDATE payment_methods SET balance_type = 'wallet' WHERE id = ?").run(wallet.id);
      handle.sqlite.prepare("UPDATE payment_methods SET balance_type = 'wallet' WHERE id = ?").run(walletTwo.id);
      const category = ensureLookup(handle.db, 'category', 'Despesa escolhida');
      expect(getAccountBalance(handle.db, wallet.id).balanceCents).toBe(0);
      expect(() => reconcilePurchase(handle.db, purchaseId, {
        transactionIds: [first.id, second.id], walletPayments: [{ paymentMethodId: wallet.id, amountCents: 1001 }], categoryId: category.id,
      })).toThrow(/somam/i);
      expect(handle.sqlite.prepare('SELECT count(*) AS count FROM purchase_settlements').get()).toMatchObject({ count: 0 });

      const before = handle.sqlite.prepare('SELECT category_id, amount_cents FROM transactions WHERE id = ?').get(first.id);
      reconcilePurchase(handle.db, purchaseId, {
        transactionIds: [first.id, second.id],
        walletPayments: [
          { paymentMethodId: wallet.id, amountCents: 600, adjustment: { amountCents: 600, effectiveDate: '2026-10-20', reason: 'cashback', description: 'Crédito cashback confirmado' } },
          { paymentMethodId: walletTwo.id, amountCents: 400, adjustment: { amountCents: 400, effectiveDate: '2026-10-20', reason: 'bonus', description: 'Crédito bônus confirmado' } },
        ],
        categoryId: category.id,
      });
      expect(handle.sqlite.prepare('SELECT count(*) AS count FROM purchase_settlements WHERE reversed_at IS NULL').get()).toMatchObject({ count: 4 });
      expect(getAccountBalance(handle.db, wallet.id).balanceCents).toBe(0);
      expect(getAccountBalance(handle.db, walletTwo.id).balanceCents).toBe(0);
      expect(handle.sqlite.prepare('SELECT category_id, amount_cents FROM transactions WHERE id = ?').get(first.id)).toEqual(before);
      const undone = undoPurchaseReconciliation(handle.db, purchaseId);
      expect(undone.reconciledAt).toBeNull();
      expect(handle.sqlite.prepare('SELECT count(*) AS count FROM payment_balance_adjustments WHERE payment_method_id IN (?, ?)').get(wallet.id, walletTwo.id)).toMatchObject({ count: 2 });
      expect(handle.sqlite.prepare('SELECT count(*) AS count FROM purchase_settlements WHERE reversed_at IS NOT NULL').get()).toMatchObject({ count: 4 });
      // O desfazer remove o vínculo, mas mantém o crédito retroativo conforme a política financeira acordada.
      expect(getAccountBalance(handle.db, wallet.id).balanceCents).toBe(600);
      expect(getPaymentBalanceHistory(handle.db, wallet.id).events.some((event) => event.reversedAt !== null)).toBe(true);
      expect(getAccountBalance(handle.db, walletTwo.id).balanceCents).toBe(400);
    } finally { handle.sqlite.close(); }
  });

  it('exige categoria e saldo suficiente, rejeita movimento reutilizado e mantém atomicidade', () => {
    const handle = createTestDatabase();
    try {
      const purchaseId = importPurchase(handle.db, purchaseInput('6', 3000)).id;
      const first = seedTransaction(handle.db, { purchaseDate: '2026-10-20', dueDate: '2026-10-20', amount: '-R$ 10,00', description: 'Parcela categoria A', category: 'A' });
      const second = seedTransaction(handle.db, { purchaseDate: '2026-10-20', dueDate: '2026-10-20', amount: '-R$ 10,00', description: 'Parcela categoria B', category: 'B' });
      const wallet = ensureLookup(handle.db, 'payment', 'Bônus');
      handle.sqlite.prepare("UPDATE payment_methods SET balance_type = 'wallet' WHERE id = ?").run(wallet.id);
      expect(() => reconcilePurchase(handle.db, purchaseId, { transactionIds: [first.id, second.id], walletPayments: [{ paymentMethodId: wallet.id, amountCents: 1000 }], categoryId: null })).toThrow(/categoria/i);
      expect(() => reconcilePurchase(handle.db, purchaseId, { transactionIds: [first.id], walletPayments: [], categoryId: 1 })).toThrow(/somam/i);
      expect(() => reconcilePurchase(handle.db, purchaseId, { transactionIds: [first.id, second.id], walletPayments: [{ paymentMethodId: wallet.id, amountCents: 1000 }], categoryId: 1 })).toThrow(/saldo insuficiente/i);
      expect(handle.sqlite.prepare('SELECT count(*) AS count FROM purchase_settlements').get()).toMatchObject({ count: 0 });
      expect(() => reconcilePurchase(handle.db, purchaseId, { transactionIds: [first.id, first.id], walletPayments: [], categoryId: 1 })).toThrow(/repetida/i);
    } finally { handle.sqlite.close(); }
  });

  it('permite crédito retroativo confirmado para insuficiência cronológica de conta de débito', () => {
    const handle = createTestDatabase();
    try {
      const purchaseId = importPurchase(handle.db, purchaseInput('7', 3000)).id;
      const account = ensureLookup(handle.db, 'payment', 'Débito sintético');
      handle.sqlite.prepare("UPDATE payment_methods SET balance_type = 'debit' WHERE id = ?").run(account.id);
      const first = seedTransaction(handle.db, { purchaseDate: '2026-10-18', dueDate: '2026-10-18', amount: '-R$ 15,00', payment: 'Débito sintético', description: 'Débito um' });
      const second = seedTransaction(handle.db, { purchaseDate: '2026-10-20', dueDate: '2026-10-20', amount: '-R$ 15,00', payment: 'Débito sintético', description: 'Débito dois' });
      const category = ensureLookup(handle.db, 'category', 'Categoria do débito');
      expect(getPurchaseReconciliationCandidates(handle.db, purchaseId).candidates.find((candidate) => candidate.transactionId === second.id)?.balanceShortfallCents).toBe(3000);
      expect(() => reconcilePurchase(handle.db, purchaseId, { transactionIds: [first.id, second.id], walletPayments: [], categoryId: category.id })).toThrow(/saldo insuficiente/i);
      reconcilePurchase(handle.db, purchaseId, { transactionIds: [first.id, second.id], walletPayments: [], categoryId: category.id,
        balanceAdjustments: [{ paymentMethodId: account.id, amountCents: 3000, effectiveDate: '2026-10-18', reason: 'opening_balance', description: 'Saldo inicial confirmado' }] });
      expect(getAccountBalance(handle.db, account.id).balanceCents).toBe(0);
      undoPurchaseReconciliation(handle.db, purchaseId);
      expect(getAccountBalance(handle.db, account.id).balanceCents).toBe(0);
    } finally { handle.sqlite.close(); }
  });

  it('impede uma movimentação de ser conciliada com duas compras', () => {
    const handle = createTestDatabase();
    try {
      const first = importPurchase(handle.db, purchaseInput('3')).id;
      const second = importPurchase(handle.db, purchaseInput('4')).id;
      const movement = seedTransaction(handle.db, { purchaseDate: '2026-10-20', dueDate: '2026-11-01', amount: '-R$ 45,98', description: 'Movimento único' });
      reconcilePurchaseWithTransaction(handle.db, first, movement.id);
      expect(getPurchaseReconciliationCandidates(handle.db, second).candidates).toHaveLength(0);
      expect(() => reconcilePurchaseWithTransaction(handle.db, second, movement.id)).toThrow(/não corresponde/i);
      expect(getPurchase(handle.db, second).transactionId).toBeNull();
    } finally { handle.sqlite.close(); }
  });
  it("blocks transaction edits while a purchase settlement is active, then permits deletion after undo", () => {
    const handle = createTestDatabase();
    try {
      const purchaseId = importPurchase(handle.db, purchaseInput("8")).id;
      const movement = seedTransaction(handle.db, { purchaseDate: "2026-10-20", dueDate: "2026-10-20", amount: "-R$ 45,98", description: "Movimento protegido" });
      reconcilePurchaseWithTransaction(handle.db, purchaseId, movement.id);
      expect(() => updateTransaction(handle.db, movement.id, { purchaseDate: movement.purchaseDate, dueDate: movement.dueDate, description: "Alterado", amount: "-R$ 45,98", paymentMethodId: movement.paymentMethodId, categoryId: movement.categoryId, transfer: "Não" })).toThrow(/desfaça a conciliação/i);
      expect(() => bulkUpdateTransactions(handle.db, [movement.id], { categoryId: ensureLookup(handle.db, "category", "Outra categoria").id })).toThrow(/desfaça a conciliação/i);
      expect(() => deleteTransaction(handle.db, movement.id)).toThrow(/desfaça a conciliação/i);
      undoPurchaseReconciliation(handle.db, purchaseId);
      expect(handle.sqlite.prepare("SELECT transaction_id FROM purchase_settlements WHERE purchase_id = ?").get(purchaseId)).toMatchObject({ transaction_id: null });
      expect(() => deleteTransaction(handle.db, movement.id)).not.toThrow();
    } finally { handle.sqlite.close(); }
  });

  it("preserves category changes through undo when the purchase is settled only by wallet", () => {
    const handle = createTestDatabase();
    try {
      const purchaseId = importPurchase(handle.db, purchaseInput("9")).id;
      const wallet = ensureLookup(handle.db, "payment", "Carteira de teste");
      handle.sqlite.prepare("UPDATE payment_methods SET balance_type = 'wallet' WHERE id = ?").run(wallet.id);
      const initial = ensureLookup(handle.db, "category", "Categoria inicial da carteira");
      const revised = ensureLookup(handle.db, "category", "Categoria revisada da carteira");
      updatePurchaseCategory(handle.db, purchaseId, initial.id);
      const items = getPurchase(handle.db, purchaseId).items;
      reconcilePurchase(handle.db, purchaseId, { transactionIds: [], walletPayments: [{ paymentMethodId: wallet.id, amountCents: 4598, adjustment: { amountCents: 4598, effectiveDate: "2026-10-20", reason: "opening_balance", description: "Saldo inicial sintético" } }], categoryId: initial.id });
      updatePurchaseCategory(handle.db, purchaseId, revised.id);
      updatePurchaseItemsCategory(handle.db, purchaseId, [items[0]!.id], revised.id);
      const undone = undoPurchaseReconciliation(handle.db, purchaseId);
      expect(undone.categoryId).toBe(revised.id);
      expect(undone.items[0]?.categoryId).toBe(revised.id);
    } finally { handle.sqlite.close(); }
  });

});
