import { desc, eq, sql } from 'drizzle-orm';
import type { AppDatabase } from '../db/client';
import { categories, paymentMethods, transactions } from '../db/schema';
import { formatBRL } from '../lib/money';
import { normalizeName } from '../lib/normalize';

export interface TransferParty {
  key: string;
  source: 'file' | 'database';
  rowNumber: number | null;
  transactionId: number | null;
  dueDate: string;
  purchaseDate: string;
  description: string;
  amountCents: number;
  paymentMethod: string;
  transfer: string | null;
  category?: string;
  /** Classificação semântica da categoria (transfer, card_settlement...). */
  classification?: string | null;
}

export interface TransferCandidate {
  key: string;
  confidence: 'high' | 'possible';
  ambiguous: boolean;
  reasons: string[];
  dayDistance: number;
  outgoing: TransferParty;
  incoming: TransferParty;
}

export interface DetectTransferOptions {
  toleranceDays?: number;
  maxCandidates?: number;
  /** Permite pares entre dois lançamentos já gravados (usado no vínculo manual). */
  allowDatabasePairs?: boolean;
}

const DEFAULT_TOLERANCE_DAYS = 3;
const DEFAULT_MAX_CANDIDATES = 500;

const TRANSFER_HINT =
  /\b(transfer\w*|transf|pix|ted|doc|entre\s+contas|entre\s+as\s+contas|minha\s+conta|conta\s+propria|mesma\s+titularidade|aplicacao|resgate|aporte)\b/i;

export function hasTransferHint(description: string): boolean {
  return TRANSFER_HINT.test(normalizeName(description));
}

function toDay(iso: string): number {
  const [year, month, day] = iso.slice(0, 10).split('-').map(Number);
  if (!year || !month || !day) return Number.NaN;
  return Date.UTC(year, month - 1, day) / 86_400_000;
}

function dayDistance(left: TransferParty, right: TransferParty): number {
  const candidates = [
    Math.abs(toDay(left.dueDate) - toDay(right.dueDate)),
    Math.abs(toDay(left.purchaseDate) - toDay(right.purchaseDate)),
  ].filter((value) => Number.isFinite(value));
  return candidates.length > 0 ? Math.min(...candidates) : Number.POSITIVE_INFINITY;
}

function partyLabel(party: TransferParty): string {
  return party.source === 'file' ? `arquivo (linha ${party.rowNumber})` : `lançamento #${party.transactionId}`;
}

function buildReasonList(
  outgoing: TransferParty,
  incoming: TransferParty,
  distance: number,
): { reasons: string[]; markers: number; hints: number } {
  const reasons: string[] = [];
  reasons.push(`Valor absoluto igual (${formatBRL(Math.abs(outgoing.amountCents))})`);
  reasons.push('Sinais opostos (saída e entrada)');
  reasons.push(`Contas diferentes (${outgoing.paymentMethod} → ${incoming.paymentMethod})`);

  if (distance === 0) reasons.push('Datas iguais');
  else if (Number.isFinite(distance)) reasons.push(`Datas próximas (${distance} dia(s) de diferença)`);

  const outgoingMarker = Boolean(outgoing.transfer?.trim());
  const incomingMarker = Boolean(incoming.transfer?.trim());
  const markers = (outgoingMarker ? 1 : 0) + (incomingMarker ? 1 : 0);
  if (markers === 2) reasons.push('Coluna Transf marcada nos dois lançamentos');
  else if (markers === 1) {
    reasons.push(
      `Coluna Transf marcada ${outgoingMarker ? `na saída (${partyLabel(outgoing)})` : `na entrada (${partyLabel(incoming)})`}`,
    );
  }

  const outgoingHint = hasTransferHint(outgoing.description);
  const incomingHint = hasTransferHint(incoming.description);
  const descriptionHints = (outgoingHint ? 1 : 0) + (incomingHint ? 1 : 0);
  if (descriptionHints === 2) reasons.push('Descrições indicam transferência/PIX/TED');
  else if (descriptionHints === 1) reasons.push('Uma das descrições indica transferência/PIX/TED');

  const outgoingTransferClass = outgoing.classification === 'transfer';
  const incomingTransferClass = incoming.classification === 'transfer';
  const classificationMarkers =
    (outgoingTransferClass ? 1 : 0) + (incomingTransferClass ? 1 : 0);
  if (classificationMarkers === 2) reasons.push('Categorias classificadas como transferência interna');
  else if (classificationMarkers === 1) {
    reasons.push(
      `Categoria classificada como transferência ${outgoingTransferClass ? 'na saída' : 'na entrada'}`,
    );
  }

  const outgoingSettlement = outgoing.classification === 'card_settlement';
  const incomingSettlement = incoming.classification === 'card_settlement';
  const classificationHints = (outgoingSettlement ? 1 : 0) + (incomingSettlement ? 1 : 0);
  if (classificationHints > 0) {
    reasons.push('Categoria classificada como pagamento/liquidação de cartão');
  }

  return {
    reasons,
    markers: markers + classificationMarkers,
    hints: descriptionHints + classificationHints,
  };
}

