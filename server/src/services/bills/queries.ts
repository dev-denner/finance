import { and, asc, eq, gt, gte, lt, lte, sql, type SQL } from 'drizzle-orm';
import type { AppDatabase } from '../../db/client';
import { scheduledBills } from '../../db/schema';
import { addMonthsIso, todayIso } from '../../lib/dates';
import { badRequest } from '../../lib/errors';
import { normalizeName } from '../../lib/normalize';
import {
  billSelection,
  summarize,
  toBillDtos,
  type BillDto,
  type BillState,
  type BillSummary,
} from './dto';
import { ensureAllOccurrences } from './templates';

export interface BillListOptions {
  state?: BillState | 'all';
  search?: string;
  categoryId?: number;
  /** Data de referência para o status derivado (padrão: hoje). */
  today?: string;
}

export interface BillListResult {
  bills: BillDto[];
  summary: BillSummary;
}

export interface BillAgenda {
  today: string;
  days: number;
  overdue: BillDto[];
  dueToday: BillDto[];
  upcoming: BillDto[];
  summary: BillSummary;
}

function addDays(iso: string, days: number): string {
  const [year, month, day] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day) + days * 86_400_000);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(
    date.getUTCDate(),
  ).padStart(2, '0')}`;
}

function filterConditions(options: BillListOptions): SQL[] {
  const conditions: SQL[] = [];
  if (options.state && options.state !== 'all') {
    conditions.push(eq(scheduledBills.state, options.state));
  }
  if (options.categoryId !== undefined) {
    conditions.push(eq(scheduledBills.categoryId, options.categoryId));
  }
  const search = options.search ? normalizeName(options.search) : '';
  if (search) {
    conditions.push(sql`normalize_search(${scheduledBills.description}) like ${`%${search}%`}`);
  }
  return conditions;
}

function queryBills(db: AppDatabase, conditions: SQL[], today: string): BillDto[] {
  const rows = billSelection(db)
    .where(and(...conditions))
    .orderBy(asc(scheduledBills.dueDate), asc(scheduledBills.id))
    .all();
  return toBillDtos(db, rows, today);
}

/** Contas com vencimento no intervalo (inclusive). Garante as ocorrências das recorrências antes. */
export function listBillsBetween(
  db: AppDatabase,
  from: string,
  to: string,
  options: BillListOptions = {},
): BillListResult {
  if (from > to) throw badRequest('Intervalo de datas inválido.');
  const today = options.today ?? todayIso();
  ensureAllOccurrences(db, today);
  const bills = queryBills(
    db,
    [gte(scheduledBills.dueDate, from), lte(scheduledBills.dueDate, to), ...filterConditions(options)],
    today,
  );
  return { bills, summary: summarize(bills) };
}

export function listBills(
  db: AppDatabase,
  year: number,
  month: number,
  options: BillListOptions = {},
): BillListResult {
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    throw badRequest('Mês ou ano inválido.');
  }
  const start = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-01`;
  const next = addMonthsIso(start, 1);
  if (!next) throw badRequest('Mês ou ano inválido.');
  return listBillsBetween(db, start, addDays(next, -1), options);
}

/** Atrasadas, de hoje e dos próximos `days` dias — só contas em aberto. */
export function getAgenda(
  db: AppDatabase,
  options: { days?: number; today?: string } = {},
): BillAgenda {
  const days = options.days ?? 7;
  if (!Number.isInteger(days) || days < 1 || days > 60) {
    throw badRequest('Informe entre 1 e 60 dias.');
  }
  const today = options.today ?? todayIso();
  ensureAllOccurrences(db, today);
  const open = eq(scheduledBills.state, 'open');
  const overdue = queryBills(db, [open, lt(scheduledBills.dueDate, today)], today);
  const dueToday = queryBills(db, [open, eq(scheduledBills.dueDate, today)], today);
  const upcoming = queryBills(
    db,
    [open, gt(scheduledBills.dueDate, today), lte(scheduledBills.dueDate, addDays(today, days))],
    today,
  );
  return {
    today,
    days,
    overdue,
    dueToday,
    upcoming,
    summary: summarize([...overdue, ...dueToday, ...upcoming]),
  };
}
