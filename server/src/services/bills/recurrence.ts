/**
 * Regras de recorrência de contas a pagar. Módulo puro: sem banco, sem
 * fuso horário (toda aritmética usa calendário civil em UTC sobre ISO
 * AAAA-MM-DD).
 */

export type BillFrequency = 'monthly' | 'weekly' | 'yearly';

export const BILL_FREQUENCIES: readonly BillFrequency[] = ['monthly', 'weekly', 'yearly'];

export interface BillRecurrence {
  frequency: BillFrequency;
  /** 1 = toda unidade; 2 = a cada duas (quinzenal se weekly, bimestral se monthly). */
  interval: number;
  /** 1..31; clamp ao último dia do mês (monthly/yearly). Nulo = dia da data inicial. */
  dayOfMonth: number | null;
  /** 0 (domingo) .. 6 (sábado); só weekly. Nulo = dia da semana da data inicial. */
  weekday: number | null;
  /** 1..12; só yearly. Nulo = mês da data inicial. */
  monthOfYear: number | null;
}

export interface OccurrenceLimits {
  /**
   * Limite inferior (inclusive): ocorrências anteriores não são devolvidas,
   * mas a sequência continua contada desde a data inicial.
   */
  from?: string | null;
  /** Horizonte máximo (inclusive), normalmente hoje + 12 meses. */
  to: string;
  /** Término por data (inclusive). */
  endDate?: string | null;
  /** Término por contagem ("repetir N vezes"). */
  occurrenceCount?: number | null;
}

export interface OccurrenceDate {
  /** Posição na série, a partir de 1. */
  sequence: number;
  dueDate: string;
}

/** Teto de ocorrências devolvidas por chamada (proteção contra janelas degeneradas). */
const MAX_OCCURRENCES = 1000;

interface DateParts {
  year: number;
  month: number;
  day: number;
}

function parseParts(iso: string): DateParts | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return { year, month, day };
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function toIso(year: number, month: number, day: number): string {
  return `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day
    .toString()
    .padStart(2, '0')}`;
}

/** Monta a data com o dia pedido, recuando ao último dia do mês quando necessário. */
function clampedDate(year: number, month: number, day: number): string {
  return toIso(year, month, Math.min(day, daysInMonth(year, month)));
}