function classificationPriority(party: TransferParty): number {
  if (party.classification === 'transfer') return 0;
  if (party.classification === 'card_settlement') return 1;
  return 2;
}

function pairClassificationPriority(candidate: TransferCandidate): number {
  return Math.min(
    classificationPriority(candidate.outgoing),
    classificationPriority(candidate.incoming),
  );
}

/**
 * Detecta pares candidatos de transferência entre lançamentos do arquivo e já existentes.
 *
 * Regras mínimas: mesmo módulo de valor, sinais opostos, contas diferentes e datas dentro
 * da tolerância. Evidências extra (coluna Transf ou descrição) elevam a confiança.
 */
export function detectTransferCandidates(
  parties: TransferParty[],
  options: DetectTransferOptions = {},
): TransferCandidate[] {
  const tolerance = Math.max(0, options.toleranceDays ?? DEFAULT_TOLERANCE_DAYS);
  const maxCandidates = options.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
  const allowDatabasePairs = options.allowDatabasePairs ?? false;

  const byAmount = new Map<number, { outgoing: TransferParty[]; incoming: TransferParty[] }>();
  for (const party of parties) {
    const amount = Math.abs(party.amountCents);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const group = byAmount.get(amount) ?? { outgoing: [], incoming: [] };
    if (party.amountCents < 0) group.outgoing.push(party);
    else if (party.amountCents > 0) group.incoming.push(party);
    byAmount.set(amount, group);
  }

  const candidates: TransferCandidate[] = [];
  const seen = new Set<string>();

  for (const group of byAmount.values()) {
    for (const outgoing of group.outgoing) {
      for (const incoming of group.incoming) {
        if (outgoing.key === incoming.key) continue;
        if (
          outgoing.source === 'database' &&
          incoming.source === 'database' &&
          !allowDatabasePairs
        ) {
          continue;
        }
        if (normalizeName(outgoing.paymentMethod) === normalizeName(incoming.paymentMethod)) continue;

        const distance = dayDistance(outgoing, incoming);
        if (!Number.isFinite(distance) || distance > tolerance) continue;

        const pairKey = `${outgoing.key}~${incoming.key}`;
        if (seen.has(pairKey)) continue;
        seen.add(pairKey);

        const { reasons, markers, hints } = buildReasonList(outgoing, incoming, distance);
        const strongEvidence =
          markers >= 2 ||
          (markers >= 1 && hints >= 1) ||
          (markers >= 1 && distance === 0) ||
          (hints >= 2 && distance <= 1);

        candidates.push({
          key: pairKey,
          confidence: strongEvidence ? 'high' : 'possible',
          ambiguous: false,
          reasons,
          dayDistance: distance,
          outgoing,
          incoming,
        });
      }
    }
  }

  const perParty = new Map<string, number>();
  for (const candidate of candidates) {
    perParty.set(candidate.outgoing.key, (perParty.get(candidate.outgoing.key) ?? 0) + 1);
    perParty.set(candidate.incoming.key, (perParty.get(candidate.incoming.key) ?? 0) + 1);
  }

  for (const candidate of candidates) {
    const ambiguous =
      (perParty.get(candidate.outgoing.key) ?? 0) > 1 ||
      (perParty.get(candidate.incoming.key) ?? 0) > 1;
    if (ambiguous) {
      candidate.ambiguous = true;
      candidate.confidence = 'possible';
      candidate.reasons.push('Múltiplos pares candidatos para o mesmo lançamento');
    }
  }

  candidates.sort((left, right) => {
    const priorityDiff = pairClassificationPriority(left) - pairClassificationPriority(right);
    if (priorityDiff !== 0) return priorityDiff;
    if (left.confidence !== right.confidence) return left.confidence === 'high' ? -1 : 1;
    if (left.dayDistance !== right.dayDistance) return left.dayDistance - right.dayDistance;
    return left.key.localeCompare(right.key);
  });

  return candidates.slice(0, maxCandidates);
}

