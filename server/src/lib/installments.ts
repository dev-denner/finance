import { normalizeName } from './normalize';

export interface ParsedInstallments {
  number: number | null;
  total: number | null;
}

export interface InstallmentCellMeta {
  /** Tipo da célula no arquivo (n = número, s = texto, d = data...). */
  type?: string | null;
  /** Formato da célula no Excel (ex.: dd/mm/yyyy, 0.00). */
  format?: string | null;
  /** Texto exibido pelo Excel, quando disponível. */
  text?: string | null;
}

export type InstallmentStatus = 'empty' | 'ok' | 'invalid' | 'date_like' | 'conflict';
export type InstallmentSource = 'column' | 'description';

export interface InstallmentSuggestion {
  number: number;
  total: number;
  label: string;
}

export interface InstallmentParseResult {
  value: ParsedInstallments;
  error?: string;
  status: InstallmentStatus;
  source: InstallmentSource | null;
  note?: string;
  original?: string;
  suggestions: InstallmentSuggestion[];
}

const NO_TRANSFER_VALUES = new Set([
  '',
  '-',
  'nao',
  'no',
  'false',
  '0',
  'n',
  'nao se aplica',
  'não se aplica',
]);

/** Campos de transferência vazios ou "não" são tratados como ausência de transferência. */
export function normalizeTransfer(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const display = String(value).replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  if (!display) return null;
  if (NO_TRANSFER_VALUES.has(normalizeName(display))) return null;
  return display;
}

const EMPTY = (): ParsedInstallments => ({ number: null, total: null });

function emptyResult(
  status: InstallmentStatus = 'empty',
  extra: Partial<InstallmentParseResult> = {},
): InstallmentParseResult {
  return { value: EMPTY(), status, source: null, suggestions: [], ...extra };
}

/** Números seriais de data do Excel ficam nesta faixa (1900–2100 aproximadamente). */
export function isExcelDateSerial(value: number): boolean {
  return Number.isFinite(value) && value >= 20000 && value <= 80000;
}

