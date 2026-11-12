/**
 * Detecção de pagamentos de contas a pagar em lançamentos importados.
 *
 * Compara cada saída do arquivo com as ocorrências em aberto e sem pagamento
 * vinculado. A detecção só sugere: o vínculo acontece apenas com decisão
 * explícita na revisão da importação (`billDecisions`).
 */
import { and, eq, gte, lte, notInArray, sql } from 'drizzle-orm';
import type { AppDatabase } from '../db/client';
import { billPayments, billTemplates, categories, scheduledBills } from '../db/schema';
import { normalizeName } from '../lib/normalize';
import type { TransferParty } from './transfer-detection';
import { ensureAllOccurrences } from './bills/templates';

export const DEFAULT_BILL_MATCH_TOLERANCE_DAYS = 5;
const MAX_CANDIDATES = 500;
/** A partir desta semelhança de descrição a sugestão pode ser de alta confiança. */
const DESCRIPTION_MATCH_THRESHOLD = 0.5;

export type BillDecision = 'confirm' | 'reject' | 'pending';

export interface OpenBillForMatch {
  id: number;
  description: string;
  amountCents: number;
  dueDate: string;
  categoryName: string;
  /** Faixa do template para contas de valor variável (água, luz). */
  amountMinCents: number | null;
  amountMaxCents: number | null;
}

export interface BillPaymentCandidate {
  /** `${party.key}:bill:${bill.id}` — chave das decisões. */
  key: string;
  confidence: 'high' | 'possible';
  ambiguous: boolean;
  reasons: string[];
  dayDistance: number;
  /** |valor do lançamento| − valor previsto da conta. */
  amountDiffCents: number;
  party: TransferParty;
  bill: Pick<OpenBillForMatch, 'id' | 'description' | 'amountCents' | 'dueDate' | 'categoryName'>;
}

/** Palavras comuns em extratos que não identificam o credor. */
const NOISE_TOKENS = new Set([
  'pag', 'pagto', 'pagamento', 'pgto', 'pg', 'boleto', 'bol', 'deb', 'debito', 'aut', 'automatico',
  'conta', 'fatura', 'compra', 'cartao', 'pix', 'ted', 'doc', 'tit', 'titulo', 'de', 'da', 'do', 'e',
  'sa', 'ltda', 'me', 'eireli', 'cia',
]);

function tokens(value: string): Set<string> {
  return new Set(
    normalizeName(value)
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 2 && !NOISE_TOKENS.has(token)),
  );
}

/**
 * Semelhança entre a descrição da conta e a do extrato: o maior entre o
 * Jaccard dos termos e a fração dos termos da conta presentes no extrato
 * ("Vivo Fibra" em "PAG*VIVO FIBRA SA").
 */
export function descriptionSimilarity(billDescription: string, rowDescription: string): number {
  const bill = tokens(billDescription);
  const row = tokens(rowDescription);
  if (bill.size === 0 || row.size === 0) return 0;
  let shared = 0;
  for (const token of bill) if (row.has(token)) shared += 1;
  const union = new Set([...bill, ...row]).size;
  return Math.max(shared / union, shared / bill.size);
}

function toDay(iso: string): number {
  const [year, month, day] = iso.slice(0, 10).split('-').map(Number);
  return Date.UTC(year, month - 1, day) / 86_400_000;
}

function formatCents(cents: number): string {
  const abs = Math.abs(cents);
  const reais = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `R$ ${reais},${String(abs % 100).padStart(2, '0')}`;
}

