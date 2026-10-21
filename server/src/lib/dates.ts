import type { ParseResult } from './money';

const MIN_YEAR = 1900;
const MAX_YEAR = 2200;

function iso(year: number, month: number, day: number): ParseResult<string> {
  if (year < MIN_YEAR || year > MAX_YEAR) {
    return { ok: false, error: 'Ano fora do intervalo aceito.' };
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return { ok: false, error: 'Data inválida.' };
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return { ok: false, error: 'Data inválida.' };
  }
  return {
    ok: true,
    value: `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day
      .toString()
      .padStart(2, '0')}`,
  };
}

function fromExcelSerial(serial: number): ParseResult<string> {
  if (!Number.isFinite(serial) || serial < 20000 || serial > 80000) {
    return { ok: false, error: 'Data inválida.' };
  }
  const wholeDays = Math.floor(serial);
  // Âncora do Excel (inclui o bug do ano bissexto de 1900).
  const date = new Date(Date.UTC(1899, 11, 30) + wholeDays * 86_400_000);
  return iso(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

/**
 * Interpreta datas brasileiras (DD/MM/AAAA), ISO (AAAA-MM-DD), datas do Excel
 * (número de série) e objetos Date. Retorna sempre AAAA-MM-DD.
 */
export function parseDateValue(input: unknown): ParseResult<string> {
  if (input === null || input === undefined) {
    return { ok: false, error: 'Data não informada.' };
  }

  if (input instanceof Date) {
    if (Number.isNaN(input.getTime())) return { ok: false, error: 'Data inválida.' };
    return iso(input.getFullYear(), input.getMonth() + 1, input.getDate());
  }

  if (typeof input === 'number') {
    return fromExcelSerial(input);
  }

  let raw = String(input).replace(/\u00a0/g, ' ').trim();
  if (!raw) return { ok: false, error: 'Data não informada.' };

  // Remove horários eventualmente presentes em exportações.
  raw = raw.replace(/[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z)?$/i, '').trim();

  if (/^\d{5}(\.\d+)?$/.test(raw)) {
    const serial = Number(raw);
    if (serial >= 20000 && serial <= 80000) {
      return fromExcelSerial(serial);
    }
  }

  const isoMatch = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (isoMatch) {
    return iso(Number(isoMatch[1]), Number(isoMatch[2]), Number(isoMatch[3]));
  }

  const brMatch = raw.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2}|\d{4})$/);
  if (brMatch) {
    const day = Number(brMatch[1]);
    const month = Number(brMatch[2]);
    let year = Number(brMatch[3]);
    if (brMatch[3].length === 2) {
      year += year <= 79 ? 2000 : 1900;
    }
    return iso(year, month, day);
  }

  return { ok: false, error: 'Data inválida. Use DD/MM/AAAA.' };
}

/** Valida e normaliza uma data já em formato ISO (entrada da API). */
export function parseIsoDate(input: unknown): ParseResult<string> {
  return parseDateValue(input);
}

export type DueDateSource =
  | 'file'
  | 'estimated_from_installment'
  | 'derived_from_cash_purchase'
  | 'derived_from_purchase_fallback';

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  if (month === 4 || month === 6 || month === 9 || month === 11) return 30;
  return 31;
}

export function addMonthsIso(date: string, months: number): string | null {
  const match = String(date ?? '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const base = new Date(Date.UTC(year, month - 1, day));
  if (
    base.getUTCFullYear() !== year ||
    base.getUTCMonth() !== month - 1 ||
    base.getUTCDate() !== day
  ) {
    return null;
  }
  if (!Number.isFinite(months) || !Number.isInteger(months)) return null;
  const totalMonths = year * 12 + (month - 1) + months;
  const targetYear = Math.floor(totalMonths / 12);
  const targetMonthIndex = (((totalMonths % 12) + 12) % 12);
  const targetMonth = targetMonthIndex + 1;
  if (targetYear < MIN_YEAR || targetYear > MAX_YEAR) return null;
  const targetDay = Math.min(day, daysInMonth(targetYear, targetMonth));
  return `${targetYear.toString().padStart(4, '0')}-${targetMonth
    .toString()
    .padStart(2, '0')}-${targetDay.toString().padStart(2, '0')}`;
}

export function todayIso(): string {
  const now = new Date();
  return iso(now.getFullYear(), now.getMonth() + 1, now.getDate()).ok
    ? `${now.getFullYear().toString().padStart(4, '0')}-${(now.getMonth() + 1)
        .toString()
        .padStart(2, '0')}-${now.getDate().toString().padStart(2, '0')}`
    : '1970-01-01';
}
