import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseHandle } from '../src/db/client';
import { getAnnualConsolidation } from '../src/services/consolidation';
import { createTestDatabase, seedTransaction } from './helpers';

describe('consolidado anual', () => {
  let handle: DatabaseHandle;

  beforeEach(() => {
    handle = createTestDatabase();
  });

  afterEach(() => {
    handle.sqlite.close();
  });

  function row(name: string, kind: 'expenses' | 'income' | 'transfers' = 'expenses') {
    const found = getAnnualConsolidation(handle.db, 2026, 'due', kind).categories.find(
      (item) => item.categoryName === name,
    );
    if (!found) throw new Error(`Categoria ${name} não encontrada no consolidado.`);
    return found;
  }

  it('agrupa despesas por categoria e mês, exibindo valores absolutos', () => {
    seedTransaction(handle.db, {
      dueDate: '2026-01-05',
      amount: '-R$ 100,00',
      description: 'Mercado 1',
      category: 'Mercado',
    });
    seedTransaction(handle.db, {
      dueDate: '2026-01-20',
      amount: '-R$ 50,00',
      description: 'Mercado 2',
      category: 'Mercado',
    });
    seedTransaction(handle.db, {
      dueDate: '2026-02-10',
      amount: '-R$ 200,00',
      description: 'Mercado 3',
      category: 'Mercado',
    });
    seedTransaction(handle.db, {
      dueDate: '2026-03-10',
      amount: '-R$ 100,00',
      description: 'Mercado 4',
      category: 'Mercado',
    });
    // Crédito no mesmo mês: não entra no relatório de despesas.
    seedTransaction(handle.db, {
      dueDate: '2026-03-12',
      amount: 'R$ 40,00',
      description: 'Estorno',
      category: 'Mercado',
    });
    seedTransaction(handle.db, {
      dueDate: '2026-01-31',
      amount: 'R$ 5.000,00',
      description: 'Salário janeiro',
      category: 'Salário',
    });

    const result = getAnnualConsolidation(handle.db, 2026, 'due', 'expenses');
    expect(result.year).toBe(2026);
    expect(result.kind).toBe('expenses');
    expect(result.categories.map((item) => item.categoryName)).toEqual(['Mercado']);

    const mercado = row('Mercado');
    expect(mercado.monthTotals).toEqual([15000, 20000, 10000, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(mercado.monthCounts).toEqual([2, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(mercado.totalCents).toBe(45000);
    expect(mercado.monthsWithData).toBe(3);
    expect(mercado.averageCents).toBe(15000);
  });

  it('mantém receitas com sinal próprio e separa transferências das despesas', () => {
    seedTransaction(handle.db, {
      dueDate: '2026-01-10',
      amount: '-R$ 300,00',
      description: 'Aplicação',
      category: 'Investimentos',
      transfer: 'Sim',
    });
    seedTransaction(handle.db, {
      dueDate: '2026-01-15',
      amount: 'R$ 4.000,00',
      description: 'Salário',
      category: 'Salário',
    });
    seedTransaction(handle.db, {
      dueDate: '2026-02-15',
      amount: 'R$ 3.500,50',
      description: 'Salário',
      category: 'Salário',
    });
    seedTransaction(handle.db, {
      dueDate: '2026-02-20',
      amount: '-R$ 80,00',
      description: 'Farmacia',
      category: 'Saúde',
    });

    const income = getAnnualConsolidation(handle.db, 2026, 'due', 'income');
    expect(income.categories.map((item) => item.categoryName)).toEqual(['Salário']);
    expect(income.categories[0].monthTotals).toEqual([
      400000, 350050, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ]);
    expect(income.categories[0].totalCents).toBe(750050);
    expect(income.categories[0].averageCents).toBe(375025);
    expect(income.totals.totalCents).toBe(750050);

    const expenses = getAnnualConsolidation(handle.db, 2026, 'due', 'expenses');
    expect(expenses.categories.map((item) => item.categoryName)).toEqual(['Saúde']);
    expect(expenses.totals.totalCents).toBe(8000);

    const transfers = getAnnualConsolidation(handle.db, 2026, 'due', 'transfers');
    expect(transfers.categories.map((item) => item.categoryName)).toEqual(['Investimentos']);
    expect(transfers.categories[0].monthTotals[0]).toBe(30000);
    expect(transfers.totals.totalCents).toBe(30000);
  });

  it('calcula a média apenas nos meses com movimento, inclusive quando o líquido é zero', () => {
    seedTransaction(handle.db, {
      dueDate: '2026-01-05',
      amount: '-R$ 100,00',
      description: 'Saída',
      category: 'Ajustes',
      transfer: 'Sim',
    });
    seedTransaction(handle.db, {
      dueDate: '2026-01-06',
      amount: 'R$ 100,00',
      description: 'Entrada equivalente',
      category: 'Ajustes',
      transfer: 'Sim',
    });
    seedTransaction(handle.db, {
      dueDate: '2026-02-05',
      amount: '-R$ 90,00',
      description: 'Saída',
      category: 'Ajustes',
      transfer: 'Sim',
    });

    const ajustes = row('Ajustes', 'transfers');
    expect(ajustes.monthTotals[0]).toBe(0);
    expect(ajustes.monthCounts[0]).toBe(2);
    expect(ajustes.monthTotals[1]).toBe(9000);
    expect(ajustes.monthsWithData).toBe(2);
    expect(ajustes.totalCents).toBe(9000);
    expect(ajustes.averageCents).toBe(4500);
    expect(ajustes.monthTotals.slice(2)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('respeita o campo de data escolhido e os totais gerais', () => {
    seedTransaction(handle.db, {
      purchaseDate: '2025-12-28',
      dueDate: '2026-01-10',
      amount: '-R$ 120,00',
      description: 'Compra de dezembro',
      category: 'Mercado',
    });
    seedTransaction(handle.db, {
      purchaseDate: '2026-01-20',
      dueDate: '2026-02-10',
      amount: '-R$ 80,00',
      description: 'Compra de janeiro',
      category: 'Mercado',
    });

    const byDue = getAnnualConsolidation(handle.db, 2026, 'due', 'expenses');
    expect(byDue.categories[0].monthTotals[0]).toBe(12000);
    expect(byDue.categories[0].monthTotals[1]).toBe(8000);
    expect(byDue.totals.monthTotals[0]).toBe(12000);
    expect(byDue.totals.monthTotals[1]).toBe(8000);
    expect(byDue.totals.totalCents).toBe(20000);
    expect(byDue.totals.averageCents).toBe(10000);

    const byPurchase = getAnnualConsolidation(handle.db, 2026, 'purchase', 'expenses');
    expect(byPurchase.categories[0].monthTotals[0]).toBe(8000);
    expect(byPurchase.totals.totalCents).toBe(8000);

    const previousYear = getAnnualConsolidation(handle.db, 2025, 'purchase', 'expenses');
    expect(previousYear.totals.totalCents).toBe(12000);
    expect(previousYear.totals.monthTotals[11]).toBe(12000);

    const emptyYear = getAnnualConsolidation(handle.db, 2024, 'due', 'expenses');
    expect(emptyYear.categories).toEqual([]);
    expect(emptyYear.totals.totalCents).toBe(0);
    expect(emptyYear.totals.monthTotals).toEqual(Array.from({ length: 12 }, () => 0));
    expect(emptyYear.totals.averageCents).toBe(0);
    expect(emptyYear.totals.monthsWithData).toBe(0);
  });

  it('soma os totais gerais a partir das categorias e ordena por nome', () => {
    seedTransaction(handle.db, {
      dueDate: '2026-05-05',
      amount: '-R$ 50,00',
      description: 'Transporte',
      category: 'Transporte',
    });
    seedTransaction(handle.db, {
      dueDate: '2026-05-06',
      amount: '-R$ 70,00',
      description: 'Alimentação',
      category: 'alimentação',
    });
    seedTransaction(handle.db, {
      dueDate: '2026-06-06',
      amount: '-R$ 30,00',
      description: 'Alimentação',
      category: 'alimentação',
    });

    const result = getAnnualConsolidation(handle.db, 2026, 'due', 'expenses');
    expect(result.categories.map((item) => item.categoryName)).toEqual([
      'alimentação',
      'Transporte',
    ]);
    expect(result.totals.monthTotals[4]).toBe(12000);
    expect(result.totals.monthTotals[5]).toBe(3000);
    expect(result.totals.monthCounts[4]).toBe(2);
    expect(result.totals.totalCents).toBe(15000);
    expect(result.totals.monthsWithData).toBe(2);
    expect(result.totals.averageCents).toBe(7500);
    expect(result.categories[0].averageCents).toBe(5000);
    expect(result.categories[1].averageCents).toBe(5000);
  });
});
