import { describe, expect, it } from 'vitest';
import { formatAxisBRL, monthlyFlow, niceScale, topCategories } from './charts';
import type { ConsolidationResponse } from './types';

const totals = (monthTotals: number[]): Pick<ConsolidationResponse, 'totals'> => ({
  totals: { monthTotals, monthCounts: monthTotals.map(() => 1), totalCents: 0, averageCents: 0, monthsWithData: 0 },
});

function category(categoryId: number, categoryName: string, totalCents: number): ConsolidationResponse['categories'][number] {
  return { categoryId, categoryName, color: null, monthTotals: [], monthCounts: [], totalCents, averageCents: 0, monthsWithData: 1 };
}

describe('escala dos gráficos', () => {
  it('inclui o zero e usa passos redondos', () => {
    expect(niceScale(0, 4_930_000)).toEqual({ min: 0, max: 6_000_000, ticks: [0, 2_000_000, 4_000_000, 6_000_000] });
    expect(niceScale(-1_503_220, 4_930_000)).toMatchObject({ min: -2_000_000, max: 6_000_000 });
    expect(niceScale(0, 0)).toEqual({ min: 0, max: 1, ticks: [0, 1] });
    expect(niceScale(1000, 1000).min).toBe(0);
  });

  it('rótulos compactos em reais a partir de centavos', () => {
    expect(formatAxisBRL(0)).toBe('R$ 0');
    expect(formatAxisBRL(80_000)).toBe('R$ 800');
    expect(formatAxisBRL(2_000_000)).toBe('R$ 20 mil');
    expect(formatAxisBRL(-150_000)).toBe('-R$ 1,5 mil');
    expect(formatAxisBRL(150_000_000)).toBe('R$ 1,5 mi');
  });
});

describe('dados do consolidado', () => {
  it('entradas e saídas em módulo, saldo do mês e meses sem dado zerados', () => {
    const rows = monthlyFlow(totals([300_000, 0]), totals([-100_000, -50_000]));
    expect(rows).toHaveLength(12);
    expect(rows[0]).toEqual({ month: 1, inCents: 300_000, outCents: 100_000, netCents: 200_000 });
    expect(rows[1]).toEqual({ month: 2, inCents: 0, outCents: 50_000, netCents: -50_000 });
    expect(rows[11]).toEqual({ month: 12, inCents: 0, outCents: 0, netCents: 0 });
    expect(monthlyFlow(null, null).every((row) => row.netCents === 0)).toBe(true);
  });

  it('maiores categorias em ordem, com as menores somadas em "Outras"', () => {
    const categories = [
      category(1, 'Mercado', -50_000),
      category(2, 'Moradia', -100_000),
      category(3, 'Lazer', -10_000),
      category(4, 'Saúde', -30_000),
      category(5, 'Vazia', 0),
    ];
    expect(topCategories(categories, 3)).toEqual([
      { key: '2', label: 'Moradia', cents: 100_000, share: 100_000 / 190_000, categoryId: 2 },
      { key: '1', label: 'Mercado', cents: 50_000, share: 50_000 / 190_000, categoryId: 1 },
      { key: 'other', label: 'Outras (2)', cents: 40_000, share: 40_000 / 190_000, categoryId: null },
    ]);
    expect(topCategories(categories, 8).map((item) => item.label)).toEqual(['Moradia', 'Mercado', 'Saúde', 'Lazer']);
    expect(topCategories([], 8)).toEqual([]);
  });
});
