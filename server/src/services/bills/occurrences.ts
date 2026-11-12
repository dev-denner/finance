import { eq } from 'drizzle-orm';
import type { AppDatabase } from '../../db/client';
import { billPayments, categories, paymentMethods, scheduledBills } from '../../db/schema';
import { parseDateValue, todayIso } from '../../lib/dates';
import { badRequest, conflict, notFound, nowIso } from '../../lib/errors';
import { parseAmountToCents } from '../../lib/money';
import { displayName } from '../../lib/normalize';
import {
  billSelection,
  billState,
  toBillDto,
  loadPayments,
  type BillDto,
  type BillRow,
  type LegacyBillStatus,
} from './dto';

const LEGACY_STATUSES: readonly LegacyBillStatus[] = ['', 'AG', 'PG'];

export interface BillWriteInput {
  description?: unknown;
  amountCents?: unknown;
  amount?: unknown;
  dueDate?: unknown;
  categoryId?: unknown;
  paymentMethodId?: unknown;
  notes?: unknown;
  /** Data de agendamento no banco; null limpa. */
  scheduledFor?: unknown;
  /** @deprecated situação legada ('' | AG | PG); mapeada para state/scheduledFor/pagamento externo. */
  status?: unknown;
}

export function loadBillRow(db: AppDatabase, id: number): BillRow {
  const row = db.select().from(scheduledBills).where(eq(scheduledBills.id, id)).get();
  if (!row) throw notFound('Conta a pagar não encontrada.');
  return row;
}

export function getBill(db: AppDatabase, id: number, today = todayIso()): BillDto {
  const row = billSelection(db).where(eq(scheduledBills.id, id)).get();
  if (!row) throw notFound('Conta a pagar não encontrada.');
  const payments = loadPayments(db, [id]).get(id) ?? [];
  return toBillDto(row, today, payments);
}

export function assertCategory(db: AppDatabase, value: unknown): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw badRequest('Categoria inválida.');
  const found = db.select({ id: categories.id }).from(categories).where(eq(categories.id, id)).get();
  if (!found) throw badRequest('Categoria não encontrada.');
  return id;
}

export function assertPaymentMethod(db: AppDatabase, value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw badRequest('Forma de pagamento inválida.');
  const found = db
    .select({ id: paymentMethods.id })
    .from(paymentMethods)
    .where(eq(paymentMethods.id, id))
    .get();
  if (!found) throw badRequest('Forma de pagamento não encontrada.');
  return id;
}

export function parseAmountInput(input: { amountCents?: unknown; amount?: unknown }): number | undefined {
  if (input.amountCents !== undefined) {
    const value = Number(input.amountCents);
    if (!Number.isInteger(value) || value <= 0) throw badRequest('O valor deve ser positivo.');
    return value;
  }
  if (input.amount !== undefined) {
    const parsed = parseAmountToCents(input.amount);
    if (!parsed.ok) throw badRequest(parsed.error);
    if (parsed.value <= 0) throw badRequest('O valor deve ser positivo.');
    return parsed.value;
  }
  return undefined;
}

export function parseNotes(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (text.length > 1000) throw badRequest('Observações muito longas (máximo 1000).');
  return text || null;
}

function parseOptionalDate(value: unknown, label: string): string | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = parseDateValue(value);
  if (!parsed.ok) throw badRequest(`${label}: ${parsed.error}`);
  return parsed.value;
}

function parseLegacyStatus(value: unknown): LegacyBillStatus {
  const text = String(value ?? '').trim().toUpperCase();
  if (!LEGACY_STATUSES.includes(text as LegacyBillStatus)) {
    throw badRequest('Situação inválida. Use "", "AG" ou "PG".');
  }
  return text as LegacyBillStatus;
}

interface ParsedBill {
  description: string;
  amountCents: number;
  dueDate: string;
  categoryId: number;
  paymentMethodId: number | null;
  notes: string | null;
}

function parseBillInput(db: AppDatabase, input: BillWriteInput, existing?: BillRow): ParsedBill {
  const descriptionRaw = input.description !== undefined ? input.description : existing?.description;
  const description = displayName(String(descriptionRaw ?? ''));
  if (!description) throw badRequest('Informe a descrição da conta.');
  if (description.length > 200) throw badRequest('Descrição muito longa (máximo 200).');

  const amountCents = parseAmountInput(input) ?? existing?.amountCents;
  if (amountCents === undefined) throw badRequest('Informe o valor da conta.');

  const dueDateRaw = input.dueDate !== undefined ? input.dueDate : existing?.dueDate;
  const dueDate = parseDateValue(dueDateRaw);
  if (!dueDate.ok) throw badRequest(dueDate.error);

  let categoryId: number;
  if (input.categoryId !== undefined) categoryId = assertCategory(db, input.categoryId);
  else if (existing) categoryId = existing.categoryId;
  else throw badRequest('Informe a categoria da conta.');

  const paymentMethodId =
    input.paymentMethodId !== undefined
      ? assertPaymentMethod(db, input.paymentMethodId)
      : (existing?.paymentMethodId ?? null);

  const notes = input.notes !== undefined ? parseNotes(input.notes) : (existing?.notes ?? null);

  return { description, amountCents, dueDate: dueDate.value, categoryId, paymentMethodId, notes };
}

