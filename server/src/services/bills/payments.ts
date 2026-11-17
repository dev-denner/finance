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
import { and, eq, inArray, sql } from 'drizzle-orm';
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
export function paidSoFar(db: AppDatabase, id: number): number {
  return db
    .select({ total: sql<number>`coalesce(sum(${billPayments.amountCents}), 0)` })
    .from(billPayments)
    .where(eq(billPayments.billId, id))
    .get()?.total ?? 0;
}

type PaymentRow = typeof billPayments.$inferSelect;

/**
 * Pagamentos que saem juntos: os que compartilham lançamento com os
 * informados (boleto agrupado) são desfeitos todos, porque o lançamento é um
 * pagamento só.
 */
function withGroupMates(db: AppDatabase, rows: PaymentRow[]): PaymentRow[] {
  const transactionIds = [...new Set(rows.map((row) => row.transactionId).filter((id): id is number => id !== null))];
  if (transactionIds.length === 0) return rows;
  const mates = db.select().from(billPayments).where(inArray(billPayments.transactionId, transactionIds)).all();
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const mate of mates) byId.set(mate.id, mate);
  return [...byId.values()];
}

/**
 * Remove os pagamentos e acerta cada conta afetada: ela só continua paga se
 * ainda tem pagamentos e o removido não era o último (o que a quitou); senão
 * reabre, com os restantes como parciais. O lançamento criado pelo pagamento
 * é apagado quando nenhum pagamento o usa mais.
 */
function removePayments(db: AppDatabase, rows: PaymentRow[]): void {
  if (rows.length === 0) return;
  const billIds = [...new Set(rows.map((row) => row.billId))];
  const latestByBill = new Map<number, number>();
  for (const row of db.select({ id: billPayments.id, billId: billPayments.billId }).from(billPayments).where(inArray(billPayments.billId, billIds)).all()) {
    latestByBill.set(row.billId, Math.max(latestByBill.get(row.billId) ?? 0, row.id));
  }
  const removedIds = new Set(rows.map((row) => row.id));
  db.delete(billPayments).where(inArray(billPayments.id, [...removedIds])).run();

  const created = new Set(
    rows.filter((row) => row.createdTransaction === 1 && row.transactionId !== null).map((row) => row.transactionId as number),
  );
  for (const transactionId of created) {
    const stillUsed = db.select({ id: billPayments.id }).from(billPayments).where(eq(billPayments.transactionId, transactionId)).get();
    if (!stillUsed) deleteTransaction(db, transactionId);
  }

  for (const billId of billIds) {
    const bill = loadBillRow(db, billId);
    const remaining = db
      .select({
        count: sql<number>`count(*)`,
        total: sql<number>`coalesce(sum(${billPayments.amountCents}), 0)`,
        lastPaidAt: sql<string | null>`max(${billPayments.paidAt})`,
      })
      .from(billPayments)
      .where(eq(billPayments.billId, billId))
      .get();
    const removedLatest = removedIds.has(latestByBill.get(billId) ?? -1);
    const stillPaid = billState(bill.state) === 'paid' && !removedLatest && (remaining?.count ?? 0) > 0;
    db.update(scheduledBills)
      .set({
        ...(stillPaid
          ? { paidAt: remaining?.lastPaidAt ?? bill.paidAt, paidCents: remaining?.total ?? 0 }
          : { state: 'open', paidAt: null, paidCents: null, migratedPayment: 0 }),
        updatedAt: nowIso(),
      })
      .where(eq(scheduledBills.id, billId))
      .run();
  }
}

/**
 * Reabre a conta e desfaz todos os pagamentos, inclusive os parciais de uma
 * conta ainda em aberto. O lançamento só é apagado quando foi criado pelo
 * próprio pagamento — um lançamento importado vinculado continua no Módulo 2.
 * Um pagamento agrupado (um lançamento para várias contas) é desfeito em todas.
 */
export function unpayBill(db: AppDatabase, id: number, today = todayIso()): BillDto {
  const existing = loadBillRow(db, id);
  const rows = db.select().from(billPayments).where(eq(billPayments.billId, id)).all();
  if (billState(existing.state) !== 'paid' && rows.length === 0) return getBill(db, id, today);

  db.transaction(() => {
    removePayments(db, withGroupMates(db, rows));
    // Conta paga sem registro de pagamento (migração 0015) também reabre.
    db.update(scheduledBills)
      .set({ state: 'open', paidAt: null, paidCents: null, migratedPayment: 0, updatedAt: nowIso() })
      .where(eq(scheduledBills.id, id))
      .run();
  });

  return getBill(db, id, today);
}

/**
 * Desfaz um único pagamento. A conta paga só continua paga quando o pagamento
 * removido não é o último (o que a quitou); nesse caso o valor pago passa a
 * ser a soma dos que ficaram. Remover o último reabre a conta, que volta a ter
 * pagamento parcial se ainda restarem pagamentos. O lançamento só é apagado
 * quando foi criado pelo próprio pagamento. Num pagamento agrupado, as demais
 * contas pagas pelo mesmo lançamento também são desfeitas.
 */
export function undoBillPayment(db: AppDatabase, id: number, paymentId: number, today = todayIso()): BillDto {
  loadBillRow(db, id);
  const payment = db
    .select()
    .from(billPayments)
    .where(and(eq(billPayments.id, paymentId), eq(billPayments.billId, id)))
    .get();
  if (!payment) throw notFound('Pagamento não encontrado nesta conta.');
  db.transaction(() => removePayments(db, withGroupMates(db, [payment])));
  return getBill(db, id, today);
}
