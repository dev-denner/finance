import { and, eq, or } from 'drizzle-orm';
import type { AppDatabase } from '../db/client';
import { transferRejections, transfers } from '../db/schema';
import { notFound } from '../lib/errors';
import { normalizeName } from '../lib/normalize';
import {
  detectTransferCandidates,
  hasTransferHint,
  loadUnlinkedDatabaseParties,
  type TransferCandidate,
  type TransferParty,
} from './transfer-detection';
import {
  loadTransferLegs,
  validateTransferPair,
  type TransferLegDto,
} from './transfers';

export interface ConfirmedTransferRecord {
  id: number;
  confidence: string;
  origin: string;
  createdAt: string;
  outgoing: TransferLegDto;
  incoming: TransferLegDto;
}

export interface RejectedTransferRecord {
  id: number;
  signature: string;
  signatureMatches: boolean;
  createdAt: string;
  outgoing: TransferLegDto;
  incoming: TransferLegDto;
}

export interface ReconciliationResult {
  toleranceDays: number;
  confirmed: ConfirmedTransferRecord[];
  candidates: TransferCandidate[];
  unmatched: TransferParty[];
  rejected: RejectedTransferRecord[];
  summary: {
    confirmed: number;
    candidates: number;
    unmatched: number;
    rejected: number;
  };
}

/**
 * Assinatura dos dados relevantes do par. Se um lançamento mudar de valor,
 * data, conta ou descrição, uma rejeição antiga deixa de valer.
 */
export function transferPairSignature(
  outgoing: TransferLegDto,
  incoming: TransferLegDto,
): string {
  const leg = (item: TransferLegDto) =>
    [
      item.id,
      item.amountCents,
      item.dueDate,
      item.purchaseDate,
      item.paymentMethodId,
      normalizeName(item.description),
    ].join(':');
  return `${leg(outgoing)}|${leg(incoming)}`;
}

function pairKey(outgoingId: number, incomingId: number): string {
  return `${outgoingId}:${incomingId}`;
}

export function isTransferLikeParty(party: TransferParty): boolean {
  return (
    Boolean(party.transfer?.trim()) ||
    party.classification === 'transfer' ||
    party.classification === 'card_settlement' ||
    hasTransferHint(party.description)
  );
}

export function listConfirmedTransfers(db: AppDatabase): ConfirmedTransferRecord[] {
  const rows = db.select().from(transfers).all();
  if (rows.length === 0) return [];
  const ids = new Set<number>();
  for (const row of rows) {
    ids.add(row.outgoingTransactionId);
    ids.add(row.incomingTransactionId);
  }
  const legs = loadTransferLegs(db, [...ids]);
  const result: ConfirmedTransferRecord[] = [];
  for (const row of rows) {
    const outgoing = legs.get(row.outgoingTransactionId);
    const incoming = legs.get(row.incomingTransactionId);
    if (!outgoing || !incoming) continue;
    result.push({
      id: row.id,
      confidence: row.confidence,
      origin: row.origin,
      createdAt: row.createdAt,
      outgoing,
      incoming,
    });
  }
  return result;
}

