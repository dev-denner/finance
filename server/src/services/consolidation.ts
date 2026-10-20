import { and, eq, gte, lte, sql } from 'drizzle-orm';
import type { AppDatabase } from '../db/client';
import { categories, paymentMethods, transactions } from '../db/schema';
import type { DateField, TransactionKind } from './transactions';
import {
  applyKindCondition,
  categoryHasClassification,
  notLinkedTransfer,
  transferLikeCondition,
} from './transactions';

export interface ConsolidationCell {
  month: number;
  totalCents: number;
  transactionCount: number;
}

export interface ConsolidationRow {
  categoryId: number;
  categoryName: string;
  color: string | null;
  monthTotals: number[];
  monthCounts: number[];
  totalCents: number;
  averageCents: number;
  monthsWithData: number;
}

export interface ConsolidationResult {
  year: number;
  dateField: DateField;
  kind: TransactionKind;
  categories: ConsolidationRow[];
  totals: {
    monthTotals: number[];
    monthCounts: number[];
    totalCents: number;
    averageCents: number;
    monthsWithData: number;
  };
}

export interface AccountCashFlowRow {
  paymentMethodId: number;
  paymentMethodName: string;
  transactionCount: number;
  inCents: number;
  outCents: number;
  netCents: number;
  transferCents: number;
  cardSettlementCents: number;
}

export interface AccountCashFlowResult {
  year: number;
  dateField: DateField;
  rows: AccountCashFlowRow[];
  totals: {
    transactionCount: number;
    inCents: number;
    outCents: number;
    netCents: number;
    transferCents: number;
    cardSettlementCents: number;
  };
}

const EMPTY_MONTHS = () => Array.from({ length: 12 }, () => 0);

export function getAnnualConsolidation(
  db: AppDatabase,
  year: number,
  dateField: DateField,
  kind: Exclude<TransactionKind, 'all'>,
): ConsolidationResult {
  const dateColumn = dateField === 'purchase' ? transactions.purchaseDate : transactions.dueDate;
  const monthExpression = sql<number>`cast(substr(${dateColumn}, 6, 2) as integer)`;

  const conditions = [
    gte(dateColumn, `${year}-01-01`),
    lte(dateColumn, `${year}-12-31`),
  ];
  const kindCondition = applyKindCondition(kind);
  if (kindCondition) conditions.push(kindCondition);

  const grouped = db
    .select({
      categoryId: categories.id,
      categoryName: categories.name,
      color: categories.color,
      month: monthExpression,
      totalCents: sql<number>`coalesce(sum(${transactions.amountCents}), 0)`,
      transactionCount: sql<number>`count(*)`,
    })
    .from(transactions)
    .innerJoin(categories, eq(transactions.categoryId, categories.id))
    .where(and(...conditions))
    .groupBy(categories.id, categories.name, categories.color, monthExpression)
    .orderBy(sql`lower(${categories.name})`)
    .all();

  const byCategory = new Map<number, ConsolidationRow>();

  for (const entry of grouped) {
    const month = Number(entry.month);
    if (month < 1 || month > 12) continue;

    let row = byCategory.get(entry.categoryId);
    if (!row) {
      row = {
        categoryId: entry.categoryId,
        categoryName: entry.categoryName,
        color: entry.color,
        monthTotals: EMPTY_MONTHS(),
        monthCounts: EMPTY_MONTHS(),
        totalCents: 0,
        averageCents: 0,
        monthsWithData: 0,
      };
      byCategory.set(entry.categoryId, row);
    }

    const displayed = kind === 'income' ? entry.totalCents : Math.abs(entry.totalCents);
    row.monthTotals[month - 1] = displayed;
    row.monthCounts[month - 1] = entry.transactionCount;
    row.totalCents += displayed;
  }

  const rows = [...byCategory.values()];
  for (const row of rows) {
    row.monthsWithData = row.monthCounts.filter((count) => count > 0).length;
    row.averageCents =
      row.monthsWithData > 0 ? Math.round(row.totalCents / row.monthsWithData) : 0;
  }

  const monthTotals = EMPTY_MONTHS();
  const monthCounts = EMPTY_MONTHS();
  let grandTotal = 0;
  for (const row of rows) {
    for (let month = 0; month < 12; month += 1) {
      monthTotals[month] += row.monthTotals[month];
      monthCounts[month] += row.monthCounts[month];
    }
    grandTotal += row.totalCents;
  }
  const monthsWithData = monthCounts.filter((count) => count > 0).length;

  return {
    year,
    dateField,
    kind,
    categories: rows,
    totals: {
      monthTotals,
      monthCounts,
      totalCents: grandTotal,
      averageCents: monthsWithData > 0 ? Math.round(grandTotal / monthsWithData) : 0,
      monthsWithData,
    },
  };
}

