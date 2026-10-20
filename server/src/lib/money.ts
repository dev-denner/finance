export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

const MAX_CENTS = Number.MAX_SAFE_INTEGER;

function fail(error: string): ParseResult<never> {
  return { ok: false, error };
}

function stripThousands(intPart: string, separator: string): ParseResult<string> {
  const groups = intPart.split(separator);
  if (groups.length === 1) return { ok: true, value: groups[0] };

  if (!/^\d{1,3}$/.test(groups[0])) {
    return fail('Agrupamento de milhar inválido.');
  }
  for (let i = 1; i < groups.length; i += 1) {
    if (!/^\d{3}$/.test(groups[i])) {
      return fail('Agrupamento de milhar inválido.');
    }
  }
  return { ok: true, value: groups.join('') };
}

/**
 * Converte um valor monetário em centavos, com sinal.
 *
 * Formatos aceitos:
 *  - "R$ 1.250,50" / "1.250,50"  -> 125050 (padrão brasileiro)
 *  - "-R$ 500,00"                -> -50000
 *  - "-R$ 500.00" / "500.00"     -> -50000 / 50000 (ponto decimal)
 *  - "1.250"                     -> 125000 (ponto como milhar no padrão pt-BR)
 *  - "(500,00)"                  -> -50000
 *  - números de planilhas        -> arredondados para centavos
 *
 * Formatos genuinamente ambíguos (ex.: "1,250" com três casas após a vírgula)
 * são rejeitados em vez de convertidos por suposição.
 */
export function parseAmountToCents(input: unknown): ParseResult<number> {
  if (input === null || input === undefined) {
    return fail('Valor não informado.');
  }

  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return fail('Valor inválido.');
    const cents = Math.round(input * 100);
    if (!Number.isSafeInteger(cents) || Math.abs(cents) > MAX_CENTS) {
      return fail('Valor fora do limite permitido.');
    }
    return { ok: true, value: cents };
  }

  if (typeof input !== 'string') {
    return fail('Valor inválido.');
  }

  let raw = input.replace(/\u00a0/g, ' ').trim();
  if (!raw) return fail('Valor não informado.');

  let negative = false;
  if (/^\(.*\)$/.test(raw)) {
    negative = true;
    raw = raw.slice(1, -1).trim();
  }

  raw = raw
    .replace(/R\$/gi, '')
    .replace(/\bBRL\b/gi, '')
    .replace(/\$/g, '')
    .replace(/\u2212/g, '-')
    .replace(/\s+/g, '');

  if (!raw) return fail('Valor não informado.');

  if (raw.startsWith('+')) {
    raw = raw.slice(1);
  }

  if (raw.startsWith('-')) {
    if (negative) return fail('Sinal negativo duplicado.');
    negative = true;
    raw = raw.slice(1);
  }
  if (raw.endsWith('-')) {
    if (negative) return fail('Sinal negativo duplicado.');
    negative = true;
    raw = raw.slice(0, -1);
  }

  if (raw.includes('+') || raw.includes('-')) {
    return fail('Valor inválido.');
  }
  if (!/^\d[\d.,]*$/.test(raw)) {
    return fail('Valor inválido.');
  }

  const dotCount = (raw.match(/\./g) ?? []).length;
  const commaCount = (raw.match(/,/g) ?? []).length;

  if (dotCount === 0 && commaCount === 0) {
    const cents = Number(raw) * 100;
    if (!Number.isSafeInteger(cents) || Math.abs(cents) > MAX_CENTS) {
      return fail('Valor fora do limite permitido.');
    }
    return { ok: true, value: negative ? -cents : cents };
  }

  let decimalSeparator: '.' | ',' | null = null;
  let thousandsSeparator: '.' | ',' | null = null;

  if (dotCount > 0 && commaCount > 0) {
    decimalSeparator = raw.lastIndexOf(',') > raw.lastIndexOf('.') ? ',' : '.';
    thousandsSeparator = decimalSeparator === ',' ? '.' : ',';
  } else {
    const separator: '.' | ',' = dotCount > 0 ? '.' : ',';
    const occurrences = dotCount > 0 ? dotCount : commaCount;
    const lastIndex = raw.lastIndexOf(separator);
    const trailingDigits = raw.length - lastIndex - 1;

    if (occurrences === 1 && trailingDigits >= 1 && trailingDigits <= 2) {
      decimalSeparator = separator;
    } else if (occurrences === 1 && trailingDigits === 3 && separator === '.') {
      // "1.250" no padrão brasileiro = mil duzentos e cinquenta.
      thousandsSeparator = separator;
    } else if (occurrences > 1 && trailingDigits === 3) {
      thousandsSeparator = separator;
    } else if (trailingDigits === 3 && separator === ',') {
      return fail('Valor ambíguo: use ponto como separador de milhar ou vírgula decimal.');
    } else {
      return fail('Formato de valor não reconhecido.');
    }
  }

  let intRaw: string;
  let fraction = '';

  if (decimalSeparator) {
    const index = raw.lastIndexOf(decimalSeparator);
    intRaw = raw.slice(0, index);
    fraction = raw.slice(index + 1);
    if (!/^\d{1,2}$/.test(fraction)) {
      return fail('O valor deve ter no máximo duas casas decimais.');
    }
  } else {
    intRaw = raw;
  }

  let intDigits = intRaw;
  if (thousandsSeparator) {
    const stripped = stripThousands(intRaw, thousandsSeparator);
    if (!stripped.ok) return stripped;
    intDigits = stripped.value;
  }

  if (!/^\d+$/.test(intDigits) || intDigits.length === 0) {
    return fail('Valor inválido.');
  }
  if (intDigits.length > 15) {
    return fail('Valor fora do limite permitido.');
  }

  const reais = Number(intDigits);
  const cents = reais * 100 + Number(fraction.padEnd(2, '0') || '0');
  if (!Number.isSafeInteger(cents) || cents > MAX_CENTS) {
    return fail('Valor fora do limite permitido.');
  }

  return { ok: true, value: negative ? -cents : cents };
}

/** Converte centavos em um texto editável (sem símbolo), ex.: -50000 -> "-500,00". */
export function centsToPlain(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const reais = Math.floor(abs / 100);
  const fraction = String(abs % 100).padStart(2, '0');
  const grouped = reais.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${sign}${grouped},${fraction}`;
}

/** Formata centavos em BRL usando aritmética inteira (sem armazenar float). */
export function formatBRL(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const reais = Math.floor(abs / 100);
  const centavos = String(abs % 100).padStart(2, '0');
  const grouped = reais.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${sign}R$ ${grouped},${centavos}`;
}
