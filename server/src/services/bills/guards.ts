/**
 * Proteções do vínculo conta a pagar ↔ lançamento. Este módulo importa apenas
 * o schema: é usado por `transactions.ts` e `transfers.ts`, que por sua vez
 * são usados pelo pagamento de contas — evitar ciclo de imports.
 */
import { eq, inArray } from 'drizzle-orm';
import type { AppDatabase } from '../../db/client';
import { billPayments, scheduledBills } from '../../db/schema';
import { conflict } from '../../lib/errors';

type Reader = Pick<AppDatabase, 'select'>;

export interface BillPaymentLink {
  billId: number;
  description: string;
  dueDate: string;
}

/** Vínculos de pagamento de conta dos lançamentos informados, por id do lançamento. */
export function loadBillPaymentLinks(db: Reader, transactionIds: number[]): Map<number, BillPaymentLink> {
  const result = new Map<number, BillPaymentLink>();
  if (transactionIds.length === 0) return result;
  const rows = db
    .select({
      transactionId: billPayments.transactionId,
      billId: billPayments.billId,
      description: scheduledBills.description,
      dueDate: scheduledBills.dueDate,
    })
    .from(billPayments)
    .innerJoin(scheduledBills, eq(billPayments.billId, scheduledBills.id))
    .where(inArray(billPayments.transactionId, transactionIds))
    .all();
  for (const row of rows) {
    result.set(row.transactionId, {
      billId: row.billId,
      description: row.description,
      dueDate: row.dueDate,
    });
  }
  return result;
}

function describe(link: BillPaymentLink): string {
  const [year, month, day] = link.dueDate.split('-');
  return `"${link.description}" (vencimento ${day}/${month}/${year})`;
}

/** Bloqueia a exclusão de lançamentos que pagam uma conta a pagar. */
export function ensureTransactionsNotBillPayments(db: Reader, transactionIds: number[]): void {
  const links = loadBillPaymentLinks(db, transactionIds);
  const first = links.values().next().value as BillPaymentLink | undefined;
  if (!first) return;
  const extra = links.size > 1 ? ` e mais ${links.size - 1} lançamento(s)` : '';
  throw conflict(
    `O lançamento paga a conta ${describe(first)}${extra}. Desfaça o pagamento da conta antes de excluir.`,
  );
}

/** Um lançamento que paga uma conta precisa continuar sendo saída. */
export function ensureBillPaymentStaysOutflow(db: Reader, transactionId: number, amountCents: number): void {
  if (amountCents < 0) return;
  const link = loadBillPaymentLinks(db, [transactionId]).get(transactionId);
  if (!link) return;
  throw conflict(
    `O lançamento paga a conta ${describe(link)} e precisa continuar como saída. Desfaça o pagamento da conta antes de alterar o sinal.`,
  );
}

/** Um lançamento não pode ser, ao mesmo tempo, pagamento de conta e ponta de transferência. */
export function ensureNotBillPaymentForTransfer(db: Reader, transactionIds: number[]): void {
  const links = loadBillPaymentLinks(db, transactionIds);
  const first = links.values().next().value as BillPaymentLink | undefined;
  if (!first) return;
  throw conflict(
    `O lançamento paga a conta ${describe(first)} e não pode ser vinculado como transferência.`,
  );
}