export function fileParty(
  rowNumber: number,
  values: {
    purchaseDate: string | null;
    dueDate: string | null;
    description: string;
    amountCents: number | null;
    paymentMethod: string;
    transfer: string | null;
    category?: string;
    classification?: string | null;
  },
): TransferParty | null {
  if (
    !values.dueDate ||
    !values.purchaseDate ||
    values.amountCents === null ||
    values.amountCents === 0
  ) {
    return null;
  }
  return {
    key: `file:${rowNumber}`,
    source: 'file',
    rowNumber,
    transactionId: null,
    dueDate: values.dueDate,
    purchaseDate: values.purchaseDate,
    description: values.description,
    amountCents: values.amountCents,
    paymentMethod: values.paymentMethod,
    transfer: values.transfer,
    category: values.category,
    classification: values.classification ?? null,
  };
}

/** Lançamentos já gravados que ainda não participam de uma transferência. */
export function loadUnlinkedDatabaseParties(db: AppDatabase, limit = 5000): TransferParty[] {
  const rows = db
    .select({
      id: transactions.id,
      purchaseDate: transactions.purchaseDate,
      dueDate: transactions.dueDate,
      description: transactions.description,
      amountCents: transactions.amountCents,
      paymentMethodName: paymentMethods.name,
      categoryName: categories.name,
      classification: categories.classification,
      transfer: transactions.transfer,
    })
    .from(transactions)
    .innerJoin(paymentMethods, eq(transactions.paymentMethodId, paymentMethods.id))
    .innerJoin(categories, eq(transactions.categoryId, categories.id))
    .where(
      sql`not exists (
        select 1 from transfers
        where transfers.outgoing_transaction_id = ${transactions.id}
           or transfers.incoming_transaction_id = ${transactions.id}
      )`,
    )
    .orderBy(desc(transactions.id))
    .limit(limit)
    .all();

  return rows.map((row) => ({
    key: `db:${row.id}`,
    source: 'database' as const,
    rowNumber: null,
    transactionId: row.id,
    dueDate: row.dueDate,
    purchaseDate: row.purchaseDate,
    description: row.description,
    amountCents: row.amountCents,
    paymentMethod: row.paymentMethodName,
    transfer: row.transfer,
    category: row.categoryName,
    classification: row.classification ?? null,
  }));
}

/** Candidatos para vincular manualmente um lançamento já existente. */
export function detectCandidatesForTransaction(
  db: AppDatabase,
  transactionId: number,
  options: DetectTransferOptions = {},
): TransferCandidate[] {
  const parties = loadUnlinkedDatabaseParties(db);
  if (!parties.some((party) => party.transactionId === transactionId)) return [];
  return detectTransferCandidates(parties, { ...options, allowDatabasePairs: true }).filter(
    (candidate) =>
      candidate.outgoing.transactionId === transactionId ||
      candidate.incoming.transactionId === transactionId,
  );
}
