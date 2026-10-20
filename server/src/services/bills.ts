import { eq } from 'drizzle-orm';
import type { AppDatabase } from '../db/client';
import { categories, scheduledBills } from '../db/schema';
import { parseDateValue } from '../lib/dates';
import { badRequest, notFound, nowIso } from '../lib/errors';
import { parseAmountToCents } from '../lib/money';
import { displayName, EMPTY_CATEGORY_NAME, normalizeName } from '../lib/normalize';
import { ensureLookup } from './lookups';
import { readWorkbook } from './import';

export type BillStatus = '' | 'AG' | 'PG';

export interface BillDto {
  id: number;
  description: string;
  amountCents: number;
  dueDate: string;
  status: BillStatus;
  categoryId: number;
  categoryName: string;
  repeatedFromId: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface BillSummary {
  totalCents: number;
  unpaidCents: number;
  paidCents: number;
  counts: { '': number; AG: number; PG: number };
}

export interface BillWriteInput {
  description?: unknown;
  amountCents?: unknown;
  amount?: unknown;
  dueDate?: unknown;
  categoryId?: unknown;
  status?: unknown;
}

const BILL_STATUSES: BillStatus[] = ['', 'AG', 'PG'];

function toDto(row: {
  bill: typeof scheduledBills.$inferSelect;
  categoryName: string;
}): BillDto {
  return {
    id: row.bill.id,
    description: row.bill.description,
    amountCents: row.bill.amountCents,
    dueDate: row.bill.dueDate,
    status: (row.bill.status as BillStatus) ?? '',
    categoryId: row.bill.categoryId,
    categoryName: row.categoryName,
    repeatedFromId: row.bill.repeatedFromId ?? null,
    createdAt: row.bill.createdAt,
    updatedAt: row.bill.updatedAt,
  };
}

function loadJoined(db: AppDatabase, id: number) {
  const row = db
    .select({ bill: scheduledBills, categoryName: categories.name })
    .from(scheduledBills)
    .innerJoin(categories, eq(scheduledBills.categoryId, categories.id))
    .where(eq(scheduledBills.id, id))
    .get();
  if (!row) throw notFound('Conta a pagar não encontrada.');
  return toDto(row);
}

function parseBillInput(db: AppDatabase, input: BillWriteInput, existing?: typeof scheduledBills.$inferSelect) {
  const descriptionRaw = input.description !== undefined ? input.description : existing?.description;
  const description = displayName(String(descriptionRaw ?? ''));
  if (!description) throw badRequest('Informe a descrição da conta.');

  let amountCents: number;
  if (input.amountCents !== undefined) {
    const value = Number(input.amountCents);
    if (!Number.isInteger(value) || value <= 0) throw badRequest('O valor deve ser positivo.');
    amountCents = value;
  } else if (input.amount !== undefined) {
    const parsed = parseAmountToCents(input.amount);
    if (!parsed.ok) throw badRequest(parsed.error);
    if (parsed.value <= 0) throw badRequest('O valor deve ser positivo.');
    amountCents = parsed.value;
  } else if (existing) {
    amountCents = existing.amountCents;
  } else {
    throw badRequest('Informe o valor da conta.');
  }

  const dueDateRaw = input.dueDate !== undefined ? input.dueDate : existing?.dueDate;
  const dueDate = parseDateValue(dueDateRaw);
  if (!dueDate.ok) throw badRequest(dueDate.error);

  let categoryId: number;
  if (input.categoryId !== undefined) {
    const id = Number(input.categoryId);
    if (!Number.isInteger(id) || id <= 0) throw badRequest('Categoria inválida.');
    const found = db.select().from(categories).where(eq(categories.id, id)).get();
    if (!found) throw badRequest('Categoria não encontrada.');
    categoryId = id;
  } else if (existing) {
    categoryId = existing.categoryId;
  } else {
    throw badRequest('Informe a categoria da conta.');
  }

  let status: BillStatus = (existing?.status as BillStatus) ?? '';
  if (input.status !== undefined) {
    const value = String(input.status ?? '').trim().toUpperCase();
    if (!BILL_STATUSES.includes(value as BillStatus)) {
      throw badRequest('Situação inválida. Use "", "AG" ou "PG".');
    }
    status = value as BillStatus;
  }

  return {
    description,
    amountCents,
    dueDate: dueDate.value,
    categoryId,
    status,
  };
}

export function listBills(db: AppDatabase, year: number, month: number): { bills: BillDto[]; summary: BillSummary } {
  const monthKey = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`;
  const rows = db
    .select({ bill: scheduledBills, categoryName: categories.name })
    .from(scheduledBills)
    .innerJoin(categories, eq(scheduledBills.categoryId, categories.id))
    .all()
    .filter((row) => row.bill.dueDate.startsWith(monthKey))
    .sort((a, b) => {
      if (a.bill.dueDate !== b.bill.dueDate) return a.bill.dueDate.localeCompare(b.bill.dueDate);
      return a.bill.id - b.bill.id;
    });

  const bills = rows.map(toDto);
  const summary: BillSummary = {
    totalCents: 0,
    unpaidCents: 0,
    paidCents: 0,
    counts: { '': 0, AG: 0, PG: 0 },
  };
  for (const bill of bills) {
    summary.totalCents += bill.amountCents;
    if (bill.status === 'PG') {
      summary.paidCents += bill.amountCents;
    } else {
      summary.unpaidCents += bill.amountCents;
    }
    summary.counts[bill.status] += 1;
  }
  return { bills, summary };
}

export function getBill(db: AppDatabase, id: number): BillDto {
  return loadJoined(db, id);
}

export function createBill(db: AppDatabase, input: BillWriteInput): BillDto {
  const parsed = parseBillInput(db, input);
  const timestamp = nowIso();
  const created = db
    .insert(scheduledBills)
    .values({
      description: parsed.description,
      amountCents: parsed.amountCents,
      dueDate: parsed.dueDate,
      status: parsed.status,
      categoryId: parsed.categoryId,
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    .returning()
    .get();
  return loadJoined(db, created.id);
}

export function updateBill(db: AppDatabase, id: number, input: BillWriteInput): BillDto {
  const existing = db.select().from(scheduledBills).where(eq(scheduledBills.id, id)).get();
  if (!existing) throw notFound('Conta a pagar não encontrada.');
  const parsed = parseBillInput(db, input, existing);
  db
    .update(scheduledBills)
    .set({
      description: parsed.description,
      amountCents: parsed.amountCents,
      dueDate: parsed.dueDate,
      status: parsed.status,
      categoryId: parsed.categoryId,
      updatedAt: nowIso(),
    })
    .where(eq(scheduledBills.id, id))
    .run();
  return loadJoined(db, id);
}

export function deleteBill(db: AppDatabase, id: number): { removed: true } {
  const removed = db
    .delete(scheduledBills)
    .where(eq(scheduledBills.id, id))
    .returning({ id: scheduledBills.id })
    .get();
  if (!removed) throw notFound('Conta a pagar não encontrada.');
  return { removed: true };
}

export function setBillStatus(
  db: AppDatabase,
  id: number,
  status: unknown,
): { bill: BillDto; promptRepeat: boolean; existingRepeatId: number | null } {
  const existing = db.select().from(scheduledBills).where(eq(scheduledBills.id, id)).get();
  if (!existing) throw notFound('Conta a pagar não encontrada.');

  const value = String(status ?? '').trim().toUpperCase();
  if (!BILL_STATUSES.includes(value as BillStatus)) {
    throw badRequest('Situação inválida. Use "", "AG" ou "PG".');
  }
  const newStatus = value as BillStatus;
  const wasPaid = existing.status === 'PG';
  const becomingPaid = newStatus === 'PG' && !wasPaid;

  db
    .update(scheduledBills)
    .set({ status: newStatus, updatedAt: nowIso() })
    .where(eq(scheduledBills.id, id))
    .run();

  const existingRepeat = db
    .select({ id: scheduledBills.id })
    .from(scheduledBills)
    .where(eq(scheduledBills.repeatedFromId, id))
    .get();

  return {
    bill: loadJoined(db, id),
    promptRepeat: becomingPaid,
    existingRepeatId: existingRepeat?.id ?? null,
  };
}

function addMonths(date: string, months: number): string {
  const match = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw badRequest('Data de vencimento inválida.');
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const totalMonths = year * 12 + (month - 1) + months;
  const targetYear = Math.floor(totalMonths / 12);
  const targetMonth = (((totalMonths % 12) + 12) % 12) + 1;
  // clamp day
  const daysInMonth = (y: number, m: number) => {
    if (m === 2) {
      const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
      return leap ? 29 : 28;
    }
    if (m === 4 || m === 6 || m === 9 || m === 11) return 30;
    return 31;
  };
  const targetDay = Math.min(day, daysInMonth(targetYear, targetMonth));
  return `${targetYear.toString().padStart(4, '0')}-${targetMonth
    .toString()
    .padStart(2, '0')}-${targetDay.toString().padStart(2, '0')}`;
}

export function repeatBill(db: AppDatabase, sourceId: number): { bill: BillDto; created: boolean } {
  const source = db.select().from(scheduledBills).where(eq(scheduledBills.id, sourceId)).get();
  if (!source) throw notFound('Conta a pagar não encontrada.');

  const existing = db
    .select({ id: scheduledBills.id })
    .from(scheduledBills)
    .where(eq(scheduledBills.repeatedFromId, sourceId))
    .get();
  if (existing) {
    return { bill: loadJoined(db, existing.id), created: false };
  }

  const timestamp = nowIso();
  const created = db
    .insert(scheduledBills)
    .values({
      description: source.description,
      amountCents: source.amountCents,
      dueDate: addMonths(source.dueDate, 1),
      status: '',
      categoryId: source.categoryId,
      repeatedFromId: source.id,
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    .returning()
    .get();
  return { bill: loadJoined(db, created.id), created: true };
}

export function advanceMonth(date: string): string {
  return addMonths(date, 1);
}
