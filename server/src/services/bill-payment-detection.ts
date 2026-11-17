/**
 * Detecção de pagamentos de contas a pagar em lançamentos importados.
 *
 * Compara cada saída do arquivo com as ocorrências em aberto. Uma conta com
 * pagamento parcial é comparada pelo valor que falta. A detecção só sugere: o vínculo acontece apenas com decisão
 * explícita na revisão da importação (`billDecisions`).
 */
import { and, eq, gte, lte, sql } from 'drizzle-orm';
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
  /** Soma dos pagamentos parciais já registrados (0 sem pagamento). */
  paidCents: number;
}

type CandidateBill = Pick<OpenBillForMatch, 'id' | 'description' | 'amountCents' | 'dueDate' | 'categoryName' | 'paidCents'>;

export interface BillPaymentCandidate {
  /** `${party.key}:bill:${bill.id}`, ou `${party.key}:bills:${ids}` no boleto agrupado — chave das decisões. */
  key: string;
  confidence: 'high' | 'possible';
  ambiguous: boolean;
  reasons: string[];
  dayDistance: number;
  /** |valor do lançamento| − valor que falta pagar (o previsto, sem parcial). */
  amountDiffCents: number;
  party: TransferParty;
  /** A conta (no boleto agrupado, a primeira do grupo). */
  bill: CandidateBill;
  /** Boleto agrupado: todas as contas que a linha paga juntas (2 a 4); vazio no par comum. */
  groupBills: CandidateBill[];
}

/** Contas pagas pela sugestão: o grupo inteiro ou só a conta. */
export function candidateBillIds(candidate: Pick<BillPaymentCandidate, 'bill' | 'groupBills'>): number[] {
  return candidate.groupBills.length > 0 ? candidate.groupBills.map((bill) => bill.id) : [candidate.bill.id];
}

/** Tamanho máximo de um boleto agrupado sugerido e quantas contas próximas entram na busca. */
const MAX_GROUP_SIZE = 4;
const MAX_GROUP_POOL = 20;
const MAX_GROUPS_PER_ROW = 5;

function toCandidateBill(bill: OpenBillForMatch): CandidateBill {
  return {
    id: bill.id,
    description: bill.description,
    amountCents: bill.amountCents,
    dueDate: bill.dueDate,
    categoryName: bill.categoryName,
    paidCents: bill.paidCents,
  };
}