function addDays(iso: string, days: number): string {
  const parts = parseParts(iso);
  if (!parts) throw new Error(`Data inválida: ${iso}`);
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day) + days * 86_400_000);
  return toIso(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

function weekdayOf(parts: DateParts): number {
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
}

export function isValidIsoDate(value: unknown): value is string {
  return typeof value === 'string' && parseParts(value) !== null;
}

/** Retorna a mensagem do primeiro problema encontrado, ou null quando a regra é válida. */
export function validateRecurrence(input: BillRecurrence): string | null {
  if (!BILL_FREQUENCIES.includes(input.frequency)) {
    return 'Frequência inválida. Use monthly, weekly ou yearly.';
  }
  if (!Number.isInteger(input.interval) || input.interval < 1 || input.interval > 120) {
    return 'O intervalo deve ser um inteiro entre 1 e 120.';
  }
  if (
    input.dayOfMonth !== null &&
    (!Number.isInteger(input.dayOfMonth) || input.dayOfMonth < 1 || input.dayOfMonth > 31)
  ) {
    return 'O dia do mês deve estar entre 1 e 31.';
  }
  if (
    input.weekday !== null &&
    (!Number.isInteger(input.weekday) || input.weekday < 0 || input.weekday > 6)
  ) {
    return 'O dia da semana deve estar entre 0 (domingo) e 6 (sábado).';
  }
  if (
    input.monthOfYear !== null &&
    (!Number.isInteger(input.monthOfYear) || input.monthOfYear < 1 || input.monthOfYear > 12)
  ) {
    return 'O mês deve estar entre 1 e 12.';
  }
  return null;
}

interface Anchor {
  /** Primeira ocorrência (>= data inicial). */
  first: string;
  /** Dia alvo sem clamp, preservado para meses mais longos (31/01 → 28/02 → 31/03). */
  day: number;
}

function anchorFor(recurrence: BillRecurrence, startDate: string): Anchor {
  const start = parseParts(startDate);
  if (!start) throw new Error(`Data inicial inválida: ${startDate}`);

  switch (recurrence.frequency) {
    case 'monthly': {
      const day = recurrence.dayOfMonth ?? start.day;
      const candidate = clampedDate(start.year, start.month, day);
      if (candidate >= startDate) return { first: candidate, day };
      const total = start.year * 12 + (start.month - 1) + 1; // índice absoluto do mês seguinte
      return { first: clampedDate(Math.floor(total / 12), (total % 12) + 1, day), day };
    }
    case 'weekly': {
      const weekday = recurrence.weekday ?? weekdayOf(start);
      const delta = (weekday - weekdayOf(start) + 7) % 7;
      return { first: addDays(startDate, delta), day: start.day };
    }
    case 'yearly': {
      const month = recurrence.monthOfYear ?? start.month;
      const day = recurrence.dayOfMonth ?? start.day;
      const candidate = clampedDate(start.year, month, day);
      if (candidate >= startDate) return { first: candidate, day };
      return { first: clampedDate(start.year + 1, month, day), day };
    }
    default: {
      const never: never = recurrence.frequency;
      throw new Error(`Frequência desconhecida: ${String(never)}`);
    }
  }
}

function occurrenceAt(recurrence: BillRecurrence, anchor: Anchor, index: number): string {
  const first = parseParts(anchor.first);
  if (!first) throw new Error(`Âncora inválida: ${anchor.first}`);
  switch (recurrence.frequency) {
    case 'monthly': {
      const total = first.year * 12 + (first.month - 1) + index * recurrence.interval;
      return clampedDate(Math.floor(total / 12), (total % 12) + 1, anchor.day);
    }
    case 'weekly':
      return addDays(anchor.first, 7 * recurrence.interval * index);
    case 'yearly':
      return clampedDate(first.year + recurrence.interval * index, first.month, anchor.day);
    default: {
      const never: never = recurrence.frequency;
      throw new Error(`Frequência desconhecida: ${String(never)}`);
    }
  }
}

/**
 * Índice (base 0) a partir do qual vale procurar ocorrências >= `from`.
 * Calculado direto da distância em semanas, meses ou anos, um passo antes
 * para cobrir o recuo de fim de mês; quem chama descarta o que ficar antes.
 */
function firstIndexNear(recurrence: BillRecurrence, anchor: Anchor, from: string): number {
  const first = parseParts(anchor.first);
  const target = parseParts(from);
  if (!first || !target || from <= anchor.first) return 0;
  let steps: number;
  switch (recurrence.frequency) {
    case 'monthly':
      steps = Math.floor(((target.year - first.year) * 12 + (target.month - first.month)) / recurrence.interval);
      break;
    case 'weekly': {
      const days = Math.round(
        (Date.UTC(target.year, target.month - 1, target.day) - Date.UTC(first.year, first.month - 1, first.day)) /
          86_400_000,
      );
      steps = Math.floor(days / (7 * recurrence.interval));
      break;
    }
    case 'yearly':
      steps = Math.floor((target.year - first.year) / recurrence.interval);
      break;
    default:
      steps = 0;
  }
  return Math.max(0, steps - 1);
}

/**
 * Datas das ocorrências a partir da data inicial, respeitando o primeiro
 * limite atingido: horizonte (`to`), término por data ou por contagem. Com
 * `from`, pula direto para a janela pedida sem perder a numeração.
 */
export function nextOccurrenceDates(
  recurrence: BillRecurrence,
  startDate: string,
  limits: OccurrenceLimits,
): OccurrenceDate[] {
  const problem = validateRecurrence(recurrence);
  if (problem) throw new Error(problem);
  if (!isValidIsoDate(startDate)) throw new Error(`Data inicial inválida: ${startDate}`);
  if (!isValidIsoDate(limits.to)) throw new Error(`Horizonte inválido: ${limits.to}`);

  if (limits.from && !isValidIsoDate(limits.from)) throw new Error(`Limite inicial inválido: ${limits.from}`);

  const anchor = anchorFor(recurrence, startDate);
  const result: OccurrenceDate[] = [];
  const startIndex = limits.from ? firstIndexNear(recurrence, anchor, limits.from) : 0;
  for (let index = startIndex; result.length < MAX_OCCURRENCES; index += 1) {
    const sequence = index + 1;
    if (limits.occurrenceCount != null && sequence > limits.occurrenceCount) break;
    const dueDate = occurrenceAt(recurrence, anchor, index);
    if (dueDate > limits.to) break;
    if (limits.from && dueDate < limits.from) continue;
    if (limits.endDate && dueDate > limits.endDate) break;
    result.push({ sequence, dueDate });
  }
  return result;
}

/** Texto curto para a interface: "Mensal, dia 10" · "A cada 2 semanas, às segundas". */
export function describeRecurrence(recurrence: BillRecurrence): string {
  const every = recurrence.interval;
  switch (recurrence.frequency) {
    case 'monthly': {
      const base = every === 1 ? 'Mensal' : `A cada ${every} meses`;
      return recurrence.dayOfMonth ? `${base}, dia ${recurrence.dayOfMonth}` : base;
    }
    case 'weekly': {
      const names = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
      const base = every === 1 ? 'Semanal' : `A cada ${every} semanas`;
      return recurrence.weekday !== null ? `${base}, ${names[recurrence.weekday]}` : base;
    }
    case 'yearly': {
      const base = every === 1 ? 'Anual' : `A cada ${every} anos`;
      if (recurrence.monthOfYear && recurrence.dayOfMonth) {
        return `${base}, ${String(recurrence.dayOfMonth).padStart(2, '0')}/${String(
          recurrence.monthOfYear,
        ).padStart(2, '0')}`;
      }
      return base;
    }
    default:
      return '';
  }
}
