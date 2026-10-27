import { and, asc, eq, isNull, lt, lte, notExists, notInArray, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import type { AppDatabase } from '../db/client';
import { daysBetweenIso } from '../lib/dates';
import { badRequest, conflict, notFound, nowIso } from '../lib/errors';
import { categories, paymentBalanceAdjustments, paymentMethods, purchaseItems, purchaseSettlements, purchases, transactions, transfers } from '../db/schema';
import { getPurchase } from './purchases';

export const PURCHASE_MATCH_TOLERANCE_DAYS = 7;

export interface PurchaseReconciliationCandidate {
  transactionId: number; purchaseDate: string; dueDate: string; description: string; amountCents: number;
  paymentMethodId: number; paymentMethodName: string; balanceType: 'credit' | 'debit' | 'wallet' | 'unclassified';
  balanceShortfallCents: number; balanceShortfallDate: string | null; categoryId: number; categoryName: string;
  categoryColor: string | null; dayDistance: number;
}
export interface WalletPaymentInput {
  paymentMethodId: number;
  amountCents: number;
  adjustment?: { amountCents: number; effectiveDate: string; reason: 'opening_balance' | 'cashback' | 'bonus' | 'other'; description: string };
}
export interface PurchaseSettlementInput {
  transactionIds: number[];
  walletPayments: WalletPaymentInput[];
  balanceAdjustments?: Array<{ paymentMethodId: number; amountCents: number; effectiveDate: string; reason: 'opening_balance' | 'cashback' | 'bonus' | 'other'; description: string }>;
  /** Explicit choice; null means deliberately leave uncategorized. */
  categoryId: number | null;
}

function isSettled(db: AppDatabase, purchaseId: number): boolean {
  return Boolean(db.select({ id: purchaseSettlements.id }).from(purchaseSettlements)
    .where(and(eq(purchaseSettlements.purchaseId, purchaseId), isNull(purchaseSettlements.reversedAt))).get());
}

function loadCandidates(db: AppDatabase, purchaseId: number): PurchaseReconciliationCandidate[] {
  const purchase = db.select().from(purchases).where(eq(purchases.id, purchaseId)).get();
  if (!purchase) throw notFound('Compra não encontrada.');
  if (isSettled(db, purchaseId)) return [];
  const purchaseDate = purchase.issuedAt.slice(0, 10);
  const linkedPurchase = alias(purchases, 'linked_purchase');
  const transferExists = db.select({ id: transfers.id }).from(transfers).where(or(
    eq(transfers.outgoingTransactionId, transactions.id), eq(transfers.incomingTransactionId, transactions.id),
  ));
  const activeSettlementExists = db.select({ id: purchaseSettlements.id }).from(purchaseSettlements)
    .where(and(eq(purchaseSettlements.transactionId, transactions.id), isNull(purchaseSettlements.reversedAt)));
  const rows = db.select({
    transactionId: transactions.id, purchaseDate: transactions.purchaseDate, dueDate: transactions.dueDate,
    description: transactions.description, amountCents: transactions.amountCents,
    paymentMethodId: paymentMethods.id, paymentMethodName: paymentMethods.name,
    categoryId: categories.id, categoryName: categories.name, categoryColor: categories.color,
    balanceType: paymentMethods.balanceType,
    classification: categories.classification,
  }).from(transactions)
    .innerJoin(categories, eq(categories.id, transactions.categoryId))
    .innerJoin(paymentMethods, eq(paymentMethods.id, transactions.paymentMethodId))
    .leftJoin(linkedPurchase, eq(linkedPurchase.transactionId, transactions.id))
    .where(and(lt(transactions.amountCents, 0), lte(sql`abs(${transactions.amountCents})`, purchase.totalCents), isNull(transactions.transfer),
      or(isNull(linkedPurchase.id), eq(linkedPurchase.id, purchaseId)),
      notExists(activeSettlementExists),
      or(isNull(categories.classification), notInArray(categories.classification, ['transfer', 'card_settlement'])),
      notExists(transferExists)))
    .orderBy(asc(transactions.purchaseDate), asc(transactions.id)).all();
  return rows.flatMap((row) => {
    const dayDistance = daysBetweenIso(purchaseDate, row.purchaseDate);
    if (dayDistance === null || Math.abs(dayDistance) > PURCHASE_MATCH_TOLERANCE_DAYS) return [];
    const balance = ['debit', 'wallet'].includes(row.balanceType) ? getAccountBalance(db, row.paymentMethodId, row.dueDate) : null;
    return [{ ...row, dayDistance, balanceShortfallCents: Math.max(0, -(balance?.minimumBalanceCents ?? 0)), balanceShortfallDate: balance?.minimumBalanceDate ?? null }];
  }).sort((a, b) => Math.abs(Math.abs(a.amountCents) - purchase.totalCents) - Math.abs(Math.abs(b.amountCents) - purchase.totalCents)
    || Math.abs(a.dayDistance) - Math.abs(b.dayDistance)
    || a.transactionId - b.transactionId);
}

function listActiveSettlements(db: AppDatabase, purchaseId: number) {
  return db.select({ id: purchaseSettlements.id, transactionId: purchaseSettlements.transactionId,
    paymentMethodId: purchaseSettlements.paymentMethodId, paymentMethodName: paymentMethods.name,
    amountCents: purchaseSettlements.amountCents, settlementType: purchaseSettlements.settlementType,
    effectiveDate: purchaseSettlements.effectiveDate,
  }).from(purchaseSettlements).innerJoin(paymentMethods, eq(paymentMethods.id, purchaseSettlements.paymentMethodId))
    .where(and(eq(purchaseSettlements.purchaseId, purchaseId), isNull(purchaseSettlements.reversedAt))).all();
}

export function getPurchaseReconciliationCandidates(db: AppDatabase, purchaseId: number) {
  const purchase = db.select().from(purchases).where(eq(purchases.id, purchaseId)).get();
  if (!purchase) throw notFound('Compra não encontrada.');
  const settlements = listActiveSettlements(db, purchaseId);
  const movementIds = settlements.flatMap((s) => s.transactionId === null ? [] : [s.transactionId]);
  const firstMovementId = movementIds[0];
  const linkedMovement = firstMovementId === undefined ? null : db.select({
    transactionId: transactions.id, purchaseDate: transactions.purchaseDate, dueDate: transactions.dueDate,
    description: transactions.description, amountCents: transactions.amountCents,
    paymentMethodName: paymentMethods.name, categoryId: categories.id, categoryName: categories.name,
    categoryColor: categories.color,
  }).from(transactions).innerJoin(paymentMethods, eq(paymentMethods.id, transactions.paymentMethodId))
    .innerJoin(categories, eq(categories.id, transactions.categoryId)).where(eq(transactions.id, firstMovementId)).get() ?? null;
  const wallets = db.select({ id: paymentMethods.id, name: paymentMethods.name, balanceType: paymentMethods.balanceType })
    .from(paymentMethods).where(eq(paymentMethods.balanceType, 'wallet')).orderBy(asc(paymentMethods.name)).all()
    .map((wallet) => ({ ...wallet, ...getAccountBalance(db, wallet.id, purchase.issuedAt.slice(0, 10)) }));
  return {
    toleranceDays: PURCHASE_MATCH_TOLERANCE_DAYS,
    linkedMovement,
    settlements,
    candidates: settlements.length ? [] : loadCandidates(db, purchaseId),
    wallets,
    totalCents: purchase.totalCents,
    settledCents: settlements.reduce((sum, item) => sum + item.amountCents, 0),
    linkedTransactionIds: movementIds,
  };
}

/** Timeline auditável: transações, créditos de saldo e liquidações de carteira. */
export function getAccountBalance(db: AppDatabase, paymentMethodId: number, asOf?: string) {
  const method = db.select({ balanceType: paymentMethods.balanceType }).from(paymentMethods)
    .where(eq(paymentMethods.id, paymentMethodId)).get();
  if (!method) throw notFound('Forma de pagamento não encontrada.');
  const events = [
    ...db.select({ date: transactions.dueDate, amount: transactions.amountCents }).from(transactions)
      .where(asOf ? and(eq(transactions.paymentMethodId, paymentMethodId), lte(transactions.dueDate, asOf)) : eq(transactions.paymentMethodId, paymentMethodId)).all().map((e) => ({ ...e, priority: 1 })),
    ...db.select({ date: paymentBalanceAdjustments.effectiveDate, amount: paymentBalanceAdjustments.amountCents }).from(paymentBalanceAdjustments)
      .where(asOf ? and(eq(paymentBalanceAdjustments.paymentMethodId, paymentMethodId), lte(paymentBalanceAdjustments.effectiveDate, asOf), isNull(paymentBalanceAdjustments.reversedAt)) : and(eq(paymentBalanceAdjustments.paymentMethodId, paymentMethodId), isNull(paymentBalanceAdjustments.reversedAt))).all().map((e) => ({ ...e, priority: 0 })),
    ...db.select({ date: purchaseSettlements.effectiveDate, amount: sql<number>`-${purchaseSettlements.amountCents}` }).from(purchaseSettlements)
      .where(and(eq(purchaseSettlements.paymentMethodId, paymentMethodId), eq(purchaseSettlements.settlementType, 'wallet'), isNull(purchaseSettlements.reversedAt), ...(asOf ? [lte(purchaseSettlements.effectiveDate, asOf)] : []))).all().map((e) => ({ ...e, priority: 2 })),
  ].sort((a, b) => a.date.localeCompare(b.date) || a.priority - b.priority);
  let balanceCents = 0;
  let minimumBalanceCents = 0;
  let minimumBalanceDate: string | null = null;
  for (const event of events) {
    balanceCents += event.amount;
    if (balanceCents < minimumBalanceCents) {
      minimumBalanceCents = balanceCents;
      minimumBalanceDate = event.date;
    }
  }
  return { balanceType: method.balanceType, balanceCents, minimumBalanceCents, minimumBalanceDate };
}

export function getPaymentBalanceHistory(db: AppDatabase, paymentMethodId: number) {
  const method = db.select({ id: paymentMethods.id, name: paymentMethods.name, balanceType: paymentMethods.balanceType })
    .from(paymentMethods).where(eq(paymentMethods.id, paymentMethodId)).get();
  if (!method) throw notFound('Forma de pagamento não encontrada.');
  const adjustments = db.select({ id: paymentBalanceAdjustments.id, effectiveDate: paymentBalanceAdjustments.effectiveDate,
    amountCents: paymentBalanceAdjustments.amountCents, reason: paymentBalanceAdjustments.reason, reversedAt: paymentBalanceAdjustments.reversedAt,
    description: paymentBalanceAdjustments.description, kind: sql<string>`'adjustment'` })
    .from(paymentBalanceAdjustments).where(eq(paymentBalanceAdjustments.paymentMethodId, paymentMethodId)).all();
  const settlements = db.select({ id: purchaseSettlements.id, effectiveDate: purchaseSettlements.effectiveDate,
    amountCents: sql<number>`-${purchaseSettlements.amountCents}`, reason: sql<string>`'purchase_payment'`,
    description: sql<string>`'Pagamento de compra #' || ${purchaseSettlements.purchaseId}`, kind: sql<string>`'settlement'`, reversedAt: purchaseSettlements.reversedAt })
    .from(purchaseSettlements).where(eq(purchaseSettlements.paymentMethodId, paymentMethodId)).all();
  return { account: method, balance: getAccountBalance(db, paymentMethodId), events: [...adjustments, ...settlements].sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate)) };
}