/** Combinações de 2 a MAX_GROUP_SIZE contas cujo restante soma exatamente `target`. */
function groupsSumming(pool: { bill: OpenBillForMatch; remaining: number }[], target: number): OpenBillForMatch[][] {
  const result: OpenBillForMatch[][] = [];
  const chosen: { bill: OpenBillForMatch; remaining: number }[] = [];
  const walk = (start: number, sum: number) => {
    if (result.length >= MAX_GROUPS_PER_ROW + 1) return;
    if (sum === target && chosen.length >= 2) {
      result.push(chosen.map((item) => item.bill));
      return;
    }
    if (chosen.length === MAX_GROUP_SIZE || sum >= target) return;
    for (let index = start; index < pool.length; index += 1) {
      chosen.push(pool[index]);
      walk(index + 1, sum + pool[index].remaining);
      chosen.pop();
    }
  };
  walk(0, 0);
  return result;
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
      // Com parcial, só o valor exato do restante: a faixa vale para a conta inteira.
      const partial = bill.paidCents > 0;
      const target = bill.amountCents - bill.paidCents;
      if (target <= 0) continue;
      const exact = paid === target;
      const inRange =
        !exact &&
        !partial &&
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
        exact && partial
          ? `Valor igual ao que falta (${formatCents(target)}; já pago ${formatCents(bill.paidCents)} de ${formatCents(bill.amountCents)})`
          : exact
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
        amountDiffCents: paid - target,
        party,
        bill: toCandidateBill(bill),
        groupBills: [],
      });
    }
  }

  // Boleto agrupado: só para saídas sem nenhuma conta que case sozinha. Sempre
  // "possível" (nunca vem confirmado): várias somas podem coincidir por acaso.
  const singlesByParty = new Set(candidates.map((candidate) => candidate.party.key));
  for (const party of parties) {
    if (party.amountCents >= 0 || singlesByParty.has(party.key)) continue;
    const paid = -party.amountCents;
    const pool = bills
      .map((bill) => ({
        bill,
        remaining: bill.amountCents - bill.paidCents,
        distance: Math.min(
          Math.abs(toDay(party.dueDate) - toDay(bill.dueDate)),
          Math.abs(toDay(party.purchaseDate) - toDay(bill.dueDate)),
        ),
      }))
      .filter((item) => item.remaining > 0 && item.remaining < paid && item.distance <= toleranceDays)
      .sort((a, b) => a.distance - b.distance || a.bill.id - b.bill.id)
      .slice(0, MAX_GROUP_POOL);
    const groups = groupsSumming(pool, paid);
    for (const group of groups.slice(0, MAX_GROUPS_PER_ROW)) {
      const ordered = [...group].sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.id - b.id);
      const dayDistance = Math.max(
        ...ordered.map((bill) =>
          Math.min(Math.abs(toDay(party.dueDate) - toDay(bill.dueDate)), Math.abs(toDay(party.purchaseDate) - toDay(bill.dueDate))),
        ),
      );
      candidates.push({
        key: `${party.key}:bills:${ordered.map((bill) => bill.id).join('+')}`,
        confidence: 'possible',
        ambiguous: false,
        reasons: [
          `Soma de ${ordered.length} contas igual ao valor (${formatCents(paid)})`,
          dayDistance === 0 ? 'Mesmo dia dos vencimentos' : `Até ${dayDistance} dia(s) dos vencimentos`,
          'Boleto agrupado: um lançamento paga todas',
        ],
        dayDistance,
        amountDiffCents: 0,
        party,
        bill: toCandidateBill(ordered[0]),
        groupBills: ordered.map(toCandidateBill),
      });
    }
  }

  // Disputa — uma linha com duas contas ou uma conta com duas linhas — vira ambígua.
  const perParty = new Map<string, number>();
  const perBill = new Map<number, number>();
  for (const candidate of candidates) {
    perParty.set(candidate.party.key, (perParty.get(candidate.party.key) ?? 0) + 1);
    for (const id of candidateBillIds(candidate)) perBill.set(id, (perBill.get(id) ?? 0) + 1);
  }
  for (const candidate of candidates) {
    if ((perParty.get(candidate.party.key) ?? 0) > 1 || candidateBillIds(candidate).some((id) => (perBill.get(id) ?? 0) > 1)) {
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
 * Ocorrências em aberto (inclusive com pagamento parcial, com a soma já paga)
 * e vencimento dentro da janela das datas do arquivo (± tolerância). Garante antes as ocorrências
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
      paidCents: sql<number>`coalesce((select sum(${billPayments.amountCents}) from ${billPayments} where ${billPayments.billId} = ${scheduledBills.id}), 0)`,
    })
    .from(scheduledBills)
    .innerJoin(categories, eq(scheduledBills.categoryId, categories.id))
    .leftJoin(billTemplates, eq(scheduledBills.templateId, billTemplates.id))
    .where(
      and(
        eq(scheduledBills.state, 'open'),
        gte(scheduledBills.dueDate, from),
        lte(scheduledBills.dueDate, to),
      ),
    )
    .all()
    .map((row) => ({
      ...row,
      amountMinCents: row.amountMinCents ?? null,
      amountMaxCents: row.amountMaxCents ?? null,
      paidCents: Number(row.paidCents) || 0,
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
    const members = candidate.groupBills.length > 0 ? candidate.groupBills : [candidate.bill];
    for (const bill of members) {
      if (bills.has(bill.id)) conflicts.push(`A conta "${bill.description}" foi confirmada para mais de uma linha.`);
      bills.add(bill.id);
    }
    parties.add(candidate.party.key);
  }
  return { confirmed, conflicts };
}