/** Detecta formatos de célula que representam data/hora no Excel. */
export function looksLikeExcelDateFormat(format?: string | null): boolean {
  if (!format) return false;
  const cleaned = format
    .replace(/\[[^\]]*\]/g, '')
    .replace(/"[^"]*"/g, '')
    .replace(/\\./g, '');
  if (!/[dmyhs]/i.test(cleaned)) return false;
  // Formatos puramente numéricos/monetários não são datas.
  if (/^[#0.,%\s-]+$/.test(cleaned)) return false;
  return true;
}

function pairLabel(number: number, total: number): string {
  return `${number}/${total}`;
}

function pad2(value: number): string {
  return value.toString().padStart(2, '0');
}

interface ColumnParse {
  status: InstallmentStatus;
  value: ParsedInstallments;
  error?: string;
  /** Texto original não vazio, preservado como evidência. */
  original?: string;
}

function parseColumn(input: unknown, meta?: InstallmentCellMeta | null): ColumnParse {
  if (input === null || input === undefined) return { status: 'empty', value: EMPTY() };

  if (typeof input === 'number') {
    if (!Number.isFinite(input)) {
      return { status: 'invalid', value: EMPTY(), error: 'Número de parcelas inválido.' };
    }
    if (isExcelDateSerial(input) || looksLikeExcelDateFormat(meta?.format)) {
      return {
        status: 'date_like',
        value: EMPTY(),
        error: 'O valor parece uma data do Excel, não uma parcela.',
        original: String(input),
      };
    }
    if (!Number.isInteger(input) || input < 1 || input > 999) {
      return {
        status: 'invalid',
        value: EMPTY(),
        error: 'Número de parcelas inválido.',
        original: String(input),
      };
    }
    return { status: 'ok', value: { number: input, total: null } };
  }

  const raw = String(input).replace(/\u00a0/g, ' ').trim();
  if (!raw) return { status: 'empty', value: EMPTY() };

  if (meta?.type === 'd') {
    return {
      status: 'date_like',
      value: EMPTY(),
      error: 'O valor é uma data, não uma parcela.',
      original: raw,
    };
  }

  // Célula numérica com formato de data, mesmo que o valor tenha sido lido como texto.
  if (looksLikeExcelDateFormat(meta?.format) && /^\d+(?:[.,]\d+)?$/.test(raw)) {
    return {
      status: 'date_like',
      value: EMPTY(),
      error: 'O valor parece uma data do Excel, não uma parcela.',
      original: raw,
    };
  }

  // Data completa digitada como texto (ex.: 01/03/2024) não é parcela.
  if (/^\d{1,2}\s*\/\s*\d{1,2}\s*\/\s*\d{2,4}$/.test(raw)) {
    return {
      status: 'date_like',
      value: EMPTY(),
      error: 'O valor é uma data, não uma parcela.',
      original: raw,
    };
  }

  // Serial do Excel salvo como texto (ex.: "44717").
  const serialText = raw.match(/^(\d{5})(?:[.,]\d+)?$/);
  if (serialText && isExcelDateSerial(Number(serialText[1]))) {
    return {
      status: 'date_like',
      value: EMPTY(),
      error: 'O valor parece uma data do Excel, não uma parcela.',
      original: raw,
    };
  }

  let cleaned = raw;
  const parenthesized = cleaned.match(/^\((.*)\)$/);
  if (parenthesized) cleaned = parenthesized[1].trim();
  cleaned = cleaned
    .replace(/^parc(?:ela)?[s]?\.?\s*/i, '')
    .replace(/[ºª]/g, '')
    .trim();

  const pair = cleaned.match(/^(\d{1,3})\s*(?:\/|de|[-–])\s*(\d{1,3})\s*x?$/i);
  if (pair) {
    const number = Number(pair[1]);
    const total = Number(pair[2]);
    if (number < 1 || total < 1) {
      return {
        status: 'invalid',
        value: EMPTY(),
        error: 'Número de parcelas inválido.',
        original: raw,
      };
    }
    if (number > total) {
      return {
        status: 'invalid',
        value: EMPTY(),
        error: 'Parcela atual não pode ser maior que o total.',
        original: raw,
      };
    }
    return { status: 'ok', value: { number, total }, original: raw };
  }

  const totalOnly = cleaned.match(/^(\d{1,3})\s*x$/i);
  if (totalOnly) {
    const total = Number(totalOnly[1]);
    if (total < 1) {
      return {
        status: 'invalid',
        value: EMPTY(),
        error: 'Número de parcelas inválido.',
        original: raw,
      };
    }
    return { status: 'ok', value: { number: null, total }, original: raw };
  }

  const numberOnly = cleaned.match(/^(\d{1,3})$/);
  if (numberOnly) {
    const number = Number(numberOnly[1]);
    if (number < 1) {
      return {
        status: 'invalid',
        value: EMPTY(),
        error: 'Número de parcelas inválido.',
        original: raw,
      };
    }
    return { status: 'ok', value: { number, total: null }, original: raw };
  }

  return {
    status: 'invalid',
    value: EMPTY(),
    error: 'Parcelas inválidas. Use, por exemplo, 1/12 ou 12x.',
    original: raw,
  };
}

export interface DescriptionInstallmentsResult {
  match: { number: number; total: number } | null;
  ambiguous: boolean;
  raw?: string;
}

function collectPairs(
  text: string,
  regex: RegExp,
): { number: number; total: number; raw: string }[] {
  const found: { number: number; total: number; raw: string }[] = [];
  regex.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const number = Number(match[1]);
    const total = Number(match[2]);
    if (number >= 1 && total >= 1 && number <= total && total <= 999) {
      found.push({ number, total, raw: match[0].trim() });
    }
  }
  return found;
}

