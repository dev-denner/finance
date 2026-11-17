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

export interface ColumnSeriesData {
  key: string;
  label: string;
  color: string;
  values: number[];
}

export interface MonthColumn {
  year: number;
  month: number;
}

/** Previsto × pago por mês das contas a pagar (o "pago" inclui os parciais). */
export function billsPaidVsPlanned(
  forecast: { months: { year: number; month: number; summary: { totalCents: number; paidCents: number } }[] } | null,
): { months: MonthColumn[]; series: ColumnSeriesData[] } {
  const months = forecast?.months ?? [];
  return {
    months: months.map(({ year, month }) => ({ year, month })),
    series: [
      { key: 'planned', label: 'Previsto', color: 'var(--chart-series-1)', values: months.map((item) => item.summary.totalCents) },
      { key: 'paid', label: 'Pago', color: 'var(--chart-series-3)', values: months.map((item) => item.summary.paidCents) },
    ],
  };
}

/** Os `count` meses que terminam em `end` (inclusive), do mais antigo ao mais recente. */
export function lastMonths(end: MonthColumn, count: number): MonthColumn[] {
  return Array.from({ length: count }, (_, index) => {
    const total = end.year * 12 + (end.month - 1) - (count - 1 - index);
    return { year: Math.floor(total / 12), month: (total % 12) + 1 };
  });
}

const SUPPLIER_COLORS = ['var(--chart-series-1)', 'var(--chart-series-2)', 'var(--chart-series-3)', 'var(--chart-series-4)', 'var(--chart-series-5)'];

/**
 * Gasto em compras por mês, empilhado pelos maiores fornecedores da janela
 * (pelo CNPJ, ou pelo nome sem CNPJ) e "Outros". A cor segue o fornecedor
 * pela ordem do total, nunca pela posição na pilha de um mês.
 */
export function purchasesBySupplier(
  purchases: { supplierName: string; supplierCnpj: string; issuedAt: string; totalCents: number }[],
  months: MonthColumn[],
  top = 5,
): ColumnSeriesData[] {
  const index = new Map(months.map((month, position) => [`${month.year}-${String(month.month).padStart(2, '0')}`, position]));
  const suppliers = new Map<string, { label: string; latest: string; total: number; values: number[] }>();
  for (const purchase of purchases) {
    const position = index.get(purchase.issuedAt.slice(0, 7));
    if (position === undefined) continue;
    const key = purchase.supplierCnpj.replace(/\D/g, '') || purchase.supplierName.trim().toLowerCase();
    const entry = suppliers.get(key) ?? { label: purchase.supplierName, latest: '', total: 0, values: months.map(() => 0) };
    if (purchase.issuedAt > entry.latest) {
      entry.latest = purchase.issuedAt;
      entry.label = purchase.supplierName;
    }
    entry.total += purchase.totalCents;
    entry.values[position] += purchase.totalCents;
    suppliers.set(key, entry);
  }
  const ranked = [...suppliers.entries()].sort((a, b) => b[1].total - a[1].total || a[1].label.localeCompare(b[1].label));
  const shown = ranked.length > top ? ranked.slice(0, top) : ranked;
  const series: ColumnSeriesData[] = shown.map(([key, entry], position) => ({
    key,
    label: entry.label,
    color: SUPPLIER_COLORS[position],
    values: entry.values,
  }));
  const rest = ranked.slice(shown.length);
  if (rest.length > 0) {
    series.push({
      key: 'other',
      label: `Outros (${rest.length})`,
      color: 'var(--chart-other)',
      values: months.map((_, position) => rest.reduce((sum, [, entry]) => sum + entry.values[position], 0)),
    });
  }
  return series;
}