function assertNonNegativeChronologicalBalance(db: AppDatabase, accountId: number) {
  const method = db.select({ balanceType: paymentMethods.balanceType }).from(paymentMethods).where(eq(paymentMethods.id, accountId)).get();
  if (!method || !['wallet', 'debit'].includes(method.balanceType)) return;
  const events = [
    ...db.select({ date: transactions.dueDate, amount: transactions.amountCents }).from(transactions).where(eq(transactions.paymentMethodId, accountId)).all().map((e) => ({ ...e, priority: 1 })),
    ...db.select({ date: paymentBalanceAdjustments.effectiveDate, amount: paymentBalanceAdjustments.amountCents }).from(paymentBalanceAdjustments).where(and(eq(paymentBalanceAdjustments.paymentMethodId, accountId), isNull(paymentBalanceAdjustments.reversedAt))).all().map((e) => ({ ...e, priority: 0 })),
    ...db.select({ date: purchaseSettlements.effectiveDate, amount: sql<number>`-${purchaseSettlements.amountCents}` }).from(purchaseSettlements)
      .where(and(eq(purchaseSettlements.paymentMethodId, accountId), eq(purchaseSettlements.settlementType, 'wallet'), isNull(purchaseSettlements.reversedAt))).all().map((e) => ({ ...e, priority: 2 })),
  ].sort((a, b) => a.date.localeCompare(b.date) || a.priority - b.priority);
  let balance = 0;
  for (const event of events) {
    balance += event.amount;
    if (balance < 0) throw badRequest(`Saldo insuficiente na conta/carteira ${accountId}; faltam ${Math.abs(balance)} centavos em ${event.date}.`);
  }
}