/**
 * Fluxo de caixa por conta (forma de pagamento), incluindo transferências e
 * pagamentos de fatura. O resultado financeiro não é recalculado aqui: esta visão
 * mostra apenas o dinheiro que entrou e saiu de cada conta.
 */
export function getAccountCashFlow(
  db: AppDatabase,
  year: number,
  dateField: DateField,
): AccountCashFlowResult {
  const dateColumn = dateField === 'purchase' ? transactions.purchaseDate : transactions.dueDate;
  const conditions = [
    gte(dateColumn, `${year}-01-01`),
    lte(dateColumn, `${year}-12-31`),
  ];

  const grouped = db
    .select({
      paymentMethodId: paymentMethods.id,
      paymentMethodName: paymentMethods.name,
      transactionCount: sql<number>`count(*)`,
      inCents: sql<number>`coalesce(sum(case when ${transactions.amountCents} > 0 then ${transactions.amountCents} else 0 end), 0)`,
      outCents: sql<number>`coalesce(sum(case when ${transactions.amountCents} < 0 then -${transactions.amountCents} else 0 end), 0)`,
      netCents: sql<number>`coalesce(sum(${transactions.amountCents}), 0)`,
      transferCents: sql<number>`coalesce(sum(case when ${transferLikeCondition()} then abs(${transactions.amountCents}) else 0 end), 0)`,
      cardSettlementCents: sql<number>`coalesce(sum(case when ${transactions.amountCents} < 0 and ${transactions.transfer} is null and ${notLinkedTransfer()} and ${categoryHasClassification('card_settlement')} then -${transactions.amountCents} else 0 end), 0)`,
    })
    .from(transactions)
    .innerJoin(paymentMethods, eq(transactions.paymentMethodId, paymentMethods.id))
    .where(and(...conditions))
    .groupBy(paymentMethods.id, paymentMethods.name)
    .orderBy(sql`lower(${paymentMethods.name})`)
    .all();

  const rows: AccountCashFlowRow[] = grouped.map((row) => ({
    paymentMethodId: row.paymentMethodId,
    paymentMethodName: row.paymentMethodName,
    transactionCount: row.transactionCount,
    inCents: row.inCents,
    outCents: row.outCents,
    netCents: row.netCents,
    transferCents: row.transferCents,
    cardSettlementCents: row.cardSettlementCents,
  }));

  const totals = rows.reduce(
    (accumulator, row) => ({
      transactionCount: accumulator.transactionCount + row.transactionCount,
      inCents: accumulator.inCents + row.inCents,
      outCents: accumulator.outCents + row.outCents,
      netCents: accumulator.netCents + row.netCents,
      transferCents: accumulator.transferCents + row.transferCents,
      cardSettlementCents: accumulator.cardSettlementCents + row.cardSettlementCents,
    }),
    {
      transactionCount: 0,
      inCents: 0,
      outCents: 0,
      netCents: 0,
      transferCents: 0,
      cardSettlementCents: 0,
    },
  );

  return { year, dateField, rows, totals };
}
