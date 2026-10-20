import { and, eq, inArray, or } from 'drizzle-orm';
import type { AppDatabase } from '../db/client';
import {
  categories,
  paymentMethods,
  transactions,
  transferRejections,
  transfers,
} from '../db/schema';
import { conflict, notFound } from '../lib/errors';

export type TransferExecutor = Pick<AppDatabase, 'select' | 'insert' | 'update' | 'delete'>;

export type TransferConfidence = 'high' | 'probable' | 'manual';
export type TransferOrigin = 'import' | 'manual';

export interface TransferLegDto {
  id: number;
  description: string;
  amountCents: number;
  dueDate: string;
  purchaseDate: string;
  paymentMethodId: number;
  paymentMethodName: string;
  categoryName: string;
  transfer: string | null;
}

export interface TransferLinkDto {
  id: number;
  direction: 'out' | 'in';
  confidence: string;
  origin: string;
  counterpart: TransferLegDto;
  sourceAccount: string;
  destinationAccount: string;
}

export type TransferContext = Map<number, TransferLinkDto>;

export interface LinkTransferInput {
  outgoingTransactionId: number;
  incomingTransactionId: number;
  confidence?: string;
  origin?: TransferOrigin;
}

function legSelect(db: TransferExecutor) {
  return db
    .select({
      id: transactions.id,
      description: transactions.description,
      amountCents: transactions.amountCents,
      dueDate: transactions.dueDate,
      purchaseDate: transactions.purchaseDate,
      paymentMethodId: transactions.paymentMethodId,
      paymentMethodName: paymentMethods.name,
      categoryName: categories.name,
      transfer: transactions.transfer,
    })
    .from(transactions)
    .innerJoin(paymentMethods, eq(transactions.paymentMethodId, paymentMethods.id))
    .innerJoin(categories, eq(transactions.categoryId, categories.id));
}

function loadLegs(db: TransferExecutor, ids: number[]): Map<number, TransferLegDto> {
  if (ids.length === 0) return new Map();
  const rows = legSelect(db).where(inArray(transactions.id, ids)).all();
  return new Map(rows.map((row) => [row.id, row]));
}

/** Mapa transactionId -> vínculo de transferência confirmado. */
export function getTransferContext(db: AppDatabase, ids: number[]): TransferContext {
  const context: TransferContext = new Map();
  const unique = [...new Set(ids)].filter((id) => Number.isInteger(id) && id > 0);
  if (unique.length === 0) return context;

  const links = db
    .select()
    .from(transfers)
    .where(
      or(
        inArray(transfers.outgoingTransactionId, unique),
        inArray(transfers.incomingTransactionId, unique),
      ),
    )
    .all();
  if (links.length === 0) return context;

  const relatedIds = new Set<number>();
  for (const link of links) {
    relatedIds.add(link.outgoingTransactionId);
    relatedIds.add(link.incomingTransactionId);
  }
  const legs = loadLegs(db, [...relatedIds]);

  for (const link of links) {
    const outgoing = legs.get(link.outgoingTransactionId);
    const incoming = legs.get(link.incomingTransactionId);
    if (!outgoing || !incoming) continue;

    const sourceAccount = outgoing.paymentMethodName;
    const destinationAccount = incoming.paymentMethodName;

    if (unique.includes(link.outgoingTransactionId)) {
      context.set(link.outgoingTransactionId, {
        id: link.id,
        direction: 'out',
        confidence: link.confidence,
        origin: link.origin,
        counterpart: incoming,
        sourceAccount,
        destinationAccount,
      });
    }
    if (unique.includes(link.incomingTransactionId)) {
      context.set(link.incomingTransactionId, {
        id: link.id,
        direction: 'in',
        confidence: link.confidence,
        origin: link.origin,
        counterpart: outgoing,
        sourceAccount,
        destinationAccount,
      });
    }
  }

  return context;
}

export function findActiveLink(db: TransferExecutor, transactionIds: number[]) {
  const unique = [...new Set(transactionIds)].filter((id) => Number.isInteger(id) && id > 0);
  if (unique.length === 0) return [];
  return db
    .select()
    .from(transfers)
    .where(
      or(
        inArray(transfers.outgoingTransactionId, unique),
        inArray(transfers.incomingTransactionId, unique),
      ),
    )
    .all();
}

function validatePair(outgoing: TransferLegDto, incoming: TransferLegDto): void {
  if (outgoing.id === incoming.id) {
    throw conflict('A transferência precisa envolver dois lançamentos diferentes.');
  }
  if (outgoing.amountCents >= 0) {
    throw conflict('A saída da transferência deve ter valor negativo.');
  }
  if (incoming.amountCents <= 0) {
    throw conflict('A entrada da transferência deve ter valor positivo.');
  }
  if (Math.abs(outgoing.amountCents) !== Math.abs(incoming.amountCents)) {
    throw conflict('Os valores de saída e entrada da transferência precisam ter o mesmo módulo.');
  }
  if (outgoing.paymentMethodId === incoming.paymentMethodId) {
    throw conflict('A transferência precisa sair de uma conta e entrar em outra diferente.');
  }
}

export function validateTransferPair(outgoing: TransferLegDto, incoming: TransferLegDto): void {
  validatePair(outgoing, incoming);
}

