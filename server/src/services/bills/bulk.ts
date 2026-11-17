/**
 * Ações em massa sobre ocorrências: marcar várias como pagas (pagamento
 * externo, sem lançamento) ou puladas. Tudo ou nada: se uma conta não puder
 * receber a ação, nenhuma é alterada e o erro cita a conta.
 */
import type { AppDatabase } from '../../db/client';
import { todayIso } from '../../lib/dates';
import { badRequest, conflict } from '../../lib/errors';
import type { BillDto } from './dto';
import { getBill, skipBill } from './occurrences';
import { payBill } from './payments';

/** Limite por requisição; a tela trabalha com um mês por vez. */
export const BULK_BILLS_MAX = 500;

function uniqueIds(ids: readonly number[]): number[] {
  const unique = [...new Set(ids)];
  if (unique.length === 0) throw badRequest('Selecione ao menos uma conta.');
  if (unique.length > BULK_BILLS_MAX) throw badRequest(`Selecione no máximo ${BULK_BILLS_MAX} contas por vez.`);
  return unique;
}

function loadOpenBills(db: AppDatabase, ids: readonly number[], today: string): BillDto[] {
  return uniqueIds(ids).map((id) => {
    const bill = getBill(db, id, today);
    if (bill.state !== 'open') {
      const situation = bill.state === 'paid' ? 'já está paga' : 'está pulada';
      throw conflict(`“${bill.description}” ${situation}. Tire-a da seleção e tente de novo.`);
    }
    return bill;
  });
}

/**
 * Quita as contas em aberto na data informada, cada uma pelo valor que falta
 * (o previsto menos os pagamentos parciais já registrados).
 */
export function bulkPayBills(
  db: AppDatabase,
  ids: readonly number[],
  input: { paidAt: string },
  today = todayIso(),
): { updated: number; paidCents: number } {
  return db.transaction(() => {
    const bills = loadOpenBills(db, ids, today);
    let paidCents = 0;
    for (const bill of bills) {
      const remaining = bill.amountCents - bill.partialPaidCents;
      if (remaining <= 0) throw conflict(`“${bill.description}” não tem valor restante a pagar.`);
      payBill(db, bill.id, { mode: 'external', paidAt: input.paidAt, paidCents: remaining }, today);
      paidCents += remaining;
    }
    return { updated: bills.length, paidCents };
  });
}

/** Pula as contas em aberto; conta com pagamento parcial é recusada (como no pular individual). */
export function bulkSkipBills(db: AppDatabase, ids: readonly number[], today = todayIso()): { updated: number } {
  return db.transaction(() => {
    const bills = loadOpenBills(db, ids, today);
    for (const bill of bills) {
      if (bill.partialPaidCents > 0) {
        throw conflict(`“${bill.description}” tem pagamento parcial e não pode ser pulada. Desfaça os pagamentos antes.`);
      }
      skipBill(db, bill.id, today);
    }
    return { updated: bills.length };
  });
}