/** Cria uma conta avulsa (sem recorrência). */
export function createBill(db: AppDatabase, input: BillWriteInput, today = todayIso()): BillDto {
  const parsed = parseBillInput(db, input);
  const legacy = input.status !== undefined ? parseLegacyStatus(input.status) : '';
  const scheduledFor =
    input.scheduledFor !== undefined
      ? parseOptionalDate(input.scheduledFor, 'Agendamento')
      : legacy === 'AG'
        ? parsed.dueDate
        : null;
  const timestamp = nowIso();
  const created = db
    .insert(scheduledBills)
    .values({
      ...parsed,
      state: legacy === 'PG' ? 'paid' : 'open',
      scheduledFor,
      // Importação/cadastro legado com PG: pagamento externo na data de vencimento.
      paidAt: legacy === 'PG' ? parsed.dueDate : null,
      paidCents: legacy === 'PG' ? parsed.amountCents : null,
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    .returning({ id: scheduledBills.id })
    .get();
  return getBill(db, created.id, today);
}

export function updateBill(
  db: AppDatabase,
  id: number,
  input: BillWriteInput,
  today = todayIso(),
): BillDto {
  const existing = loadBillRow(db, id);
  const parsed = parseBillInput(db, input, existing);
  const patch: Partial<BillRow> = { ...parsed, updatedAt: nowIso() };

  if (input.scheduledFor !== undefined) {
    patch.scheduledFor = parseOptionalDate(input.scheduledFor, 'Agendamento');
  }
  if (input.status !== undefined) {
    const legacy = parseLegacyStatus(input.status);
    Object.assign(patch, legacyTransition(existing, legacy, parsed, today));
  }
  // Conta paga sem lançamento mantém o valor pago igual ao previsto quando este muda.
  if (
    billState(patch.state ?? existing.state) === 'paid' &&
    existing.paidCents === existing.amountCents &&
    patch.amountCents !== undefined &&
    patch.paidCents === undefined
  ) {
    patch.paidCents = patch.amountCents;
  }

  db.update(scheduledBills).set(patch).where(eq(scheduledBills.id, id)).run();
  return getBill(db, id, today);
}

/** Transição de situação legada sobre o modelo novo (só pagamento externo). */
function legacyTransition(
  existing: BillRow,
  legacy: LegacyBillStatus,
  parsed: Pick<ParsedBill, 'dueDate' | 'amountCents'>,
  today: string,
): Partial<BillRow> {
  const wasPaid = billState(existing.state) === 'paid';
  if (legacy === 'PG') {
    if (wasPaid) return {};
    return { state: 'paid', paidAt: today, paidCents: parsed.amountCents, scheduledFor: null };
  }
  const base: Partial<BillRow> = { state: 'open', paidAt: null, paidCents: null, migratedPayment: 0 };
  if (!wasPaid) delete base.migratedPayment;
  return { ...base, scheduledFor: legacy === 'AG' ? parsed.dueDate : null };
}

function hasPayments(db: AppDatabase, id: number): boolean {
  return Boolean(
    db.select({ id: billPayments.id }).from(billPayments).where(eq(billPayments.billId, id)).get(),
  );
}

/**
 * Exclui uma conta avulsa. Uma ocorrência de recorrência não é removida (a
 * série a recriaria): ela vira "pulada" e mantém a posição na série.
 */
export function deleteBill(
  db: AppDatabase,
  id: number,
): { removed: boolean; skipped: boolean } {
  const existing = loadBillRow(db, id);
  if (hasPayments(db, id)) {
    throw conflict('Esta conta tem pagamento vinculado a um lançamento. Desfaça o pagamento antes.');
  }
  if (existing.templateId !== null) {
    if (billState(existing.state) === 'paid') {
      throw conflict('Conta paga de uma recorrência não pode ser excluída. Desfaça o pagamento antes.');
    }
    db.update(scheduledBills)
      .set({ state: 'skipped', scheduledFor: null, updatedAt: nowIso() })
      .where(eq(scheduledBills.id, id))
      .run();
    return { removed: false, skipped: true };
  }
  db.delete(scheduledBills).where(eq(scheduledBills.id, id)).run();
  return { removed: true, skipped: false };
}

export function skipBill(db: AppDatabase, id: number, today = todayIso()): BillDto {
  const existing = loadBillRow(db, id);
  if (billState(existing.state) === 'paid') {
    throw conflict('Conta paga não pode ser pulada. Desfaça o pagamento antes.');
  }
  db.update(scheduledBills)
    .set({ state: 'skipped', scheduledFor: null, updatedAt: nowIso() })
    .where(eq(scheduledBills.id, id))
    .run();
  return getBill(db, id, today);
}

export function unskipBill(db: AppDatabase, id: number, today = todayIso()): BillDto {
  const existing = loadBillRow(db, id);
  if (billState(existing.state) !== 'skipped') return getBill(db, id, today);
  db.update(scheduledBills)
    .set({ state: 'open', updatedAt: nowIso() })
    .where(eq(scheduledBills.id, id))
    .run();
  return getBill(db, id, today);
}

/** Registra (ou limpa, com null) a data em que o pagamento foi agendado no banco. */
export function scheduleBill(
  db: AppDatabase,
  id: number,
  scheduledFor: unknown,
  today = todayIso(),
): BillDto {
  const existing = loadBillRow(db, id);
  if (billState(existing.state) !== 'open') {
    throw conflict('Só uma conta em aberto pode ser agendada.');
  }
  const value = parseOptionalDate(scheduledFor, 'Agendamento');
  db.update(scheduledBills)
    .set({ scheduledFor: value, updatedAt: nowIso() })
    .where(eq(scheduledBills.id, id))
    .run();
  return getBill(db, id, today);
}
