import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseHandle } from '../src/db/client';
import { listLookups } from '../src/services/lookups';
import { listTransactions } from '../src/services/transactions';
import { createTestDatabase, seedTransaction } from './helpers';

describe('ordenação por categoria e forma de pagamento', () => {
  let handle: DatabaseHandle;

  beforeEach(() => {
    handle = createTestDatabase();
  });

  afterEach(() => {
    handle.sqlite.close();
  });

  function seedAll() {
    seedTransaction(handle.db, {
      dueDate: '2026-01-01',
      amount: '-R$ 10,00',
      description: 'Compra Zebra',
      category: 'Zebra',
      payment: 'Visa',
    });
    seedTransaction(handle.db, {
      dueDate: '2026-01-02',
      amount: '-R$ 20,00',
      description: 'Compra Abacaxi',
      category: 'Abacaxi',
      payment: 'Amex',
    });
    seedTransaction(handle.db, {
      dueDate: '2026-01-03',
      amount: '-R$ 30,00',
      description: 'Compra Ábaco',
      category: 'Ábaco',
      payment: 'Master',
    });
    seedTransaction(handle.db, {
      dueDate: '2026-01-04',
      amount: '-R$ 40,00',
      description: 'Compra Manga',
      category: 'Manga',
      payment: 'Visa',
    });
    seedTransaction(handle.db, {
      dueDate: '2026-01-05',
      amount: '-R$ 50,00',
      description: 'Compra Banana',
      category: 'Abacaxi',
      payment: 'Amex',
    });
  }

  const base = {
    dateField: 'due' as const,
    kind: 'all' as const,
    page: 1,
    pageSize: 25,
  };

  it('ordena por categoria em ordem crescente (A–Z) e decrescente (Z–A)', () => {
    seedAll();

    const asc = listTransactions(handle.db, {
      ...base,
      sortBy: 'categoryName',
      sortDir: 'asc',
    });
    expect(asc.rows.map((row) => row.categoryName)).toEqual([
      'Abacaxi',
      'Abacaxi',
      'Ábaco',
      'Manga',
      'Zebra',
    ]);

    const desc = listTransactions(handle.db, {
      ...base,
      sortBy: 'categoryName',
      sortDir: 'desc',
    });
    expect(desc.rows.map((row) => row.categoryName)).toEqual([
      'Zebra',
      'Manga',
      'Ábaco',
      'Abacaxi',
      'Abacaxi',
    ]);
  });

  it('ordena pelo nome da forma de pagamento', () => {
    seedAll();

    const asc = listTransactions(handle.db, {
      ...base,
      sortBy: 'paymentMethodName',
      sortDir: 'asc',
    });
    expect(asc.rows.map((row) => row.paymentMethodName)).toEqual([
      'Amex',
      'Amex',
      'Master',
      'Visa',
      'Visa',
    ]);

    const desc = listTransactions(handle.db, {
      ...base,
      sortBy: 'paymentMethodName',
      sortDir: 'desc',
    });
    expect(desc.rows.map((row) => row.paymentMethodName)).toEqual([
      'Visa',
      'Visa',
      'Master',
      'Amex',
      'Amex',
    ]);
  });

  it('mantém a ordenação ao longo das páginas, não apenas na página visível', () => {
    seedAll();

    const page1 = listTransactions(handle.db, {
      ...base,
      sortBy: 'categoryName',
      sortDir: 'asc',
      page: 1,
      pageSize: 2,
    });
    const page2 = listTransactions(handle.db, {
      ...base,
      sortBy: 'categoryName',
      sortDir: 'asc',
      page: 2,
      pageSize: 2,
    });
    const page3 = listTransactions(handle.db, {
      ...base,
      sortBy: 'categoryName',
      sortDir: 'asc',
      page: 3,
      pageSize: 2,
    });

    expect(page1.total).toBe(5);
    expect(page1.totalPages).toBe(3);
    const inOrder = [...page1.rows, ...page2.rows, ...page3.rows].map((row) => row.categoryName);
    expect(inOrder).toEqual(['Abacaxi', 'Abacaxi', 'Ábaco', 'Manga', 'Zebra']);
  });

  it('preserva os filtros ao ordenar por categoria e pagamento', () => {
    seedAll();
    const abacaxi = listLookups(handle.db, 'category').find((item) => item.name === 'Abacaxi')!;

    const filtered = listTransactions(handle.db, {
      ...base,
      categoryId: abacaxi.id,
      sortBy: 'paymentMethodName',
      sortDir: 'desc',
    });

    expect(filtered.total).toBe(2);
    expect(filtered.rows.every((row) => row.categoryName === 'Abacaxi')).toBe(true);
    expect(filtered.rows.map((row) => row.paymentMethodName)).toEqual(['Amex', 'Amex']);

    const byCategory = listTransactions(handle.db, {
      ...base,
      search: 'Banana',
      sortBy: 'categoryName',
      sortDir: 'asc',
    });
    expect(byCategory.total).toBe(1);
    expect(byCategory.rows[0].categoryName).toBe('Abacaxi');
  });
});
