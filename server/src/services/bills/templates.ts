import { and, eq, gt, gte, notInArray, or, sql, type SQL } from 'drizzle-orm';
import type { AppDatabase } from '../../db/client';
import { billPayments, billTemplates, categories, scheduledBills } from '../../db/schema';
import { addMonthsIso, parseDateValue, todayIso } from '../../lib/dates';
import { badRequest, notFound, nowIso } from '../../lib/errors';
import { displayName } from '../../lib/normalize';
import { assertCategory, assertPaymentMethod, parseAmountInput, parseNotes } from './occurrences';
import {
  describeRecurrence,
  isValidIsoDate,
  nextOccurrenceDates,
  validateRecurrence,
  type BillFrequency,
  type BillRecurrence,
  type OccurrenceDate,
} from './recurrence';

/** Quantos meses à frente as ocorrências de uma recorrência sem fim são materializadas. */
export const OCCURRENCE_HORIZON_MONTHS = 12;

export interface BillTemplateDto {
  id: number;
  description: string;
  amountCents: number;
  amountMinCents: number | null;
  amountMaxCents: number | null;
  categoryId: number;
  categoryName: string;
  paymentMethodId: number | null;
  recurrence: BillRecurrence;
  recurrenceLabel: string;
  startDate: string;
  endDate: string | null;
  occurrenceCount: number | null;
  active: boolean;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BillRecurrenceInput {
  frequency?: unknown;
  interval?: unknown;
  dayOfMonth?: unknown;
  weekday?: unknown;
  monthOfYear?: unknown;
}

export interface BillTemplateWriteInput {
  description?: unknown;
  amountCents?: unknown;
  amount?: unknown;
  amountMinCents?: unknown;
  amountMaxCents?: unknown;
  categoryId?: unknown;
  paymentMethodId?: unknown;
  recurrence?: BillRecurrenceInput;
  startDate?: unknown;
  endDate?: unknown;
  occurrenceCount?: unknown;
  active?: unknown;
  notes?: unknown;
}

export type TemplateUpdateScope = 'all' | 'future';

type TemplateRow = typeof billTemplates.$inferSelect;

interface ParsedTemplate {
  description: string;
  amountCents: number;
  amountMinCents: number | null;
  amountMaxCents: number | null;
  categoryId: number;
  paymentMethodId: number | null;
  frequency: BillFrequency;
  interval: number;
  dayOfMonth: number | null;
  weekday: number | null;
  monthOfYear: number | null;
  startDate: string;
  endDate: string | null;
  occurrenceCount: number | null;
  active: number;
  notes: string | null;
}

export function horizonFor(today: string): string {
  const horizon = addMonthsIso(today, OCCURRENCE_HORIZON_MONTHS);
  if (!horizon) throw badRequest('Data de referência inválida.');
  return horizon;
}

function recurrenceOf(row: Pick<TemplateRow, 'frequency' | 'interval' | 'dayOfMonth' | 'weekday' | 'monthOfYear'>): BillRecurrence {
  return {
    frequency: row.frequency as BillFrequency,
    interval: row.interval,
    dayOfMonth: row.dayOfMonth ?? null,
    weekday: row.weekday ?? null,
    monthOfYear: row.monthOfYear ?? null,
  };
}

function toDto(row: TemplateRow, categoryName: string): BillTemplateDto {
  const recurrence = recurrenceOf(row);
  return {
    id: row.id,
    description: row.description,
    amountCents: row.amountCents,
    amountMinCents: row.amountMinCents ?? null,
    amountMaxCents: row.amountMaxCents ?? null,
    categoryId: row.categoryId,
    categoryName,
    paymentMethodId: row.paymentMethodId ?? null,
    recurrence,
    recurrenceLabel: describeRecurrence(recurrence),
    startDate: row.startDate,
    endDate: row.endDate ?? null,
    occurrenceCount: row.occurrenceCount ?? null,
    active: row.active === 1,
    notes: row.notes ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function optionalInt(value: unknown, label: string): number | null {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isInteger(number)) throw badRequest(`${label} inválido.`);
  return number;
}

function parseRecurrenceInput(input: BillRecurrenceInput | undefined, existing?: TemplateRow): BillRecurrence {
  const base = existing ? recurrenceOf(existing) : null;
  const frequencyRaw = input?.frequency !== undefined ? input.frequency : base?.frequency;
  if (frequencyRaw === undefined) throw badRequest('Informe a frequência da recorrência.');
  const recurrence: BillRecurrence = {
    frequency: String(frequencyRaw) as BillFrequency,
    interval:
      input?.interval !== undefined ? Number(input.interval) : (base?.interval ?? 1),
    dayOfMonth:
      input?.dayOfMonth !== undefined
        ? optionalInt(input.dayOfMonth, 'Dia do mês')
        : (base?.dayOfMonth ?? null),
    weekday:
      input?.weekday !== undefined ? optionalInt(input.weekday, 'Dia da semana') : (base?.weekday ?? null),
    monthOfYear:
      input?.monthOfYear !== undefined
        ? optionalInt(input.monthOfYear, 'Mês')
        : (base?.monthOfYear ?? null),
  };
  const problem = validateRecurrence(recurrence);
  if (problem) throw badRequest(problem);
  return recurrence;
}

function parseTemplateInput(
  db: AppDatabase,
  input: BillTemplateWriteInput,
  existing?: TemplateRow,
): ParsedTemplate {
  const descriptionRaw = input.description !== undefined ? input.description : existing?.description;
  const description = displayName(String(descriptionRaw ?? ''));
  if (!description) throw badRequest('Informe a descrição da conta.');
  if (description.length > 200) throw badRequest('Descrição muito longa (máximo 200).');

  const amountCents = parseAmountInput(input) ?? existing?.amountCents;
  if (amountCents === undefined) throw badRequest('Informe o valor previsto.');

  const amountMinCents =
    input.amountMinCents !== undefined
      ? optionalInt(input.amountMinCents, 'Valor mínimo')
      : (existing?.amountMinCents ?? null);
  const amountMaxCents =
    input.amountMaxCents !== undefined
      ? optionalInt(input.amountMaxCents, 'Valor máximo')
      : (existing?.amountMaxCents ?? null);
  if (amountMinCents !== null && amountMinCents <= 0) throw badRequest('Valor mínimo deve ser positivo.');
  if (amountMaxCents !== null && amountMaxCents <= 0) throw badRequest('Valor máximo deve ser positivo.');
  if (amountMinCents !== null && amountMaxCents !== null && amountMinCents > amountMaxCents) {
    throw badRequest('Valor mínimo não pode superar o máximo.');
  }

  let categoryId: number;
  if (input.categoryId !== undefined) categoryId = assertCategory(db, input.categoryId);
  else if (existing) categoryId = existing.categoryId;
  else throw badRequest('Informe a categoria da conta.');

  const paymentMethodId =
    input.paymentMethodId !== undefined
      ? assertPaymentMethod(db, input.paymentMethodId)
      : (existing?.paymentMethodId ?? null);

  const recurrence = parseRecurrenceInput(input.recurrence, existing);

  const startRaw = input.startDate !== undefined ? input.startDate : existing?.startDate;
  const start = parseDateValue(startRaw);
  if (!start.ok) throw badRequest(`Data inicial: ${start.error}`);

  let endDate: string | null = existing?.endDate ?? null;
  if (input.endDate !== undefined) {
    if (input.endDate === null || input.endDate === '') endDate = null;
    else {
      const end = parseDateValue(input.endDate);
      if (!end.ok) throw badRequest(`Data final: ${end.error}`);
      endDate = end.value;
    }
  }
  if (endDate !== null && endDate < start.value) {
    throw badRequest('A data final não pode ser anterior à inicial.');
  }

  const occurrenceCount =
    input.occurrenceCount !== undefined
      ? optionalInt(input.occurrenceCount, 'Quantidade de repetições')
      : (existing?.occurrenceCount ?? null);
  if (occurrenceCount !== null && occurrenceCount < 1) {
    throw badRequest('A quantidade de repetições deve ser ao menos 1.');
  }

  const active =
    input.active !== undefined ? (input.active === true || input.active === 1 || input.active === 'true' ? 1 : 0) : (existing?.active ?? 1);

  const notes = input.notes !== undefined ? parseNotes(input.notes) : (existing?.notes ?? null);

  return {
    description,
    amountCents,
    amountMinCents,
    amountMaxCents,
    categoryId,
    paymentMethodId,
    ...recurrence,
    startDate: start.value,
    endDate,
    occurrenceCount,
    active,
    notes,
  };
}

function loadTemplateRow(db: AppDatabase, id: number): TemplateRow {
  const row = db.select().from(billTemplates).where(eq(billTemplates.id, id)).get();
  if (!row) throw notFound('Recorrência não encontrada.');
  return row;
}

export function getTemplate(db: AppDatabase, id: number): BillTemplateDto {
  const row = db
    .select({ template: billTemplates, categoryName: categories.name })
    .from(billTemplates)
    .innerJoin(categories, eq(billTemplates.categoryId, categories.id))
    .where(eq(billTemplates.id, id))
    .get();
  if (!row) throw notFound('Recorrência não encontrada.');
  return toDto(row.template, row.categoryName);
}

export function listTemplates(db: AppDatabase, options: { includeInactive?: boolean } = {}): BillTemplateDto[] {
  const rows = db
    .select({ template: billTemplates, categoryName: categories.name })
    .from(billTemplates)
    .innerJoin(categories, eq(billTemplates.categoryId, categories.id))
    .where(options.includeInactive ? undefined : eq(billTemplates.active, 1))
    .orderBy(sql`lower(${billTemplates.description})`, billTemplates.id)
    .all();
  return rows.map((row) => toDto(row.template, row.categoryName));
}

/** Datas que o template geraria, sem gravar nada (prévia do formulário). */
export function previewTemplateDates(
  db: AppDatabase,
  input: BillTemplateWriteInput,
  options: { today?: string; limit?: number } = {},
): OccurrenceDate[] {
  const today = options.today ?? todayIso();
  const parsed = parseTemplateInput(db, input);
  const dates = nextOccurrenceDates(recurrenceOf(parsed), parsed.startDate, {
    to: horizonFor(today),
    endDate: parsed.endDate,
    occurrenceCount: parsed.occurrenceCount,
  });
  return dates.slice(0, options.limit ?? 6);
}

/**
 * Materializa as ocorrências que faltam até o horizonte. Idempotente: a
 * posição (`sequence`) já existente — aberta, paga ou pulada — nunca é
 * recriada; por isso excluir uma ocorrência de recorrência a marca como pulada.
 */
export function ensureOccurrences(db: AppDatabase, templateId: number, today = todayIso()): { created: number } {
  const template = loadTemplateRow(db, templateId);
  if (template.active !== 1) return { created: 0 };
  const dates = nextOccurrenceDates(recurrenceOf(template), template.startDate, {
    to: horizonFor(today),
    endDate: template.endDate,
    occurrenceCount: template.occurrenceCount,
  });
  if (dates.length === 0) return { created: 0 };

  const existing = new Set(
    db
      .select({ sequence: scheduledBills.sequence })
      .from(scheduledBills)
      .where(eq(scheduledBills.templateId, templateId))
      .all()
      .map((row) => row.sequence),
  );
  const missing = dates.filter((date) => !existing.has(date.sequence));
  if (missing.length === 0) return { created: 0 };

  const timestamp = nowIso();
  db.transaction((tx) => {
    for (const date of missing) {
      tx.insert(scheduledBills)
        .values({
          templateId,
          sequence: date.sequence,
          description: template.description,
          amountCents: template.amountCents,
          dueDate: date.dueDate,
          state: 'open',
          categoryId: template.categoryId,
          paymentMethodId: template.paymentMethodId,
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        .run();
    }
  });
  return { created: missing.length };
}

export function ensureAllOccurrences(db: AppDatabase, today = todayIso()): { created: number } {
  const ids = db
    .select({ id: billTemplates.id })
    .from(billTemplates)
    .where(eq(billTemplates.active, 1))
    .all();
  let created = 0;
  for (const row of ids) created += ensureOccurrences(db, row.id, today).created;
  return { created };
}

export function createTemplate(
  db: AppDatabase,
  input: BillTemplateWriteInput,
  today = todayIso(),
): BillTemplateDto {
  const parsed = parseTemplateInput(db, input);
  const timestamp = nowIso();
  const created = db
    .insert(billTemplates)
    .values({ ...parsed, createdAt: timestamp, updatedAt: timestamp })
    .returning({ id: billTemplates.id })
    .get();
  ensureOccurrences(db, created.id, today);
  return getTemplate(db, created.id);
}

/** Ocorrências abertas, sem pagamento vinculado, do template. */
function openUnpaidCondition(templateId: number) {
  return and(
    eq(scheduledBills.templateId, templateId),
    eq(scheduledBills.state, 'open'),
    notInArray(scheduledBills.id, paidBillIdsSubquery()),
  );
}

/** Subconsulta (com parênteses próprios: notInArray não os adiciona) das contas com pagamento vinculado. */
function paidBillIdsSubquery(): SQL {
  return sql`(select ${billPayments.billId} from ${billPayments})`;
}

function recurrenceChanged(before: TemplateRow, after: ParsedTemplate): boolean {
  return (
    before.frequency !== after.frequency ||
    before.interval !== after.interval ||
    (before.dayOfMonth ?? null) !== after.dayOfMonth ||
    (before.weekday ?? null) !== after.weekday ||
    (before.monthOfYear ?? null) !== after.monthOfYear ||
    before.startDate !== after.startDate
  );
}

/**
 * `scope: 'all'` — altera a regra em vigor: campos descritivos propagam às
 * ocorrências abertas sem pagamento; mudar a recorrência exige `scope: 'future'`.
 * `scope: 'future'` — divide a série em `from`: a regra atual termina na
 * véspera e uma nova recorrência começa em `from` com os valores informados.
 * Ocorrências pagas, puladas ou com pagamento nunca são tocadas.
 */
export function updateTemplate(
  db: AppDatabase,
  id: number,
  input: BillTemplateWriteInput,
  options: { scope?: TemplateUpdateScope; from?: string } = {},
  today = todayIso(),
): BillTemplateDto {
  const existing = loadTemplateRow(db, id);
  const scope = options.scope ?? 'all';
  const parsed = parseTemplateInput(db, input, existing);

  if (scope === 'future') return splitTemplate(db, existing, parsed, options.from ?? today, today);

  if (recurrenceChanged(existing, parsed)) {
    throw badRequest('Para alterar a recorrência use scope=future, informando a partir de quando.');
  }

  db.transaction((tx) => {
    tx.update(billTemplates)
      .set({ ...parsed, updatedAt: nowIso() })
      .where(eq(billTemplates.id, id))
      .run();
    // Campos descritivos propagam às ocorrências abertas sem pagamento.
    tx.update(scheduledBills)
      .set({
        description: parsed.description,
        amountCents: parsed.amountCents,
        categoryId: parsed.categoryId,
        paymentMethodId: parsed.paymentMethodId,
        updatedAt: nowIso(),
      })
      .where(openUnpaidCondition(id))
      .run();
    // Limites reduzidos ou desativação: remove ocorrências abertas que ficaram fora.
    const outside: SQL[] = [];
    if (parsed.endDate) outside.push(gt(scheduledBills.dueDate, parsed.endDate));
    if (parsed.occurrenceCount !== null) outside.push(gt(scheduledBills.sequence, parsed.occurrenceCount));
    if (parsed.active !== 1) outside.push(gt(scheduledBills.dueDate, today));
    if (outside.length > 0) {
      tx.delete(scheduledBills)
        .where(and(openUnpaidCondition(id), or(...outside)))
        .run();
    }
  });
  ensureOccurrences(db, id, today);
  return getTemplate(db, id);
}

function previousDay(iso: string): string {
  const [year, month, day] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day) - 86_400_000);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(
    date.getUTCDate(),
  ).padStart(2, '0')}`;
}

function splitTemplate(
  db: AppDatabase,
  existing: TemplateRow,
  parsed: ParsedTemplate,
  from: string,
  today: string,
): BillTemplateDto {
  if (!isValidIsoDate(from)) throw badRequest('Informe a data (AAAA-MM-DD) a partir da qual a alteração vale.');
  if (from <= existing.startDate) {
    // Nada a preservar: a série inteira é substituída.
    return replaceWholeTemplate(db, existing, parsed, today);
  }

  const newId = db.transaction((tx) => {
    tx.delete(scheduledBills)
      .where(and(openUnpaidCondition(existing.id), gte(scheduledBills.dueDate, from)))
      .run();
    const remaining = tx
      .select({ count: sql<number>`count(*)`, maxSequence: sql<number | null>`max(${scheduledBills.sequence})` })
      .from(scheduledBills)
      .where(eq(scheduledBills.templateId, existing.id))
      .get();
    const keptCount = Number(remaining?.count ?? 0);
    const keptMaxSequence = remaining?.maxSequence === null || remaining?.maxSequence === undefined ? null : Number(remaining.maxSequence);

    tx.update(billTemplates)
      .set({
        endDate: previousDay(from),
        occurrenceCount: existing.occurrenceCount !== null ? keptMaxSequence : null,
        active: keptCount > 0 ? existing.active : 0,
        updatedAt: nowIso(),
      })
      .where(eq(billTemplates.id, existing.id))
      .run();

    const timestamp = nowIso();
    const startDate = parsed.startDate > from ? parsed.startDate : from;
    const occurrenceCount =
      parsed.occurrenceCount !== null ? Math.max(1, parsed.occurrenceCount - keptCount) : null;
    const created = tx
      .insert(billTemplates)
      .values({ ...parsed, startDate, occurrenceCount, active: 1, createdAt: timestamp, updatedAt: timestamp })
      .returning({ id: billTemplates.id })
      .get();
    return created.id;
  });
  ensureOccurrences(db, newId, today);
  return getTemplate(db, newId);
}

function replaceWholeTemplate(
  db: AppDatabase,
  existing: TemplateRow,
  parsed: ParsedTemplate,
  today: string,
): BillTemplateDto {
  db.transaction((tx) => {
    tx.delete(scheduledBills).where(openUnpaidCondition(existing.id)).run();
    tx.update(billTemplates)
      .set({ ...parsed, updatedAt: nowIso() })
      .where(eq(billTemplates.id, existing.id))
      .run();
  });
  ensureOccurrences(db, existing.id, today);
  return getTemplate(db, existing.id);
}

/** Remove a recorrência e suas ocorrências abertas sem pagamento; pagas e puladas ficam, desvinculadas. */
export function deleteTemplate(db: AppDatabase, id: number): { removed: true; deletedOccurrences: number } {
  loadTemplateRow(db, id);
  return db.transaction((tx) => {
    const deleted = tx.delete(scheduledBills).where(openUnpaidCondition(id)).run();
    tx.delete(billTemplates).where(eq(billTemplates.id, id)).run();
    return { removed: true as const, deletedOccurrences: deleted.changes };
  });
}

/** Lista as ocorrências de um template (qualquer estado), por sequência. */
export function listTemplateOccurrenceIds(db: AppDatabase, templateId: number): number[] {
  return db
    .select({ id: scheduledBills.id })
    .from(scheduledBills)
    .where(eq(scheduledBills.templateId, templateId))
    .orderBy(scheduledBills.sequence)
    .all()
    .map((row) => row.id);
}

