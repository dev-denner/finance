import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseHandle } from '../src/db/client';
import { createLookup, ensureLookup, listLookups } from '../src/services/lookups';
import {
  bulkDeleteTransactions,
  bulkUpdateTransactions,
  createTransaction,
  deleteTransaction,
  listTransactions,
  updateTransaction,
} from '../src/services/transactions';
import { createTestDatabase, seedTransaction } from './helpers';

describe('lançamentos', () => {
  let handle: DatabaseHandle;

  beforeEach(() => {
    handle = createTestDatabase();
  });

  afterEach(() => {
    handle.sqlite.close();
  });

  it('armazena valores positivos e negativos em centavos e calcula o resumo', () => {
    seedTransaction(handle.db, {
      dueDate: '2026-01-10',
      amount: '-R$ 100,00',
      description: 'Mercado',
      category: 'Mercado',
    });
    seedTransaction(handle.db, {
      dueDate: '2026-01-05',
      amount: 'R$ 5.000,00',
      description: 'Salário',
      category: 'Salário',
    });
    seedTransaction(handle.db, {
      dueDate: '2026-01-15',
      amount: '-R$ 200,00',
      description: 'Transferência',
      category: 'Investimentos',
      transfer: 'Sim',
    });

    const result = listTransactions(handle.db, {
      year: 2026,
      dateField: 'due',
      kind: 'all',
      sortBy: 'dueDate',
      sortDir: 'asc',
      page: 1,
      pageSize: 25,
    });

    expect(result.total).toBe(3);
    expect(result.summary).toMatchObject({
      count: 3,
      expenseCents: 10000,
      incomeCents: 500000,
      transferCents: 20000,
      netCents: 470000,
    });
    expect(result.rows.map((row) => row.amountCents)).toContain(-10000);

    const expenses = listTransactions(handle.db, {
      kind: 'expenses',
      dateField: 'due',
      sortBy: 'dueDate',
      sortDir: 'desc',
      page: 1,
      pageSize: 25,
    });
    expect(expenses.total).toBe(1);
    expect(expenses.rows[0].description).toBe('Mercado');

    const transfers = listTransactions(handle.db, {
      kind: 'transfers',
      dateField: 'due',
      sortBy: 'dueDate',
      sortDir: 'desc',
      page: 1,
      pageSize: 25,
    });
    expect(transfers.total).toBe(1);
    expect(transfers.rows[0].transfer).toBe('Sim');
  });

  it('filtra por mês, ano, categoria, pagamento, busca e ordenação', () => {
    seedTransaction(handle.db, {
      dueDate: '2026-01-10',
      amount: '-R$ 100,00',
      description: 'Padaria',
      category: 'Mercado',
      payment: 'Pix',
    });
    seedTransaction(handle.db, {
      dueDate: '2026-02-10',
      amount: '-R$ 50,00',
      description: 'Farmácia',
      category: 'Saúde',
      payment: 'Cartão',
    });
    seedTransaction(handle.db, {
      dueDate: '2025-12-10',
      amount: '-R$ 75,00',
      description: 'Mercado antigo',
      category: 'Mercado',
      payment: 'Pix',
    });

    const january = listTransactions(handle.db, {
      year: 2026,
      month: 1,
      dateField: 'due',
      kind: 'all',
      sortBy: 'dueDate',
      sortDir: 'desc',
      page: 1,
      pageSize: 25,
    });
    expect(january.total).toBe(1);
    expect(january.rows[0].description).toBe('Padaria');

    const health = listTransactions(handle.db, {
      categoryId: listLookups(handle.db, 'category').find((item) => item.name === 'Saúde')!.id,
      dateField: 'due',
      kind: 'all',
      sortBy: 'dueDate',
      sortDir: 'desc',
      page: 1,
      pageSize: 25,
    });
    expect(health.rows.map((row) => row.description)).toEqual(['Farmácia']);

    const search = listTransactions(handle.db, {
      search: 'farmac',
      dateField: 'due',
      kind: 'all',
      sortBy: 'dueDate',
      sortDir: 'desc',
      page: 1,
      pageSize: 25,
    });
    expect(search.total).toBe(1);
    expect(search.rows[0].description).toBe('Farmácia');

    const accentInsensitive = listTransactions(handle.db, {
      search: 'farmacia',
      dateField: 'due',
      kind: 'all',
      sortBy: 'dueDate',
      sortDir: 'desc',
      page: 1,
      pageSize: 25,
    });
    expect(accentInsensitive.total).toBe(1);

    const sorted = listTransactions(handle.db, {
      dateField: 'due',
      kind: 'all',
      sortBy: 'amount',
      sortDir: 'asc',
      page: 1,
      pageSize: 2,
    });
    expect(sorted.total).toBe(3);
    expect(sorted.totalPages).toBe(2);
    expect(sorted.rows[0].amountCents).toBe(-10000);
  });

  function expectIssue(run: () => unknown, pattern: RegExp) {
    try {
      run();
      expect.unreachable('a validação deveria falhar');
    } catch (error) {
      const issues = (error as { issues?: { message: string }[] }).issues ?? [];
      expect(issues.map((issue) => issue.message).join(' ')).toMatch(pattern);
    }
  }

  it('edita um lançamento individual e valida os dados', () => {
    const transaction = seedTransaction(handle.db, {
      purchaseDate: '2026-01-01',
      dueDate: '2026-01-31',
      amount: '-R$ 1.000,00',
      description: 'Aluguel',
      category: 'Moradia',
      payment: 'Pix',
    });
    const market = createLookup(handle.db, 'category', 'Mercado');
    const card = createLookup(handle.db, 'payment', 'Cartão');

    const updated = updateTransaction(handle.db, transaction.id, {
      description: 'Aluguel atualizado',
      amount: 'R$ 250,50',
      dueDate: '2026-02-01',
      categoryId: market.id,
      paymentMethodId: card.id,
      installmentNumber: 2,
      installmentTotal: 5,
      transfer: 'Não',
    });

    expect(updated).toMatchObject({
      description: 'Aluguel atualizado',
      amountCents: 25050,
      dueDate: '2026-02-01',
      categoryName: 'Mercado',
      paymentMethodName: 'Cartão',
      installmentNumber: 2,
      installmentTotal: 5,
      transfer: null,
    });

    expectIssue(
      () => updateTransaction(handle.db, transaction.id, { amount: '1,250' }),
      /ambíguo/i,
    );
    expectIssue(
      () => updateTransaction(handle.db, transaction.id, { dueDate: '31/02/2026' }),
      /Data inválida/i,
    );
    expectIssue(
      () => updateTransaction(handle.db, transaction.id, { categoryId: 99999 }),
      /Categoria inválida/i,
    );
    expectIssue(
      () => updateTransaction(handle.db, transaction.id, { description: '   ' }),
      /Descrição obrigatória/i,
    );
  });

  it('rejeita categoria ou pagamento inexistente na criação', () => {
    expect(() =>
      createTransaction(handle.db, {
        purchaseDate: '2026-01-01',
        dueDate: '2026-01-02',
        description: 'Teste',
        amount: '-R$ 10,00',
        categoryId: 999,
        paymentMethodId: 888,
      }),
    ).toThrow(/inválid/i);
  });

  it('edita e exclui vários lançamentos de forma atômica', () => {
    const category = createLookup(handle.db, 'category', 'Antiga');
    const newCategory = createLookup(handle.db, 'category', 'Nova');
    const payment = createLookup(handle.db, 'payment', 'Pix');
    const newPayment = createLookup(handle.db, 'payment', 'Cartão');

    const ids = [1, 2, 3].map((day) =>
      createTransaction(handle.db, {
        purchaseDate: `2026-01-0${day}`,
        dueDate: `2026-01-0${day}`,
        description: `Compra ${day}`,
        amount: '-R$ 10,00',
        categoryId: category.id,
        paymentMethodId: payment.id,
      }).id,
    );

    expect(
      bulkUpdateTransactions(handle.db, ids, {
        categoryId: newCategory.id,
        paymentMethodId: newPayment.id,
      }),
    ).toBe(3);

    const afterUpdate = listTransactions(handle.db, {
      dateField: 'due',
      kind: 'all',
      sortBy: 'dueDate',
      sortDir: 'asc',
      page: 1,
      pageSize: 25,
    });
    expect(afterUpdate.rows.every((row) => row.categoryName === 'Nova')).toBe(true);
    expect(afterUpdate.rows.every((row) => row.paymentMethodName === 'Cartão')).toBe(true);

    expect(bulkDeleteTransactions(handle.db, ids.slice(0, 2))).toBe(2);
    expect(
      listTransactions(handle.db, {
        dateField: 'due',
        kind: 'all',
        sortBy: 'dueDate',
        sortDir: 'asc',
        page: 1,
        pageSize: 25,
      }).total,
    ).toBe(1);
  });

  it('exclui um lançamento individual', () => {
    const transaction = seedTransaction(handle.db, {
      dueDate: '2026-01-10',
      amount: '-R$ 10,00',
    });
    deleteTransaction(handle.db, transaction.id);
    expect(() => deleteTransaction(handle.db, transaction.id)).toThrow(/não encontrado/i);
  });

  it('mantém a categoria original ao garantir nomes equivalentes', () => {
    const first = ensureLookup(handle.db, 'category', 'Alimentação');
    const second = ensureLookup(handle.db, 'category', 'ALIMENTACAO');
    expect(second.id).toBe(first.id);
    expect(second.name).toBe('Alimentação');
  });
});