export function getReconciliation(
  db: AppDatabase,
  options: { toleranceDays?: number; includeRejected?: boolean } = {},
): ReconciliationResult {
  const toleranceDays = Math.max(0, options.toleranceDays ?? 3);
  const includeRejected = options.includeRejected ?? false;

  const parties = loadUnlinkedDatabaseParties(db);
  const allCandidates = detectTransferCandidates(parties, {
    toleranceDays,
    allowDatabasePairs: true,
  });

  const rejectionRows = db.select().from(transferRejections).all();
  const rejectionIds = new Set<number>();
  for (const row of rejectionRows) {
    rejectionIds.add(row.outgoingTransactionId);
    rejectionIds.add(row.incomingTransactionId);
  }
  const rejectionLegs = loadTransferLegs(db, [...rejectionIds]);

  const activeRejections = new Set<string>();
  const rejected: RejectedTransferRecord[] = [];
  for (const row of rejectionRows) {
    const outgoing = rejectionLegs.get(row.outgoingTransactionId);
    const incoming = rejectionLegs.get(row.incomingTransactionId);
    if (!outgoing || !incoming) continue;
    const currentSignature = transferPairSignature(outgoing, incoming);
    const signatureMatches = currentSignature === row.signature;
    if (signatureMatches) {
      activeRejections.add(pairKey(outgoing.id, incoming.id));
    }
    rejected.push({
      id: row.id,
      signature: row.signature,
      signatureMatches,
      createdAt: row.createdAt,
      outgoing,
      incoming,
    });
  }

  const candidates = allCandidates.filter((candidate) => {
    const outgoingId = candidate.outgoing.transactionId;
    const incomingId = candidate.incoming.transactionId;
    if (outgoingId === null || incomingId === null) return true;
    if (includeRejected) return true;
    return !activeRejections.has(pairKey(outgoingId, incomingId));
  });

  // Lançamentos que já formam algum par candidato não são "sem contraparte",
  // mesmo quando o par foi rejeitado (ele aparece na seção de rejeitados).
  const pairedTransactionIds = new Set<number>();
  for (const candidate of allCandidates) {
    if (candidate.outgoing.transactionId !== null) {
      pairedTransactionIds.add(candidate.outgoing.transactionId);
    }
    if (candidate.incoming.transactionId !== null) {
      pairedTransactionIds.add(candidate.incoming.transactionId);
    }
  }

  const unmatched = parties.filter(
    (party) =>
      party.transactionId !== null &&
      !pairedTransactionIds.has(party.transactionId) &&
      isTransferLikeParty(party),
  );

  const confirmed = listConfirmedTransfers(db);

  return {
    toleranceDays,
    confirmed,
    candidates,
    unmatched,
    rejected,
    summary: {
      confirmed: confirmed.length,
      candidates: candidates.length,
      unmatched: unmatched.length,
      rejected: rejected.length,
    },
  };
}

export function rejectTransferPair(
  db: AppDatabase,
  outgoingTransactionId: number,
  incomingTransactionId: number,
): RejectedTransferRecord {
  const legs = loadTransferLegs(db, [outgoingTransactionId, incomingTransactionId]);
  const outgoing = legs.get(outgoingTransactionId);
  const incoming = legs.get(incomingTransactionId);
  if (!outgoing) throw notFound('Lançamento de saída não encontrado.');
  if (!incoming) throw notFound('Lançamento de entrada não encontrado.');
  validateTransferPair(outgoing, incoming);

  const signature = transferPairSignature(outgoing, incoming);

  return db.transaction((tx) => {
    tx.delete(transferRejections)
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
    const inserted = tx
      .insert(transferRejections)
      .values({
        outgoingTransactionId: outgoing.id,
        incomingTransactionId: incoming.id,
        signature,
      })
      .returning()
      .get();
    return {
      id: inserted.id,
      signature: inserted.signature,
      signatureMatches: true,
      createdAt: inserted.createdAt,
      outgoing,
      incoming,
    };
  });
}

export function clearTransferRejection(
  db: AppDatabase,
  outgoingTransactionId: number,
  incomingTransactionId: number,
): { removed: number } {
  const result = db
    .delete(transferRejections)
    .where(
      or(
        and(
          eq(transferRejections.outgoingTransactionId, outgoingTransactionId),
          eq(transferRejections.incomingTransactionId, incomingTransactionId),
        ),
        and(
          eq(transferRejections.outgoingTransactionId, incomingTransactionId),
          eq(transferRejections.incomingTransactionId, outgoingTransactionId),
        ),
      ),
    )
    .run();
  return { removed: result.changes };
}

export function clearAllTransferRejections(db: AppDatabase): { removed: number } {
  const result = db.delete(transferRejections).run();
  return { removed: result.changes };
}

/** Verifica se um par já foi rejeitado com os dados atuais (usado em candidatos manuais). */
export function isPairRejected(
  db: AppDatabase,
  outgoingTransactionId: number,
  incomingTransactionId: number,
): boolean {
  const row = db
    .select()
    .from(transferRejections)
    .where(
      or(
        and(
          eq(transferRejections.outgoingTransactionId, outgoingTransactionId),
          eq(transferRejections.incomingTransactionId, incomingTransactionId),
        ),
        and(
          eq(transferRejections.outgoingTransactionId, incomingTransactionId),
          eq(transferRejections.incomingTransactionId, outgoingTransactionId),
        ),
      ),
    )
    .get();
  if (!row) return false;
  const legs = loadTransferLegs(db, [outgoingTransactionId, incomingTransactionId]);
  const outgoing = legs.get(row.outgoingTransactionId);
  const incoming = legs.get(row.incomingTransactionId);
  if (!outgoing || !incoming) return false;
  return transferPairSignature(outgoing, incoming) === row.signature;
}
