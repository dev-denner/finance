/**
 * Ações em massa sobre ocorrências: marcar várias como pagas (pagamento
 * externo, sem lançamento) ou puladas. Tudo ou nada: se uma conta não puder
 * receber a ação, nenhuma é alterada e o erro cita a conta.
 */
import { eq } from 'drizzle-orm';
import type { AppDatabase } from '../../db/client';
import { billPayments, scheduledBills, transactions } from '../../db/schema';
import { parseDateValue, todayIso } from '../../lib/dates';
import { badRequest, conflict, notFound, nowIso } from '../../lib/errors';
import { formatBRL } from '../../lib/money';
import { createTransaction } from '../transactions';
import { findActiveLink } from '../transfers';
import type { BillDto } from './dto';
import { assertCategory, getBill, skipBill } from './occurrences';
import { paidSoFar, payBill } from './payments';

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

export type GroupPaymentInput =
  | {
      /** Cria um lançamento de saída com o total das contas. */
      mode: 'transaction';
      paidAt: string;
      paymentMethodId: number;
      /** Obrigatória quando as contas têm categorias diferentes. */
      categoryId?: number | null;
      description?: string | null;
    }
  | {
      /** Vincula um lançamento de saída já existente cujo valor é o total das contas. */
      mode: 'link';
      transactionId: number;
    };

/**
 * Boleto agrupado: um lançamento paga várias contas em aberto, cada uma pelo
 * valor que falta. Tudo ou nada. Desfazer o pagamento de qualquer uma desfaz
 * o de todas (ver `unpayBill`).
 */
export function payBillsWithOneTransaction(
  db: AppDatabase,
  ids: readonly number[],
  input: GroupPaymentInput,
  today = todayIso(),
): { updated: number; paidCents: number; transactionId: number } {
  return db.transaction(() => {
    const bills = loadOpenBills(db, ids, today);
    if (bills.length < 2) throw badRequest('Selecione ao menos duas contas para pagar com um lançamento só.');
    const shares = bills.map((bill) => ({ bill, cents: bill.amountCents - bill.partialPaidCents }));
    const total = shares.reduce((sum, share) => sum + share.cents, 0);

    let transactionId: number;
    let paidAt: string;
    let paymentMethodId: number | null;
    let created: boolean;
    if (input.mode === 'transaction') {
      const parsed = parseDateValue(input.paidAt);
      if (!parsed.ok) throw badRequest(`Data do pagamento: ${parsed.error}`);
      paidAt = parsed.value;
      const categoryIds = new Set(bills.map((bill) => bill.categoryId));
      let categoryId: number;
      if (input.categoryId !== undefined && input.categoryId !== null) categoryId = assertCategory(db, input.categoryId);
      else if (categoryIds.size === 1) categoryId = bills[0].categoryId;
      else throw badRequest('As contas têm categorias diferentes: escolha a categoria do lançamento.');
      const description =
        input.description?.trim() || `Boleto agrupado: ${bills.map((bill) => bill.description).join(', ')}`;
      const transaction = createTransaction(db, {
        // Competência na conta que vence primeiro; caixa na data do pagamento (como no pagamento individual).
        purchaseDate: bills.map((bill) => bill.dueDate).sort()[0],
        dueDate: paidAt,
        description: description.length > 200 ? `${description.slice(0, 199)}…` : description,
        amountCents: -total,
        categoryId,
        paymentMethodId: input.paymentMethodId,
        installmentNumber: null,
        installmentTotal: null,
        transfer: null,
      });
      transactionId = transaction.id;
      paymentMethodId = transaction.paymentMethodId;
      created = true;
    } else {
      const transaction = db.select().from(transactions).where(eq(transactions.id, input.transactionId)).get();
      if (!transaction) throw notFound('Lançamento não encontrado.');
      if (transaction.amountCents >= 0) throw badRequest('Só um lançamento de saída (valor negativo) pode pagar contas.');
      const alreadyPays = db.select({ id: billPayments.id }).from(billPayments).where(eq(billPayments.transactionId, transaction.id)).get();
      if (alreadyPays) throw conflict('Este lançamento já paga outra conta.');
      if (-transaction.amountCents !== total) {
        throw conflict(
          `O lançamento (${formatBRL(-transaction.amountCents)}) não bate com o total das contas (${formatBRL(total)}).`,
        );
      }
      if (findActiveLink(db, [transaction.id]).length > 0) {
        throw conflict('Este lançamento faz parte de uma transferência confirmada e não pode pagar contas.');
      }
      transactionId = transaction.id;
      paidAt = transaction.dueDate;
      paymentMethodId = transaction.paymentMethodId;
      created = false;
    }

    for (const { bill, cents } of shares) {
      db.insert(billPayments)
        .values({ billId: bill.id, transactionId, amountCents: cents, paidAt, origin: 'manual', createdTransaction: created ? 1 : 0 })
        .run();
      db.update(scheduledBills)
        .set({
          state: 'paid',
          paidAt,
          paidCents: paidSoFar(db, bill.id),
          scheduledFor: null,
          migratedPayment: 0,
          ...(paymentMethodId !== null ? { paymentMethodId } : {}),
          updatedAt: nowIso(),
        })
        .where(eq(scheduledBills.id, bill.id))
        .run();
    }
    return { updated: bills.length, paidCents: total, transactionId };
  });
}
