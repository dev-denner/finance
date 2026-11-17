import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseHandle } from '../src/db/client';
import { buildApp } from '../src/app';
import { createBill, getBill, payBill, payBillsWithOneTransaction, undoBillPayment, unpayBill } from '../src/services/bills';
import { ensureLookup } from '../src/services/lookups';
import { createTransaction, deleteTransaction } from '../src/services/transactions';
import { createTestDatabase } from './helpers';

const TODAY = '2026-03-05';
let handle: DatabaseHandle;
let categoryId: number;
let paymentMethodId: number;

beforeEach(() => {
  handle = createTestDatabase();
  categoryId = ensureLookup(handle.db, 'category', 'Contas').id;
  paymentMethodId = ensureLookup(handle.db, 'payment', 'Conta Corrente').id;
});

afterEach(() => handle.sqlite.close());

const count = (table: string) =>
  (handle.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

function bill(description: string, amountCents: number, dueDate = '2026-03-10', category = categoryId) {
  return createBill(handle.db, { description, amountCents, dueDate, categoryId: category }, TODAY);
}

function outflow(amountCents: number, description = 'PAG BOLETO CONDOMINIO') {
  return createTransaction(handle.db, {
    purchaseDate: '2026-03-08',
    dueDate: '2026-03-08',
    description,
    amountCents: -amountCents,
    categoryId,
    paymentMethodId,
    installmentNumber: null,
    installmentTotal: null,
    transfer: null,
  });
}

describe('boleto agrupado — um lançamento paga várias contas', () => {
  it('cria um lançamento com o total e quita cada conta pelo que falta', () => {
    const condo = bill('Condomínio', 80000, '2026-03-10');
    const fee = bill('Taxa extra', 15000, '2026-03-08');
    payBill(handle.db, condo.id, { mode: 'external', paidAt: '2026-03-01', paidCents: 30000, partial: true }, TODAY);

    const result = payBillsWithOneTransaction(handle.db, [condo.id, fee.id], { mode: 'transaction', paidAt: '2026-03-09', paymentMethodId }, TODAY);
    expect(result).toMatchObject({ updated: 2, paidCents: 50000 + 15000 });
    const tx = handle.sqlite.prepare('SELECT amount_cents AS a, description AS d, purchase_date AS p, due_date AS v FROM transactions WHERE id = ?').get(result.transactionId);
    expect(tx).toEqual({ a: -65000, d: 'Boleto agrupado: Condomínio, Taxa extra', p: '2026-03-08', v: '2026-03-09' });

    const paidCondo = getBill(handle.db, condo.id, TODAY);
    expect(paidCondo).toMatchObject({ state: 'paid', paidAt: '2026-03-09', paidCents: 80000, paymentMethodId });
    expect(paidCondo.payments.map((p) => [p.amountCents, p.groupSize])).toEqual([[30000, 1], [50000, 2]]);
    expect(getBill(handle.db, fee.id, TODAY)).toMatchObject({ state: 'paid', paidCents: 15000 });
  });

  it('categorias diferentes exigem a categoria do lançamento; menos de duas contas é recusado', () => {
    const other = ensureLookup(handle.db, 'category', 'Moradia').id;
    const a = bill('Água', 9000);
    const b = bill('IPTU', 20000, '2026-03-10', other);
    expect(() => payBillsWithOneTransaction(handle.db, [a.id, b.id], { mode: 'transaction', paidAt: TODAY, paymentMethodId }, TODAY)).toThrow(/categorias diferentes/);
    expect(() => payBillsWithOneTransaction(handle.db, [a.id], { mode: 'transaction', paidAt: TODAY, paymentMethodId }, TODAY)).toThrow(/ao menos duas/);
    expect(count('transactions')).toBe(0);
    const ok = payBillsWithOneTransaction(handle.db, [a.id, b.id], { mode: 'transaction', paidAt: TODAY, paymentMethodId, categoryId: other, description: 'Boleto prefeitura' }, TODAY);
    expect(handle.sqlite.prepare('SELECT category_id AS c, description AS d FROM transactions WHERE id = ?').get(ok.transactionId)).toEqual({ c: other, d: 'Boleto prefeitura' });
  });

  it('vincula um lançamento existente só quando o valor é o total e ele ainda não paga conta', () => {
    const a = bill('Condomínio', 80000);
    const b = bill('Fundo de obras', 5000);
    expect(() => payBillsWithOneTransaction(handle.db, [a.id, b.id], { mode: 'link', transactionId: outflow(84000).id }, TODAY)).toThrow(/não bate com o total/);
    const tx = outflow(85000);
    payBillsWithOneTransaction(handle.db, [a.id, b.id], { mode: 'link', transactionId: tx.id }, TODAY);
    expect(getBill(handle.db, a.id, TODAY)).toMatchObject({ state: 'paid', paidAt: '2026-03-08' });

    const c = bill('Gás', 1000);
    const d = bill('Luz', 1000);
    expect(() => payBillsWithOneTransaction(handle.db, [c.id, d.id], { mode: 'link', transactionId: tx.id }, TODAY)).toThrow(/já paga outra conta/);
    // Excluir o lançamento é bloqueado e a mensagem conta as demais contas do grupo.
    expect(() => deleteTransaction(handle.db, tx.id)).toThrow(/e mais 1 conta/);
    // O índice continua impedindo o mesmo lançamento duas vezes na mesma conta.
    expect(() =>
      handle.sqlite.prepare("INSERT INTO bill_payments (bill_id, transaction_id, amount_cents, paid_at, origin) VALUES (?, ?, 1, '2026-03-08', 'manual')").run(a.id, tx.id),
    ).toThrow(/UNIQUE/);
  });

  it('desfazer qualquer conta do grupo desfaz todas; o lançamento criado some, o vinculado fica', () => {
    const a = bill('Condomínio', 80000);
    const b = bill('Taxa extra', 15000);
    const partial = payBill(handle.db, a.id, { mode: 'external', paidAt: '2026-03-01', paidCents: 30000, partial: true }, TODAY);
    const created = payBillsWithOneTransaction(handle.db, [a.id, b.id], { mode: 'transaction', paidAt: TODAY, paymentMethodId }, TODAY);
    const grouped = getBill(handle.db, b.id, TODAY).payments[0];

    const reopened = undoBillPayment(handle.db, b.id, grouped.id, TODAY);
    expect(reopened).toMatchObject({ state: 'open', payments: [] });
    // A outra conta volta a ter só o parcial de antes.
    expect(getBill(handle.db, a.id, TODAY)).toMatchObject({ state: 'open', partialPaidCents: 30000 });
    expect(getBill(handle.db, a.id, TODAY).payments.map((p) => p.id)).toEqual([partial.payments[0].id]);
    expect(handle.sqlite.prepare('SELECT COUNT(*) AS n FROM transactions WHERE id = ?').get(created.transactionId)).toEqual({ n: 0 });

    const tx = outflow(65000);
    payBillsWithOneTransaction(handle.db, [a.id, b.id], { mode: 'link', transactionId: tx.id }, TODAY);
    unpayBill(handle.db, a.id, TODAY);
    expect([getBill(handle.db, a.id, TODAY).state, getBill(handle.db, b.id, TODAY).state]).toEqual(['open', 'open']);
    expect(getBill(handle.db, a.id, TODAY).payments).toEqual([]);
    expect(handle.sqlite.prepare('SELECT COUNT(*) AS n FROM transactions WHERE id = ?').get(tx.id)).toEqual({ n: 1 });
  });

  it('a rota valida o corpo e paga o grupo', async () => {
    const a = bill('Condomínio', 80000);
    const b = bill('Taxa extra', 15000);
    const app = await buildApp({ db: handle.db, logger: false });
    try {
      const bad = await app.inject({ method: 'POST', url: '/api/bills/group-pay', payload: { ids: [a.id, b.id], mode: 'transaction', paidAt: TODAY } });
      expect(bad.statusCode).toBe(400);
      const ok = await app.inject({ method: 'POST', url: '/api/bills/group-pay', payload: { ids: [a.id, b.id], mode: 'transaction', paidAt: TODAY, paymentMethodId } });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toMatchObject({ updated: 2, paidCents: 95000 });
    } finally {
      await app.close();
    }
  });
});