/** Carrega as duas pontas de um par para validação fora deste serviço. */
export function loadTransferLegs(db: TransferExecutor, ids: number[]) {
  return loadLegs(db, ids);
}

/** Insere o vínculo dentro de uma transação já aberta (usado pela importação). */
export function insertTransferRecord(db: TransferExecutor, input: LinkTransferInput) {
  const legs = loadLegs(db, [input.outgoingTransactionId, input.incomingTransactionId]);
  const outgoing = legs.get(input.outgoingTransactionId);
  const incoming = legs.get(input.incomingTransactionId);
  if (!outgoing) throw notFound('Lançamento de saída não encontrado.');
  if (!incoming) throw notFound('Lançamento de entrada não encontrado.');

  validatePair(outgoing, incoming);

  const existing = findActiveLink(db, [outgoing.id, incoming.id]);
  if (existing.length > 0) {
    throw conflict('Um dos lançamentos já participa de outra transferência.');
  }

  const inserted = db
    .insert(transfers)
    .values({
      outgoingTransactionId: outgoing.id,
      incomingTransactionId: incoming.id,
      confidence: input.confidence ?? 'manual',
      origin: input.origin ?? 'manual',
    })
    .returning()
    .get();

  // Um par confirmado deixa de ser uma rejeição ativa.
  db.delete(transferRejections)
    .where(
      or(
        and(
          eq(transferRejections.outgoingTransactionId, outgoing.id),
          eq(transferRejections.incomingTransactionId, incoming.id),
        ),
        and(
          eq(transferRejections.outgoingTransactionId, incoming.id),
          eq(transferRejections.incomingTransactionId, outgoing.id),
        ),
      ),
    )
    .run();

  return inserted;
}

export function linkTransfer(db: AppDatabase, input: LinkTransferInput) {
  return db.transaction((tx) => insertTransferRecord(tx, input));
}

export function unlinkTransfer(db: AppDatabase, transferId: number): { removed: true } {
  const result = db.delete(transfers).where(eq(transfers.id, transferId)).run();
  if (result.changes === 0) throw notFound('Transferência não encontrada.');
  return { removed: true };
}

/** Valida se um lançamento pode ser excluído sem quebrar transferências. */
export function ensureTransactionCanBeRemoved(db: AppDatabase, ids: number[]): void {
  const links = findActiveLink(db, ids);
  if (links.length > 0) {
    throw conflict(
      'Há lançamento(s) vinculado(s) a uma transferência confirmada. Desvincule a transferência antes de excluir.',
    );
  }
}

/**
 * Verifica se uma troca de forma de pagamento manteria os pares de transferência válidos.
 * Retorna a lista de vínculos que ficariam inválidos.
 */
export function findTransfersBrokenByPaymentChange(
  db: AppDatabase,
  transactionIds: number[],
  newPaymentMethodId: number,
): number[] {
  const unique = [...new Set(transactionIds)].filter((id) => Number.isInteger(id) && id > 0);
  if (unique.length === 0) return [];

  const links = findActiveLink(db, unique);
  if (links.length === 0) return [];

  const allIds = new Set<number>();
  for (const link of links) {
    allIds.add(link.outgoingTransactionId);
    allIds.add(link.incomingTransactionId);
  }
  const legs = loadLegs(db, [...allIds]);
  const updating = new Set(unique);
  const broken: number[] = [];

  for (const link of links) {
    const outgoing = legs.get(link.outgoingTransactionId);
    const incoming = legs.get(link.incomingTransactionId);
    if (!outgoing || !incoming) continue;
    const outgoingPayment = updating.has(outgoing.id) ? newPaymentMethodId : outgoing.paymentMethodId;
    const incomingPayment = updating.has(incoming.id) ? newPaymentMethodId : incoming.paymentMethodId;
    if (outgoingPayment === incomingPayment) broken.push(link.id);
  }

  return broken;
}

export function ensureUpdateKeepsTransfer(
  db: AppDatabase,
  transactionId: number,
  changes: { amountCents: number; paymentMethodId: number },
): void {
  const link = findActiveLink(db, [transactionId])[0];
  if (!link) return;

  const counterpartId =
    link.outgoingTransactionId === transactionId
      ? link.incomingTransactionId
      : link.outgoingTransactionId;
  const legs = loadLegs(db, [transactionId, counterpartId]);
  const current = legs.get(transactionId);
  const counterpart = legs.get(counterpartId);
  if (!current || !counterpart) return;

  const updated: TransferLegDto = {
    ...current,
    amountCents: changes.amountCents,
    paymentMethodId: changes.paymentMethodId,
  };
  const outgoing = link.outgoingTransactionId === transactionId ? updated : counterpart;
  const incoming = link.incomingTransactionId === transactionId ? updated : counterpart;
  validatePair(outgoing, incoming);
}

export function ensurePaymentChangeKeepsTransfers(
  db: AppDatabase,
  transactionIds: number[],
  newPaymentMethodId: number,
): void {
  const broken = findTransfersBrokenByPaymentChange(db, transactionIds, newPaymentMethodId);
  if (broken.length > 0) {
    throw conflict(
      'A troca de forma de pagamento deixaria uma ou mais transferências com a mesma conta nos dois lados. Desvincule-as antes de continuar.',
    );
  }
}