export function detectBillPaymentCandidates(
  parties: TransferParty[],
  bills: OpenBillForMatch[],
  options: { toleranceDays?: number } = {},
): BillPaymentCandidate[] {
  const toleranceDays = options.toleranceDays ?? DEFAULT_BILL_MATCH_TOLERANCE_DAYS;
  const candidates: BillPaymentCandidate[] = [];

  for (const party of parties) {
    if (party.amountCents >= 0) continue; // só saídas pagam contas
    const paid = -party.amountCents;
    for (const bill of bills) {
      const exact = paid === bill.amountCents;
      const inRange =
        !exact &&
        bill.amountMinCents !== null &&
        bill.amountMaxCents !== null &&
        paid >= bill.amountMinCents &&
        paid <= bill.amountMaxCents;
      if (!exact && !inRange) continue;

      const dayDistance = Math.min(
        Math.abs(toDay(party.dueDate) - toDay(bill.dueDate)),
        Math.abs(toDay(party.purchaseDate) - toDay(bill.dueDate)),
      );
      if (dayDistance > toleranceDays) continue;

      const similarity = descriptionSimilarity(bill.description, party.description);
      const similar = similarity >= DESCRIPTION_MATCH_THRESHOLD;
      const reasons = [
        exact
          ? `Valor igual ao previsto (${formatCents(bill.amountCents)})`
          : `Valor dentro da faixa prevista (${formatCents(bill.amountMinCents as number)} a ${formatCents(bill.amountMaxCents as number)})`,
        dayDistance === 0 ? 'Mesmo dia do vencimento' : `A ${dayDistance} dia(s) do vencimento`,
        similar ? 'Descrição parecida' : 'Descrição diferente',
      ];
      candidates.push({
        key: `${party.key}:bill:${bill.id}`,
        confidence: exact && similar ? 'high' : 'possible',
        ambiguous: false,
        reasons,
        dayDistance,
        amountDiffCents: paid - bill.amountCents,
        party,
        bill: {
          id: bill.id,
          description: bill.description,
          amountCents: bill.amountCents,
          dueDate: bill.dueDate,
          categoryName: bill.categoryName,
        },
      });
    }
  }

  // Disputa — uma linha com duas contas ou uma conta com duas linhas — vira ambígua.
  const perParty = new Map<string, number>();
  const perBill = new Map<number, number>();
  for (const candidate of candidates) {
    perParty.set(candidate.party.key, (perParty.get(candidate.party.key) ?? 0) + 1);
    perBill.set(candidate.bill.id, (perBill.get(candidate.bill.id) ?? 0) + 1);
  }
  for (const candidate of candidates) {
    if ((perParty.get(candidate.party.key) ?? 0) > 1 || (perBill.get(candidate.bill.id) ?? 0) > 1) {
      candidate.ambiguous = true;
      candidate.reasons.push('Há mais de um par possível; escolha manualmente');
    }
  }

  return candidates
    .sort(
      (a, b) =>
        Number(b.confidence === 'high') - Number(a.confidence === 'high') ||
        Number(a.ambiguous) - Number(b.ambiguous) ||
        a.dayDistance - b.dayDistance ||
        (a.party.rowNumber ?? 0) - (b.party.rowNumber ?? 0) ||
        a.bill.id - b.bill.id,
    )
    .slice(0, MAX_CANDIDATES);
}

function shiftDays(iso: string, days: number): string {
  return new Date((toDay(iso) + days) * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Ocorrências em aberto, sem pagamento vinculado, com vencimento dentro da
 * janela das datas do arquivo (± tolerância). Garante antes as ocorrências
 * das recorrências.
 */
export function loadOpenBillsForMatch(
  db: AppDatabase,
  parties: TransferParty[],
  toleranceDays = DEFAULT_BILL_MATCH_TOLERANCE_DAYS,
): OpenBillForMatch[] {
  const dates = parties.flatMap((party) => [party.dueDate, party.purchaseDate]).sort();
  if (dates.length === 0) return [];
  ensureAllOccurrences(db);
  const from = shiftDays(dates[0], -toleranceDays);
  const to = shiftDays(dates[dates.length - 1], toleranceDays);
  return db
    .select({
      id: scheduledBills.id,
      description: scheduledBills.description,
      amountCents: scheduledBills.amountCents,
      dueDate: scheduledBills.dueDate,
      categoryName: categories.name,
      amountMinCents: billTemplates.amountMinCents,
      amountMaxCents: billTemplates.amountMaxCents,
    })
    .from(scheduledBills)
    .innerJoin(categories, eq(scheduledBills.categoryId, categories.id))
    .leftJoin(billTemplates, eq(scheduledBills.templateId, billTemplates.id))
    .where(
      and(
        eq(scheduledBills.state, 'open'),
        gte(scheduledBills.dueDate, from),
        lte(scheduledBills.dueDate, to),
        notInArray(scheduledBills.id, sql`(select ${billPayments.billId} from ${billPayments})`),
      ),
    )
    .all()
    .map((row) => ({
      ...row,
      amountMinCents: row.amountMinCents ?? null,
      amountMaxCents: row.amountMaxCents ?? null,
    }));
}

/** Uma conta por linha e uma linha por conta entre as decisões confirmadas. */
export function confirmedBillCandidates(
  candidates: BillPaymentCandidate[],
  decisions: Record<string, BillDecision>,
): { confirmed: BillPaymentCandidate[]; conflicts: string[] } {
  const confirmed = candidates.filter((candidate) => decisions[candidate.key] === 'confirm');
  const conflicts: string[] = [];
  const parties = new Set<string>();
  const bills = new Set<number>();
  for (const candidate of confirmed) {
    if (parties.has(candidate.party.key)) {
      conflicts.push(`A linha ${candidate.party.rowNumber} foi confirmada para mais de uma conta.`);
    }
    if (bills.has(candidate.bill.id)) {
      conflicts.push(`A conta "${candidate.bill.description}" foi confirmada para mais de uma linha.`);
    }
    parties.add(candidate.party.key);
    bills.add(candidate.bill.id);
  }
  return { confirmed, conflicts };
}

