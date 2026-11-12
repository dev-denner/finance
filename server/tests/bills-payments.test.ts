import { describe, expect, it } from 'vitest';
import {
  createBill,
  createTemplate,
  deleteBill,
  getBill,
  listBills,
  payBill,
  unpayBill,
} from '../src/services/bills';
import { ensureLookup } from '../src/services/lookups';
import {
  bulkDeleteTransactions,
  deleteTransaction,
  getTransaction,
  listTransactions,
  updateTransaction,
} from '../src/services/transactions';
import { linkTransfer } from '../src/services/transfers';
import { createTestDatabase, seedTransaction } from './helpers';

const TODAY = '2026-03-10';

function setup() {
  const handle = createTestDatabase();
  const category = ensureLookup(handle.db, 'category', 'Moradia');
  const account = ensureLookup(handle.db, 'payment', 'Conta Corrente');
  const bill = (description = 'Condomínio', dueDate = '2026-03-15', amountCents = 78200) =>
    createBill(handle.db, { description, amountCents, dueDate, categoryId: category.id }, TODAY);
  const count = (table: string) =>
    (handle.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  return { db: handle.db, sqlite: handle.sqlite, category, account, bill, count };
}

describe('pagar com lançamento (AC4)', () => {
  it('cria um lançamento de saída com os dados da conta e vincula', () => {
    const { db, category, account, bill, count } = setup();
    const target = bill();

    const paid = payBill(
      db,
      target.id,
      { mode: 'transaction', paidAt: '2026-03-14', paidCents: 78200, paymentMethodId: account.id },
      TODAY,
    );

    expect(paid).toMatchObject({
      state: 'paid',
      paidAt: '2026-03-14',
      paidCents: 78200,
      paymentMethodId: account.id,
      paymentMethodName: 'Conta Corrente',
    });
    expect(paid.payments).toHaveLength(1);
    expect(paid.payments[0]).toMatchObject({
      amountCents: 78200,
      paidAt: '2026-03-14',
      origin: 'manual',
      createdTransaction: true,
      paymentMethodName: 'Conta Corrente',
      transactionDescription: 'Condomínio',
    });

    const transaction = getTransaction(db, paid.payments[0].transactionId);
    expect(transaction).toMatchObject({
      amountCents: -78200,
      description: 'Condomínio',
      categoryId: category.id,
      paymentMethodId: account.id,
      purchaseDate: '2026-03-15', // competência: vencimento da conta
      dueDate: '2026-03-14', // caixa: data do pagamento
      billPayment: { billId: target.id, description: 'Condomínio', dueDate: '2026-03-15' },
    });
    expect(count('transactions')).toBe(1);
    expect(count('bill_payments')).toBe(1);
  });

  it('a listagem de lançamentos mostra a conta paga', () => {
    const { db, account, bill } = setup();
    payBill(db, bill().id, { mode: 'transaction', paidAt: '2026-03-14', paidCents: 78200, paymentMethodId: account.id }, TODAY);
    const { rows } = listTransactions(db, {
      year: 2026,
      month: 3,
      dateField: 'due',
      kind: 'all',
      sortBy: 'dueDate',
      sortDir: 'desc',
      page: 1,
      pageSize: 25,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].billPayment?.description).toBe('Condomínio');
  });

  it('é atômico: conta inexistente de pagamento não deixa lançamento nem conta paga', () => {
    const { db, bill, count } = setup();
    const target = bill();
    expect(() =>
      payBill(db, target.id, { mode: 'transaction', paidAt: '2026-03-14', paidCents: 78200, paymentMethodId: 999 }, TODAY),
    ).toThrow();
    expect(count('transactions')).toBe(0);
    expect(count('bill_payments')).toBe(0);
    expect(getBill(db, target.id, TODAY).state).toBe('open');
  });

  it('valida data e valor antes de criar o lançamento', () => {
    const { db, account, bill, count } = setup();
    const target = bill();
    expect(() =>
      payBill(db, target.id, { mode: 'transaction', paidAt: '2026-02-30', paidCents: 100, paymentMethodId: account.id }, TODAY),
    ).toThrow(/Data do pagamento/);
    expect(() =>
      payBill(db, target.id, { mode: 'transaction', paidAt: '2026-03-14', paidCents: -5, paymentMethodId: account.id }, TODAY),
    ).toThrow(/positivo/);
    expect(count('transactions')).toBe(0);
  });

  it('conta já paga não é paga de novo', () => {
    const { db, account, bill } = setup();
    const target = bill();
    payBill(db, target.id, { mode: 'external', paidAt: '2026-03-14', paidCents: 78200 }, TODAY);
    expect(() =>
      payBill(db, target.id, { mode: 'transaction', paidAt: '2026-03-14', paidCents: 78200, paymentMethodId: account.id }, TODAY),
    ).toThrow(/já está paga/);
  });
});

describe('vincular lançamento existente (AC5)', () => {
  it('vincula sem criar outro lançamento e herda data, valor e conta do lançamento', () => {
    const { db, bill, count } = setup();
    const imported = seedTransaction(db, {
      description: 'PAG BOLETO CONDOMINIO',
      amount: '-R$ 782,00',
      dueDate: '2026-03-16',
      payment: 'Nubank Conta',
      category: 'Moradia',
    });
    const target = bill();

    const paid = payBill(db, target.id, { mode: 'link', transactionId: imported.id, origin: 'import_match' }, TODAY);

    expect(count('transactions')).toBe(1);
    expect(paid).toMatchObject({
      state: 'paid',
      paidAt: '2026-03-16',
      paidCents: 78200,
      paymentMethodId: imported.paymentMethodId,
    });
    expect(paid.payments[0]).toMatchObject({
      transactionId: imported.id,
      origin: 'import_match',
      createdTransaction: false,
    });
  });

  it('recusa lançamento que já paga outra conta (409)', () => {
    const { db, bill } = setup();
    const imported = seedTransaction(db, { amount: '-R$ 100,00', dueDate: '2026-03-16' });
    payBill(db, bill('A').id, { mode: 'link', transactionId: imported.id }, TODAY);
    expect(() => payBill(db, bill('B').id, { mode: 'link', transactionId: imported.id }, TODAY)).toThrow(
      /já paga outra conta/,
    );
  });

  it('recusa entrada, lançamento inexistente e ponta de transferência confirmada', () => {
    const { db, bill } = setup();
    const income = seedTransaction(db, { amount: 'R$ 100,00', dueDate: '2026-03-16' });
    expect(() => payBill(db, bill().id, { mode: 'link', transactionId: income.id }, TODAY)).toThrow(/saída/);
    expect(() => payBill(db, bill().id, { mode: 'link', transactionId: 9999 }, TODAY)).toThrow(/não encontrado/);

    const out = seedTransaction(db, { amount: '-R$ 50,00', dueDate: '2026-03-16', payment: 'Conta A', category: 'Transferência' });
    const into = seedTransaction(db, { amount: 'R$ 50,00', dueDate: '2026-03-16', payment: 'Conta B', category: 'Transferência' });
    linkTransfer(db, { outgoingTransactionId: out.id, incomingTransactionId: into.id });
    expect(() => payBill(db, bill().id, { mode: 'link', transactionId: out.id }, TODAY)).toThrow(/transferência/);
  });
});

describe('desfazer pagamento (AC6, AC4a)', () => {
  it('apaga o lançamento criado pelo pagamento e reabre a conta', () => {
    const { db, account, bill, count } = setup();
    const target = bill();
    payBill(db, target.id, { mode: 'transaction', paidAt: '2026-03-14', paidCents: 78200, paymentMethodId: account.id }, TODAY);

    const reopened = unpayBill(db, target.id, TODAY);
    expect(reopened).toMatchObject({ state: 'open', paidAt: null, paidCents: null, payments: [] });
    expect(count('transactions')).toBe(0);
    expect(count('bill_payments')).toBe(0);
  });

  it('só desvincula um lançamento que já existia', () => {
    const { db, bill, count } = setup();
    const imported = seedTransaction(db, { amount: '-R$ 782,00', dueDate: '2026-03-16' });
    const target = bill();
    payBill(db, target.id, { mode: 'link', transactionId: imported.id }, TODAY);

    unpayBill(db, target.id, TODAY);
    expect(count('transactions')).toBe(1);
    expect(count('bill_payments')).toBe(0);
    expect(getTransaction(db, imported.id).billPayment).toBeNull();
  });

  it('modo externo reabre sem tocar em lançamentos', () => {
    const { db, bill, count } = setup();
    seedTransaction(db, { amount: '-R$ 10,00', dueDate: '2026-03-01' });
    const target = bill();
    payBill(db, target.id, { mode: 'external', paidAt: '2026-03-14', paidCents: 78200 }, TODAY);
    unpayBill(db, target.id, TODAY);
    expect(count('transactions')).toBe(1);
    expect(getBill(db, target.id, TODAY).state).toBe('open');
  });

  it('desfazer em conta aberta é inofensivo', () => {
    const { db, bill } = setup();
    const target = bill();
    expect(unpayBill(db, target.id, TODAY).state).toBe('open');
  });

  it('conta paga migrada (PG legado, sem lançamento) reabre normalmente', () => {
    const { db, sqlite, bill } = setup();
    const target = bill();
    sqlite
      .prepare("UPDATE scheduled_bills SET state = 'paid', paid_at = due_date, paid_cents = amount_cents, migrated_payment = 1 WHERE id = ?")
      .run(target.id);
    expect(getBill(db, target.id, TODAY).migratedPayment).toBe(true);
    expect(unpayBill(db, target.id, TODAY)).toMatchObject({ state: 'open', migratedPayment: false });
  });
});

describe('proteções no Módulo 2 (AC7)', () => {
  it('bloqueia excluir lançamento que paga uma conta, individual e em massa', () => {
    const { db, account, bill, count } = setup();
    const free = seedTransaction(db, { amount: '-R$ 10,00', dueDate: '2026-03-01' });
    const paid = payBill(db, bill().id, { mode: 'transaction', paidAt: '2026-03-14', paidCents: 78200, paymentMethodId: account.id }, TODAY);
    const linkedId = paid.payments[0].transactionId;

    expect(() => deleteTransaction(db, linkedId)).toThrow(/Desfaça o pagamento/);
    expect(() => bulkDeleteTransactions(db, [free.id, linkedId])).toThrow(/Condomínio/);
    expect(count('transactions')).toBe(2); // nada apagado na exclusão em massa recusada

    deleteTransaction(db, free.id);
    expect(count('transactions')).toBe(1);
  });

  it('bloqueia transformar em entrada o lançamento que paga uma conta; editar o resto é livre', () => {
    const { db, account, bill } = setup();
    const paid = payBill(db, bill().id, { mode: 'transaction', paidAt: '2026-03-14', paidCents: 78200, paymentMethodId: account.id }, TODAY);
    const linkedId = paid.payments[0].transactionId;

    expect(() => updateTransaction(db, linkedId, { amount: 'R$ 782,00' })).toThrow(/continuar como saída/);
    expect(updateTransaction(db, linkedId, { description: 'Condomínio março' }).description).toBe('Condomínio março');
    expect(updateTransaction(db, linkedId, { amount: '-R$ 790,00' }).amountCents).toBe(-79000);
  });

  it('bloqueia vincular como transferência um lançamento que paga uma conta', () => {
    const { db, bill } = setup();
    const out = seedTransaction(db, { amount: '-R$ 50,00', dueDate: '2026-03-16', payment: 'Conta A' });
    const into = seedTransaction(db, { amount: 'R$ 50,00', dueDate: '2026-03-16', payment: 'Conta B' });
    payBill(db, bill().id, { mode: 'link', transactionId: out.id }, TODAY);
    expect(() => linkTransfer(db, { outgoingTransactionId: out.id, incomingTransactionId: into.id })).toThrow(
      /não pode ser vinculado como transferência/,
    );
  });

  it('excluir conta com pagamento vinculado é bloqueado, avulsa ou de recorrência', () => {
    const { db, account, category, bill } = setup();
    const single = bill();
    payBill(db, single.id, { mode: 'transaction', paidAt: '2026-03-14', paidCents: 78200, paymentMethodId: account.id }, TODAY);
    expect(() => deleteBill(db, single.id)).toThrow(/Desfaça o pagamento/);

    createTemplate(
      db,
      { description: 'Internet', amountCents: 9900, categoryId: category.id, recurrence: { frequency: 'monthly', interval: 1, dayOfMonth: 12 }, startDate: '2026-03-12' },
      TODAY,
    );
    const occurrence = listBills(db, 2026, 3, { today: TODAY }).bills[0];
    payBill(db, occurrence.id, { mode: 'transaction', paidAt: '2026-03-12', paidCents: 9900, paymentMethodId: account.id }, TODAY);
    expect(() => deleteBill(db, occurrence.id)).toThrow(/Desfaça o pagamento/);
    expect(getBill(db, occurrence.id, TODAY).payments).toHaveLength(1);
  });
});
