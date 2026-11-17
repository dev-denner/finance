import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseHandle } from '../src/db/client';
import { createBill, createTemplate, deleteBill, getBill, listBills, payBill, skipBill, unpayBill, updateBill } from '../src/services/bills';
import { ensureLookup } from '../src/services/lookups';
import { buildApp } from '../src/app';
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

function bill(amountCents = 100000, dueDate = '2026-03-10') {
  return createBill(handle.db, { description: 'Condomínio', amountCents, dueDate, categoryId }, TODAY);
}

describe('pagamento parcial de contas', () => {
  it('parcial deixa a conta em aberto com o valor já pago; a soma quita no valor previsto', () => {
    const target = bill();
    const first = payBill(handle.db, target.id, { mode: 'external', paidAt: '2026-03-06', paidCents: 40000, partial: true }, TODAY);
    expect(first).toMatchObject({ state: 'open', paidAt: null, paidCents: null, partialPaidCents: 40000, displayStatus: 'upcoming' });
    expect(first.payments).toHaveLength(1);

    const second = payBill(handle.db, target.id, {
      mode: 'transaction', paidAt: '2026-03-08', paidCents: 60000, paymentMethodId, partial: true,
    }, TODAY);
    expect(second).toMatchObject({ state: 'paid', paidAt: '2026-03-08', paidCents: 100000, partialPaidCents: 0, paymentMethodId });
    expect(second.payments.map((payment) => [payment.amountCents, payment.transactionId !== null])).toEqual([[40000, false], [60000, true]]);
    expect(count('transactions')).toBe(1);
  });

  it('sem a opção parcial, o pagamento quita a conta com qualquer valor e soma os parciais anteriores', () => {
    const target = bill();
    payBill(handle.db, target.id, { mode: 'external', paidAt: '2026-03-06', paidCents: 30000, partial: true }, TODAY);
    const settled = payBill(handle.db, target.id, { mode: 'external', paidAt: '2026-03-09', paidCents: 50000 }, TODAY);
    expect(settled).toMatchObject({ state: 'paid', paidAt: '2026-03-09', paidCents: 80000 });
    expect(() => payBill(handle.db, target.id, { mode: 'external', paidAt: '2026-03-09', paidCents: 1 }, TODAY)).toThrow(/já está paga/);
  });

  it('o resumo conta o parcial como pago e só o restante como em aberto ou atrasado', () => {
    const late = bill(100000, '2026-03-01');
    payBill(handle.db, late.id, { mode: 'external', paidAt: '2026-03-02', paidCents: 25000, partial: true }, TODAY);
    const { summary } = listBills(handle.db, 2026, 3, { today: TODAY });
    expect(summary).toMatchObject({ totalCents: 100000, paidCents: 25000, openCents: 75000, overdueCents: 75000 });
    expect(summary.statusCounts.overdue).toBe(1);
  });

  it('desfazer remove todos os pagamentos, inclusive os parciais, e apaga só os lançamentos criados', () => {
    const target = bill();
    payBill(handle.db, target.id, { mode: 'transaction', paidAt: '2026-03-06', paidCents: 40000, paymentMethodId, partial: true }, TODAY);
    payBill(handle.db, target.id, { mode: 'external', paidAt: '2026-03-07', paidCents: 10000, partial: true }, TODAY);
    const reopened = unpayBill(handle.db, target.id, TODAY);
    expect(reopened).toMatchObject({ state: 'open', partialPaidCents: 0, payments: [] });
    expect(count('bill_payments')).toBe(0);
    expect(count('transactions')).toBe(0);
  });

  it('conta avulsa com pagamento só sem lançamento pode ser excluída; com lançamento, não', () => {
    const external = bill();
    payBill(handle.db, external.id, { mode: 'external', paidAt: '2026-03-06', paidCents: 1000, partial: true }, TODAY);
    expect(deleteBill(handle.db, external.id)).toMatchObject({ removed: true });
    expect(count('bill_payments')).toBe(0);

    const linked = bill();
    payBill(handle.db, linked.id, { mode: 'transaction', paidAt: '2026-03-06', paidCents: 1000, paymentMethodId, partial: true }, TODAY);
    expect(() => deleteBill(handle.db, linked.id)).toThrow(/Desfaça o pagamento/);
    expect(getBill(handle.db, linked.id, TODAY).partialPaidCents).toBe(1000);
  });

  it('a rota de pagamento aceita a opção parcial e recusa tipo errado', async () => {
    const target = bill();
    const app = await buildApp({ db: handle.db, logger: false });
    try {
      const ok = await app.inject({ method: 'POST', url: `/api/bills/${target.id}/pay`, payload: { mode: 'external', paidAt: '2026-03-06', paidCents: 1000, partial: true } });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().bill).toMatchObject({ state: 'open', partialPaidCents: 1000 });
      const bad = await app.inject({ method: 'POST', url: `/api/bills/${target.id}/pay`, payload: { mode: 'external', paidAt: '2026-03-06', paidCents: 1000, partial: 'sim' } });
      expect(bad.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('conta com parcial não pode ser pulada, nem a ocorrência excluída; desfazer libera', () => {
    const template = createTemplate(handle.db, {
      description: 'Escola', amountCents: 50000, categoryId,
      recurrence: { frequency: 'monthly', interval: 1, dayOfMonth: 10 }, startDate: '2026-03-10', occurrenceCount: 1,
    }, TODAY);
    const [occurrence] = listBills(handle.db, 2026, 3, { today: TODAY }).bills.filter((item) => item.templateId === template.id);
    payBill(handle.db, occurrence!.id, { mode: 'external', paidAt: '2026-03-06', paidCents: 1000, partial: true }, TODAY);
    expect(() => skipBill(handle.db, occurrence!.id, TODAY)).toThrow(/pagamento parcial/);
    expect(() => deleteBill(handle.db, occurrence!.id)).toThrow(/pagamento parcial/);
    unpayBill(handle.db, occurrence!.id, TODAY);
    expect(skipBill(handle.db, occurrence!.id, TODAY).state).toBe('skipped');
  });

  it('o valor não fica abaixo do já pago; igual ao já pago, a conta é quitada', () => {
    const target = bill();
    payBill(handle.db, target.id, { mode: 'external', paidAt: '2026-03-06', paidCents: 60000, partial: true }, TODAY);
    const input = { description: 'Condomínio', dueDate: '2026-03-10', categoryId };
    expect(() => updateBill(handle.db, target.id, { ...input, amountCents: 50000 }, TODAY)).toThrow(/abaixo do que já foi pago/);
    expect(updateBill(handle.db, target.id, { ...input, amountCents: 60000 }, TODAY)).toMatchObject({ state: 'paid', paidAt: '2026-03-06', paidCents: 60000 });
  });

  it('situação legada: reabrir descarta pagamentos externos, recusa com lançamento, e PG não quita parcial', () => {
    const input = { description: 'Condomínio', amountCents: 100000, dueDate: '2026-03-10', categoryId };
    const external = bill();
    payBill(handle.db, external.id, { mode: 'external', paidAt: '2026-03-06', paidCents: 100000 }, TODAY);
    expect(updateBill(handle.db, external.id, { ...input, status: '' }, TODAY)).toMatchObject({ state: 'open', partialPaidCents: 0, payments: [] });

    const linked = bill();
    payBill(handle.db, linked.id, { mode: 'transaction', paidAt: '2026-03-06', paidCents: 100000, paymentMethodId }, TODAY);
    expect(() => updateBill(handle.db, linked.id, { ...input, status: '' }, TODAY)).toThrow(/vinculado a um lançamento/);

    const partial = bill();
    payBill(handle.db, partial.id, { mode: 'external', paidAt: '2026-03-06', paidCents: 1000, partial: true }, TODAY);
    expect(() => updateBill(handle.db, partial.id, { ...input, status: 'PG' }, TODAY)).toThrow(/Use "Pagar"/);
  });

  it('alterar o valor de conta paga com registro de pagamento não reescreve o valor pago', () => {
    const target = bill();
    payBill(handle.db, target.id, { mode: 'external', paidAt: '2026-03-06', paidCents: 100000 }, TODAY);
    const updated = updateBill(handle.db, target.id, { description: 'Condomínio', amountCents: 120000, dueDate: '2026-03-10', categoryId }, TODAY);
    expect(updated).toMatchObject({ state: 'paid', amountCents: 120000, paidCents: 100000 });
    expect(updated.payments.map((payment) => payment.amountCents)).toEqual([100000]);
  });
});
