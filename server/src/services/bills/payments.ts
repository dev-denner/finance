/**
 * Pagamento de contas a pagar. O Módulo 1 é uma agenda: o vínculo com o
 * Módulo 2 é opcional.
 *  - external:    só marca a ocorrência como paga (padrão da interface).
 *  - transaction: cria o lançamento de saída e o vincula.
 *  - link:        vincula um lançamento de saída já existente (ex.: importado).
 *
 * Todo pagamento vira uma linha em `bill_payments` (sem lançamento no modo
 * external). Por padrão o pagamento quita a conta, com qualquer valor (contas
 * de valor variável). Com `partial`, a conta continua em aberto até a soma dos
 * pagamentos alcançar o valor previsto.
 */
import { eq, sql } from 'drizzle-orm';
import type { AppDatabase } from '../../db/client';
import { billPayments, scheduledBills, transactions } from '../../db/schema';
import { parseDateValue, todayIso } from '../../lib/dates';
import { badRequest, conflict, notFound, nowIso } from '../../lib/errors';
import { createTransaction, deleteTransaction } from '../transactions';
import { findActiveLink } from '../transfers';
import { billState, type BillDto, type BillPaymentOrigin } from './dto';
import { getBill, loadBillRow, parseNotes } from './occurrences';

export type PayBillInput = (
  | { mode: 'external'; paidAt: string; paidCents: number; notes?: string | null }
  | {
      mode: 'transaction';
      paidAt: string;
      paidCents: number;
      paymentMethodId: number;
      notes?: string | null;
    }
  | {
      mode: 'link';
      transactionId: number;
      notes?: string | null;
      /** `import_match` quando o vínculo veio da revisão da importação. */
      origin?: Extract<BillPaymentOrigin, 'manual' | 'import_match'>;
    }
) & {
  /** Pagamento parcial: a conta só é quitada quando a soma alcança o valor previsto. */
  partial?: boolean;
};

function parsePaidAt(value: unknown): string {
  const parsed = parseDateValue(value);
  if (!parsed.ok) throw badRequest(`Data do pagamento: ${parsed.error}`);
  return parsed.value;
}

function assertPaidCents(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw badRequest('O valor pago deve ser positivo.');
  }
  return value as number;
}

export function payBill(db: AppDatabase, id: number, input: PayBillInput, today = todayIso()): BillDto {
  const existing = loadBillRow(db, id);
  if (billState(existing.state) === 'paid') throw conflict('Esta conta já está paga.');
  const notes = input.notes !== undefined ? parseNotes(input.notes) : existing.notes;

  db.transaction(() => {
    let transactionId: number | null;
    let paidAt: string;
    let paidCents: number;
    let paymentMethodId: number | null;
    let createdTransaction: boolean;
    let origin: BillPaymentOrigin;

    if (input.mode === 'external') {
      transactionId = null;
      paidAt = parsePaidAt(input.paidAt);
      paidCents = assertPaidCents(input.paidCents);
      paymentMethodId = null;
      createdTransaction = false;
      origin = 'manual';
    } else if (input.mode === 'transaction') {
      paidAt = parsePaidAt(input.paidAt);
      paidCents = assertPaidCents(input.paidCents);
      // Competência na data de compra (vencimento da conta) e caixa no vencimento
      // do lançamento (data do pagamento): o consolidado por vencimento mostra o
      // mês em que o dinheiro saiu; por compra, o mês da conta.
      const created = createTransaction(db, {
        purchaseDate: existing.dueDate,
        dueDate: paidAt,
        description: existing.description,
        amountCents: -paidCents,
        categoryId: existing.categoryId,
        paymentMethodId: input.paymentMethodId,
        installmentNumber: null,
        installmentTotal: null,
        transfer: null,
      });
      transactionId = created.id;
      paymentMethodId = created.paymentMethodId;
      createdTransaction = true;
      origin = 'manual';
    } else if (input.mode === 'link') {
      if (!Number.isInteger(input.transactionId) || input.transactionId <= 0) {
        throw badRequest('Lançamento inválido.');
      }
      const transaction = db
        .select()
        .from(transactions)
        .where(eq(transactions.id, input.transactionId))
        .get();
      if (!transaction) throw notFound('Lançamento não encontrado.');
      if (transaction.amountCents >= 0) {
        throw badRequest('Só um lançamento de saída (valor negativo) pode pagar uma conta.');
      }
      const alreadyPays = db
        .select({ billId: billPayments.billId })
        .from(billPayments)
        .where(eq(billPayments.transactionId, transaction.id))
        .get();
      if (alreadyPays) throw conflict('Este lançamento já paga outra conta.');
      if (findActiveLink(db, [transaction.id]).length > 0) {
        throw conflict('Este lançamento faz parte de uma transferência confirmada e não pode pagar uma conta.');
      }
      transactionId = transaction.id;
      paidAt = transaction.dueDate;
      paidCents = -transaction.amountCents;
      paymentMethodId = transaction.paymentMethodId;
      createdTransaction = false;
      origin = input.origin ?? 'manual';
    } else {
      const never: never = input;
      throw badRequest(`Modo de pagamento inválido: ${String((never as { mode?: unknown }).mode)}.`);
    }

    db.insert(billPayments)
      .values({
        billId: id,
        transactionId,
        amountCents: paidCents,
        paidAt,
        origin,
        createdTransaction: createdTransaction ? 1 : 0,
      })
      .run();
    const totalPaid = paidSoFar(db, id);
    const settles = !input.partial || totalPaid >= existing.amountCents;
    db.update(scheduledBills)
      .set({
        ...(settles
          ? { state: 'paid', paidAt, paidCents: totalPaid, scheduledFor: null, migratedPayment: 0 }
          : {}),
        ...(paymentMethodId !== null ? { paymentMethodId } : {}),
        notes,
        updatedAt: nowIso(),
      })
      .where(eq(scheduledBills.id, id))
      .run();
  });

  return getBill(db, id, today);
}

/** Soma dos pagamentos registrados da conta. */
function paidSoFar(db: AppDatabase, id: number): number {
  return db
    .select({ total: sql<number>`coalesce(sum(${billPayments.amountCents}), 0)` })
    .from(billPayments)
    .where(eq(billPayments.billId, id))
    .get()?.total ?? 0;
}

/**
 * Reabre a conta e desfaz todos os pagamentos, inclusive os parciais de uma
 * conta ainda em aberto. O lançamento só é apagado quando foi criado pelo
 * próprio pagamento — um lançamento importado vinculado continua no Módulo 2.
 */
export function unpayBill(db: AppDatabase, id: number, today = todayIso()): BillDto {
  const existing = loadBillRow(db, id);
  if (billState(existing.state) !== 'paid' && paidSoFar(db, id) === 0) return getBill(db, id, today);

  db.transaction(() => {
    const links = db
      .select({ transactionId: billPayments.transactionId, createdTransaction: billPayments.createdTransaction })
      .from(billPayments)
      .where(eq(billPayments.billId, id))
      .all();
    db.delete(billPayments).where(eq(billPayments.billId, id)).run();
    for (const link of links) {
      if (link.createdTransaction === 1 && link.transactionId !== null) deleteTransaction(db, link.transactionId);
    }
    db.update(scheduledBills)
      .set({ state: 'open', paidAt: null, paidCents: null, migratedPayment: 0, updatedAt: nowIso() })
      .where(eq(scheduledBills.id, id))
      .run();
  });

  return getBill(db, id, today);
}
