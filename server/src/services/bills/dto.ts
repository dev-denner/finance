import { eq, inArray } from 'drizzle-orm';
import type { AppDatabase } from '../../db/client';
import {
  billPayments,
  categories,
  paymentMethods,
  scheduledBills,
  transactions,
} from '../../db/schema';

export type BillState = 'open' | 'paid' | 'skipped';

/** Derivado de `state` + datas; nunca gravado. */
export type BillDisplayStatus =
  | 'overdue'
  | 'due_today'
  | 'scheduled'
  | 'upcoming'
  | 'paid'
  | 'skipped';

export const BILL_DISPLAY_STATUSES: readonly BillDisplayStatus[] = [
  'overdue',
  'due_today',
  'scheduled',
  'upcoming',
  'paid',
  'skipped',
];

/** Situação legada exposta ao client atual ('' aberta, AG agendada, PG paga). Removida com a tela nova. */
export type LegacyBillStatus = '' | 'AG' | 'PG';

export type BillPaymentOrigin = 'manual' | 'import_match' | 'migration';

export interface BillPaymentDto {
  id: number;
  transactionId: number;
  amountCents: number;
  paidAt: string;
  origin: BillPaymentOrigin;
  /** true quando o lançamento foi criado pelo próprio pagamento (desfazer apaga). */
  createdTransaction: boolean;
  paymentMethodName: string | null;
  transactionDescription: string;
}