/**
 * Procura uma indicação de parcelas na descrição.
 * Formatos: "Parcela 09/12", "Parc. 3/10", "(Parcela 09/12)" e "09/12".
 */
export function findDescriptionInstallments(description: string): DescriptionInstallmentsResult {
  const text = String(description ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return { match: null, ambiguous: false };

  const keyword = collectPairs(
    text,
    /\bparc(?:ela)?\.?\s*(\d{1,3})\s*(?:\/|de)\s*(\d{1,3})\b/gi,
  );
  const parenthesized = collectPairs(text, /\(\s*(\d{1,3})\s*\/\s*(\d{1,3})\s*\)/g);

  let candidates = keyword;
  if (candidates.length === 0) candidates = parenthesized;
  if (candidates.length === 0) {
    // Evita interpretar uma data completa (10/01/2024) como parcelas.
    if (/\d{1,2}\s*\/\s*\d{1,2}\s*\/\s*\d{2,4}/.test(text)) {
      return { match: null, ambiguous: false };
    }
    candidates = collectPairs(text, /\b(\d{1,3})\s*\/\s*(\d{1,3})\b/g).filter(
      (pair) => pair.total >= 2 && pair.total <= 48,
    );
  }

  const distinct = new Map<string, { number: number; total: number; raw: string }>();
  for (const candidate of candidates) {
    distinct.set(`${candidate.number}/${candidate.total}`, candidate);
  }
  if (distinct.size === 0) return { match: null, ambiguous: false };
  if (distinct.size > 1) {
    return {
      match: null,
      ambiguous: true,
      raw: [...distinct.values()].map((item) => item.raw).join(', '),
    };
  }
  const only = [...distinct.values()][0];
  return { match: { number: only.number, total: only.total }, ambiguous: false };
}

/** Extrai parcelas inequívocas da descrição (retorna null quando ambíguo). */
export function extractInstallmentsFromDescription(
  description: string,
): { number: number; total: number } | null {
  return findDescriptionInstallments(description).match;
}

/**
 * Interpreta a coluna Parcelas com apoio do tipo/formato da célula e da descrição.
 *
 * Ordem: valor/tipo da célula → formato → descrição. Seriais de data do Excel
 * nunca são convertidos em número de parcela por suposição.
 */
export function parseInstallments(
  input: unknown,
  options: { meta?: InstallmentCellMeta | null; description?: string } = {},
): InstallmentParseResult {
  const column = parseColumn(input, options.meta);
  const description = findDescriptionInstallments(options.description ?? '');
  const original = column.original ?? (input === null || input === undefined ? undefined : String(input).trim() || undefined);

  if (column.status === 'ok') {
    const columnValue = column.value;
    if (description.match) {
      const desc = description.match;
      const compatibleNumber = columnValue.number === null || columnValue.number === desc.number;
      const compatibleTotal = columnValue.total === null || columnValue.total === desc.total;
      if (compatibleNumber && compatibleTotal) {
        return {
          value: {
            number: columnValue.number ?? desc.number,
            total: columnValue.total ?? desc.total,
          },
          status: 'ok',
          source: 'column',
          suggestions: [],
        };
      }
      const columnLabel =
        columnValue.number !== null && columnValue.total !== null
          ? pairLabel(columnValue.number, columnValue.total)
          : columnValue.number !== null
            ? String(columnValue.number)
            : `${columnValue.total ?? 0}x`;
      const combined = {
        number: columnValue.number ?? desc.number,
        total: columnValue.total ?? desc.total,
      };
      return {
        value: columnValue,
        status: 'conflict',
        source: null,
        error: `A coluna informa ${columnLabel}, mas a descrição indica ${pairLabel(desc.number, desc.total)}. Escolha qual valor usar.`,
        original,
        suggestions: [
          {
            ...combined,
            label:
              columnValue.number === null
                ? `Combinar total da coluna com a descrição (${pairLabel(combined.number, combined.total)})`
                : `Usar a coluna (${columnLabel})`,
          },
          {
            number: desc.number,
            total: desc.total,
            label: `Usar a descrição (${pairLabel(desc.number, desc.total)})`,
          },
        ],
      };
    }
    return {
      value: column.value,
      status: 'ok',
      source: 'column',
      suggestions: [],
    };
  }

  if (description.match) {
    const desc = description.match;
    return {
      value: { number: desc.number, total: desc.total },
      status: 'ok',
      source: 'description',
      note: `Parcela ${pad2(desc.number)}/${pad2(desc.total)} recuperada da descrição.`,
      original,
      suggestions: [],
    };
  }

  if (column.status === 'empty') {
    if (description.ambiguous) {
      return emptyResult('empty', {
        note: `A descrição contém mais de uma indicação de parcelas (${description.raw ?? ''}). Revise se necessário.`,
      });
    }
    return emptyResult();
  }

  if (description.ambiguous) {
    return {
      value: EMPTY(),
      status: column.status,
      source: null,
      error: `${column.error} A descrição contém mais de uma indicação de parcelas (${description.raw ?? ''}); não foi possível recuperar automaticamente.`,
      original,
      suggestions: [],
    };
  }

  if (column.status === 'date_like') {
    return {
      value: EMPTY(),
      status: 'date_like',
      source: null,
      error: 'O valor parece uma data do Excel e não foi possível recuperar a parcela pela descrição.',
      original,
      suggestions: [],
    };
  }

  return {
    value: EMPTY(),
    status: column.status,
    source: null,
    error: column.error ?? 'Parcelas inválidas.',
    original,
    suggestions: [],
  };
}

export function formatInstallments(number: number | null, total: number | null): string | null {
  if (number !== null && total !== null) return `${number}/${total}`;
  if (number !== null) return String(number);
  if (total !== null) return `${total}x`;
  return null;
}

/** Último dia do mês, respeitando anos bissextos. */
function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  if (month === 4 || month === 6 || month === 9 || month === 11) return 30;
  return 31;
}