export function reconcilePurchase(db: AppDatabase, purchaseId: number, input: PurchaseSettlementInput) {
  const reconciledAt = nowIso();
  db.transaction((tx) => {
    const purchase = tx.select().from(purchases).where(eq(purchases.id, purchaseId)).get();
    if (!purchase) throw notFound('Compra não encontrada.');
    if (isSettled(tx as unknown as AppDatabase, purchaseId)) throw conflict('Esta compra já está conciliada.');
    if (input.transactionIds.length > 100 || input.walletPayments.length > 20) throw badRequest('Limite de pagamentos excedido.');
    if (new Set(input.transactionIds).size !== input.transactionIds.length) throw badRequest('Movimentação repetida na seleção.');
    const selected = new Set(input.transactionIds);
    const candidates = loadCandidates(tx as unknown as AppDatabase, purchaseId);
    const chosen = candidates.filter((candidate) => selected.has(candidate.transactionId));
    if (chosen.length !== selected.size) throw badRequest('Uma movimentação não corresponde à compra ou já foi conciliada.');
    if (input.categoryId !== null && !tx.select({ id: categories.id }).from(categories).where(eq(categories.id, input.categoryId)).get()) throw badRequest('Categoria inválida.');
    const movementTotal = chosen.reduce((sum, item) => sum + Math.abs(item.amountCents), 0);
    const walletTotal = input.walletPayments.reduce((sum, item) => sum + item.amountCents, 0);
    if (input.walletPayments.some((item) => !Number.isSafeInteger(item.amountCents) || item.amountCents <= 0)) throw badRequest('Valor de carteira inválido.');
    const total = movementTotal + walletTotal;
    if (total !== purchase.totalCents) throw badRequest(`Os pagamentos somam ${total} centavos; o total da compra é ${purchase.totalCents} centavos.`);
    const categorySet = new Set(chosen.map((item) => item.categoryId));
    if (categorySet.size > 1 && input.categoryId === null) throw badRequest('Escolha explicitamente uma categoria para a compra quando os pagamentos têm categorias diferentes.');

    const effectiveDate = purchase.issuedAt.slice(0, 10);
    const accounts = new Set<number>();
    for (const adjustment of input.balanceAdjustments ?? []) {
      const account = tx.select({ balanceType: paymentMethods.balanceType }).from(paymentMethods).where(eq(paymentMethods.id, adjustment.paymentMethodId)).get();
      if (!account || !['debit', 'wallet'].includes(account.balanceType)) throw badRequest('O ajuste precisa pertencer a uma conta de débito ou carteira.');
      if (!Number.isSafeInteger(adjustment.amountCents) || adjustment.amountCents <= 0 || adjustment.effectiveDate > effectiveDate || !adjustment.description.trim()) throw badRequest('Crédito retroativo inválido; a data deve ser anterior ou igual à compra.');
      tx.insert(paymentBalanceAdjustments).values({ ...adjustment, purchaseId, description: adjustment.description.trim() }).run();
      accounts.add(adjustment.paymentMethodId);
    }
    for (const candidate of chosen) {
      const movement = tx.select({ paymentMethodId: transactions.paymentMethodId }).from(transactions).where(eq(transactions.id, candidate.transactionId)).get();
      if (!movement) throw badRequest('Movimentação indisponível.');
      accounts.add(movement.paymentMethodId);
      tx.insert(purchaseSettlements).values({ purchaseId, transactionId: candidate.transactionId, paymentMethodId: movement.paymentMethodId,
        amountCents: Math.abs(candidate.amountCents), settlementType: 'movement', effectiveDate: candidate.purchaseDate }).run();
    }
    for (const allocation of input.walletPayments) {
      const wallet = tx.select({ balanceType: paymentMethods.balanceType }).from(paymentMethods).where(eq(paymentMethods.id, allocation.paymentMethodId)).get();
      if (!wallet || wallet.balanceType !== 'wallet') throw badRequest('Selecione uma carteira válida.');
      if (allocation.adjustment) {
        const adjustment = allocation.adjustment;
        if (!Number.isSafeInteger(adjustment.amountCents) || adjustment.amountCents <= 0 || adjustment.effectiveDate > effectiveDate || !adjustment.description.trim()) throw badRequest('Crédito retroativo inválido; a data deve ser anterior ou igual à compra.');
        tx.insert(paymentBalanceAdjustments).values({ purchaseId, paymentMethodId: allocation.paymentMethodId, effectiveDate: adjustment.effectiveDate,
          amountCents: adjustment.amountCents, reason: adjustment.reason, description: adjustment.description.trim() }).run();
      }
      tx.insert(purchaseSettlements).values({ purchaseId, transactionId: null, paymentMethodId: allocation.paymentMethodId,
        amountCents: allocation.amountCents, settlementType: 'wallet', effectiveDate }).run();
      accounts.add(allocation.paymentMethodId);
    }
    for (const accountId of accounts) assertNonNegativeChronologicalBalance(tx as unknown as AppDatabase, accountId);
    tx.update(purchases).set({ transactionId: chosen[0]?.transactionId ?? null, reconciledAt,
      reconciliationPreviousCategoryId: purchase.categoryId, categoryId: input.categoryId }).where(eq(purchases.id, purchaseId)).run();
    tx.update(purchaseItems).set({ reconciliationPreviousCategoryId: purchaseItems.categoryId, categoryId: input.categoryId })
      .where(eq(purchaseItems.purchaseId, purchaseId)).run();
  });
  return getPurchase(db, purchaseId);
}

