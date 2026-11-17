/**
 * Lógica dos gráficos, sem React: escalas com marcas redondas, rótulos
 * compactos de eixo e a preparação dos dados do consolidado.
 */
import type { ConsolidationResponse } from './types';

export interface NiceScale {
  min: number;
  max: number;
  ticks: number[];
}

/** Escala que inclui o zero, com 3 a 6 marcas em passos 1, 2, 2,5 ou 5 × 10ⁿ. */
export function niceScale(minValue: number, maxValue: number, targetTicks = 4): NiceScale {
  const low = Math.min(0, minValue);
  const high = Math.max(0, maxValue);
  if (low === high) return { min: 0, max: 1, ticks: [0, 1] };
  const raw = (high - low) / targetTicks;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((factor) => factor * magnitude).find((candidate) => candidate >= raw) ?? 10 * magnitude;
  const min = Math.floor(low / step) * step;
  const max = Math.ceil(high / step) * step;
  const ticks: number[] = [];
  for (let value = min; value <= max + step / 2; value += step) ticks.push(Math.round(value * 1e6) / 1e6);
  return { min, max, ticks };
}

/** Rótulo de eixo em reais a partir de centavos: "R$ 0", "R$ 800", "R$ 12 mil", "R$ 1,5 mi". */
export function formatAxisBRL(cents: number): string {
  const reais = cents / 100;
  const abs = Math.abs(reais);
  const sign = reais < 0 ? '-' : '';
  const trim = (value: number) => value.toFixed(1).replace(/\.0$/, '').replace('.', ',');
  if (abs >= 1_000_000) return `${sign}R$ ${trim(abs / 1_000_000)} mi`;
  if (abs >= 1_000) return `${sign}R$ ${trim(abs / 1_000)} mil`;
  return `${sign}R$ ${Math.round(abs)}`;
}

export interface MonthlyFlow {
  month: number;
  inCents: number;
  outCents: number;
  /** Entradas menos saídas no mês. */
  netCents: number;
}

/** Entradas, saídas (em módulo) e saldo de cada mês, a partir do consolidado de receitas e de despesas. */
export function monthlyFlow(
  income: Pick<ConsolidationResponse, 'totals'> | null,
  expenses: Pick<ConsolidationResponse, 'totals'> | null,
): MonthlyFlow[] {
  return Array.from({ length: 12 }, (_, index) => {
    const inCents = Math.abs(income?.totals.monthTotals[index] ?? 0);
    const outCents = Math.abs(expenses?.totals.monthTotals[index] ?? 0);
    return { month: index + 1, inCents, outCents, netCents: inCents - outCents };
  });
}

export interface CategoryShare {
  key: string;
  label: string;
  cents: number;
  /** Fração do total, de 0 a 1. */
  share: number;
  categoryId: number | null;
}

/** As maiores categorias do ano em módulo; a partir de `limit`, o resto vira "Outras". */
export function topCategories(categories: ConsolidationResponse['categories'], limit = 8): CategoryShare[] {
  const sorted = categories
    .map((category) => ({ ...category, cents: Math.abs(category.totalCents) }))
    .filter((category) => category.cents > 0)
    .sort((a, b) => b.cents - a.cents || a.categoryName.localeCompare(b.categoryName));
  const total = sorted.reduce((sum, category) => sum + category.cents, 0);
  if (total === 0) return [];
  const shown = sorted.length > limit ? sorted.slice(0, limit - 1) : sorted;
  const rest = sorted.slice(shown.length);
  const items: CategoryShare[] = shown.map((category) => ({
    key: String(category.categoryId),
    label: category.categoryName,
    cents: category.cents,
    share: category.cents / total,
    categoryId: category.categoryId,
  }));
  if (rest.length > 0) {
    const cents = rest.reduce((sum, category) => sum + category.cents, 0);
    items.push({ key: 'other', label: `Outras (${rest.length})`, cents, share: cents / total, categoryId: null });
  }
  return items;
}