/**
 * Recua `months` meses de uma data (ano, mês, dia) usando aritmética de
 * calendário: quando o dia não existe no mês de destino, é limitado ao último
 * dia daquele mês. Trabalha apenas com inteiros; nenhum fuso horário envolvido.
 */
function shiftMonthsBack(
  year: number,
  month: number,
  day: number,
  months: number,
): { year: number; month: number; day: number } {
  const totalMonths = year * 12 + (month - 1) - months;
  const targetYear = Math.floor(totalMonths / 12);
  const targetMonth = (((totalMonths % 12) + 12) % 12) + 1;
  const targetDay = Math.min(day, daysInMonth(targetYear, targetMonth));
  return { year: targetYear, month: targetMonth, day: targetDay };
}

/**
 * Reconstrói a data estimada da primeira parcela a partir do vencimento e do
 * número da parcela atual: `vencimento - (numero - 1) meses`.
 *
 * A estimativa exige número de parcela atual ≥ 1 e, quando o total for
 * informado, `numero <= total`. Sem parcela válida, não há estimativa.
 * Retorna AAAA-MM-DD ou null; é uma data estimada, nunca um registro histórico.
 */
export function estimateFirstInstallmentDate(
  dueDate: string | null,
  installmentNumber: number | null,
  installmentTotal: number | null,
): string | null {
  if (!dueDate || installmentNumber === null || !Number.isInteger(installmentNumber)) return null;
  if (installmentNumber < 1) return null;
  if (installmentTotal !== null && installmentNumber > installmentTotal) return null;

  const match = dueDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const shifted = shiftMonthsBack(year, month, day, installmentNumber - 1);
  return `${shifted.year.toString().padStart(4, '0')}-${shifted.month
    .toString()
    .padStart(2, '0')}-${shifted.day.toString().padStart(2, '0')}`;
}
