/**
 * Compatibilidade com o client atual (situação ''/AG/PG e "repetir no mês
 * seguinte"). Implementada sobre o modelo novo; sai junto com a tela nova.
 * @deprecated
 */
import { eq } from 'drizzle-orm';
import type { AppDatabase } from '../../db/client';
import { scheduledBills } from '../../db/schema';
import { addMonthsIso, todayIso } from '../../lib/dates';
import { badRequest, notFound, nowIso } from '../../lib/errors';
import { billState, type BillDto } from './dto';
import { getBill, loadBillRow, updateBill } from './occurrences';

/** @deprecated use `addMonthsIso` de `lib/dates`. */
export function advanceMonth(date: string): string {
  const next = addMonthsIso(date, 1);
  if (!next) throw badRequest('Data de vencimento inválida.');
  return next;
}

/** @deprecated use `payBill`/`unpayBill`/`scheduleBill`. */
export function setBillStatus(
  db: AppDatabase,
  id: number,
  status: unknown,
  today = todayIso(),
): { bill: BillDto; promptRepeat: boolean; existingRepeatId: number | null } {
  const existing = loadBillRow(db, id);
  const wasPaid = billState(existing.state) === 'paid';
  const bill = updateBill(db, id, { status }, today);
  const existingRepeat = db
    .select({ id: scheduledBills.id })
    .from(scheduledBills)
    .where(eq(scheduledBills.repeatedFromId, id))
    .get();
  return {
    bill,
    promptRepeat: bill.state === 'paid' && !wasPaid,
    existingRepeatId: existingRepeat?.id ?? null,
  };
}

/** @deprecated use recorrências (`bill_templates`). Cria uma conta avulsa um mês à frente. */
export function repeatBill(
  db: AppDatabase,
  sourceId: number,
  today = todayIso(),
): { bill: BillDto; created: boolean } {
  const source = db.select().from(scheduledBills).where(eq(scheduledBills.id, sourceId)).get();
  if (!source) throw notFound('Conta a pagar não encontrada.');

  const existing = db
    .select({ id: scheduledBills.id })
    .from(scheduledBills)
    .where(eq(scheduledBills.repeatedFromId, sourceId))
    .get();
  if (existing) return { bill: getBill(db, existing.id, today), created: false };

  const timestamp = nowIso();
  const created = db
    .insert(scheduledBills)
    .values({
      description: source.description,
      amountCents: source.amountCents,
      dueDate: advanceMonth(source.dueDate),
      state: 'open',
      categoryId: source.categoryId,
      paymentMethodId: source.paymentMethodId,
      repeatedFromId: source.id,
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    .returning({ id: scheduledBills.id })
    .get();
  return { bill: getBill(db, created.id, today), created: true };
}