export interface BillDto {
  id: number;
  templateId: number | null;
  sequence: number | null;
  description: string;
  amountCents: number;
  dueDate: string;
  state: BillState;
  displayStatus: BillDisplayStatus;
  /** @deprecated compatibilidade com a tela atual. */
  status: LegacyBillStatus;
  scheduledFor: string | null;
  paidAt: string | null;
  paidCents: number | null;
  /** true quando o "pago" veio da migração do status PG, sem lançamento. */
  migratedPayment: boolean;
  categoryId: number;
  categoryName: string;
  paymentMethodId: number | null;
  paymentMethodName: string | null;
  notes: string | null;
  payments: BillPaymentDto[];
  /** @deprecated repetição manual legada. */
  repeatedFromId: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface BillSummary {
  /** Soma das contas não puladas. */
  totalCents: number;
  openCents: number;
  paidCents: number;
  overdueCents: number;
  statusCounts: Record<BillDisplayStatus, number>;
  /** @deprecated = openCents; compatibilidade com a tela atual. */
  unpaidCents: number;
  /** @deprecated contagem por situação legada; compatibilidade com a tela atual. */
  counts: { '': number; AG: number; PG: number };
}

export type BillRow = typeof scheduledBills.$inferSelect;

export interface JoinedBillRow {
  bill: BillRow;
  categoryName: string;
  paymentMethodName: string | null;
}

export function billSelection(db: AppDatabase) {
  return db
    .select({
      bill: scheduledBills,
      categoryName: categories.name,
      paymentMethodName: paymentMethods.name,
    })
    .from(scheduledBills)
    .innerJoin(categories, eq(scheduledBills.categoryId, categories.id))
    .leftJoin(paymentMethods, eq(scheduledBills.paymentMethodId, paymentMethods.id));
}

export function billState(value: string): BillState {
  if (value === 'paid' || value === 'skipped') return value;
  return 'open';
}

export function displayStatusOf(
  bill: Pick<BillRow, 'state' | 'dueDate' | 'scheduledFor'>,
  today: string,
): BillDisplayStatus {
  const state = billState(bill.state);
  if (state === 'paid') return 'paid';
  if (state === 'skipped') return 'skipped';
  if (bill.dueDate < today) return 'overdue';
  if (bill.dueDate === today) return 'due_today';
  if (bill.scheduledFor) return 'scheduled';
  return 'upcoming';
}

export function legacyStatusOf(bill: Pick<BillRow, 'state' | 'scheduledFor'>): LegacyBillStatus {
  const state = billState(bill.state);
  if (state === 'paid') return 'PG';
  if (state === 'open' && bill.scheduledFor) return 'AG';
  return '';
}

export function loadPayments(db: AppDatabase, billIds: number[]): Map<number, BillPaymentDto[]> {
  const result = new Map<number, BillPaymentDto[]>();
  if (billIds.length === 0) return result;
  const rows = db
    .select({
      payment: billPayments,
      transactionDescription: transactions.description,
      paymentMethodName: paymentMethods.name,
    })
    .from(billPayments)
    .innerJoin(transactions, eq(billPayments.transactionId, transactions.id))
    .leftJoin(paymentMethods, eq(transactions.paymentMethodId, paymentMethods.id))
    .where(inArray(billPayments.billId, billIds))
    .all();
  for (const row of rows) {
    const list = result.get(row.payment.billId) ?? [];
    list.push({
      id: row.payment.id,
      transactionId: row.payment.transactionId,
      amountCents: row.payment.amountCents,
      paidAt: row.payment.paidAt,
      origin: row.payment.origin as BillPaymentOrigin,
      createdTransaction: row.payment.createdTransaction === 1,
      paymentMethodName: row.paymentMethodName ?? null,
      transactionDescription: row.transactionDescription,
    });
    result.set(row.payment.billId, list);
  }
  return result;
}

export function toBillDto(
  row: JoinedBillRow,
  today: string,
  payments: BillPaymentDto[] = [],
): BillDto {
  const { bill } = row;
  return {
    id: bill.id,
    templateId: bill.templateId ?? null,
    sequence: bill.sequence ?? null,
    description: bill.description,
    amountCents: bill.amountCents,
    dueDate: bill.dueDate,
    state: billState(bill.state),
    displayStatus: displayStatusOf(bill, today),
    status: legacyStatusOf(bill),
    scheduledFor: bill.scheduledFor ?? null,
    paidAt: bill.paidAt ?? null,
    paidCents: bill.paidCents ?? null,
    migratedPayment: bill.migratedPayment === 1,
    categoryId: bill.categoryId,
    categoryName: row.categoryName,
    paymentMethodId: bill.paymentMethodId ?? null,
    paymentMethodName: row.paymentMethodName ?? null,
    notes: bill.notes ?? null,
    payments,
    repeatedFromId: bill.repeatedFromId ?? null,
    createdAt: bill.createdAt,
    updatedAt: bill.updatedAt,
  };
}

/** Converte linhas já carregadas em DTOs, anexando os pagamentos em uma única consulta. */
export function toBillDtos(db: AppDatabase, rows: JoinedBillRow[], today: string): BillDto[] {
  const payments = loadPayments(
    db,
    rows.map((row) => row.bill.id),
  );
  return rows.map((row) => toBillDto(row, today, payments.get(row.bill.id) ?? []));
}

export function emptySummary(): BillSummary {
  return {
    totalCents: 0,
    openCents: 0,
    paidCents: 0,
    overdueCents: 0,
    statusCounts: { overdue: 0, due_today: 0, scheduled: 0, upcoming: 0, paid: 0, skipped: 0 },
    unpaidCents: 0,
    counts: { '': 0, AG: 0, PG: 0 },
  };
}

export function summarize(bills: BillDto[]): BillSummary {
  const summary = emptySummary();
  for (const bill of bills) {
    summary.statusCounts[bill.displayStatus] += 1;
    summary.counts[bill.status] += 1;
    if (bill.state === 'skipped') continue;
    summary.totalCents += bill.amountCents;
    if (bill.state === 'paid') {
      summary.paidCents += bill.paidCents ?? bill.amountCents;
      continue;
    }
    summary.openCents += bill.amountCents;
    if (bill.displayStatus === 'overdue') summary.overdueCents += bill.amountCents;
  }
  summary.unpaidCents = summary.openCents;
  return summary;
}