/** Compatibilidade de chamada antiga mantida para consumidores não migrados; UI/API usam reconcilePurchase. */
export function reconcilePurchaseWithTransaction(db: AppDatabase, purchaseId: number, transactionId: number) {
  const candidates = loadCandidates(db, purchaseId);
  const candidate = candidates.find((item) => item.transactionId === transactionId);
  if (!candidate) throw badRequest('A movimentação não corresponde ao valor/data desta compra ou já está conciliada.');
  return reconcilePurchase(db, purchaseId, { transactionIds: [transactionId], walletPayments: [], categoryId: candidate.categoryId });
}

export function undoPurchaseReconciliation(db: AppDatabase, purchaseId: number) {
  db.transaction((tx) => {
    const purchase = tx.select().from(purchases).where(eq(purchases.id, purchaseId)).get();
    if (!purchase) throw notFound('Compra não encontrada.');
    if (!isSettled(tx as unknown as AppDatabase, purchaseId)) throw conflict('Esta compra ainda não está conciliada.');
    const reversedAt = nowIso();
    tx.update(purchaseSettlements).set({ reversedAt }).where(and(eq(purchaseSettlements.purchaseId, purchaseId), isNull(purchaseSettlements.reversedAt))).run();
    tx.update(purchases).set({ transactionId: null, reconciledAt: null, categoryId: purchase.reconciliationPreviousCategoryId,
      reconciliationPreviousCategoryId: null }).where(eq(purchases.id, purchaseId)).run();
    tx.update(purchaseItems).set({ categoryId: purchaseItems.reconciliationPreviousCategoryId, reconciliationPreviousCategoryId: null })
      .where(eq(purchaseItems.purchaseId, purchaseId)).run();
  });
  return getPurchase(db, purchaseId);
}
