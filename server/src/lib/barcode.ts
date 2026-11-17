/**
 * Linha digitável de boletos (padrão FEBRABAN). Módulo puro.
 *  - Boleto bancário: 47 dígitos em 5 campos; os 3 primeiros têm dígito
 *    verificador módulo 10 e o 4º é o DV geral (módulo 11) do código de barras.
 *  - Arrecadação (contas de consumo, tributos): 48 dígitos em 4 blocos de 11 +
 *    DV, que é módulo 10 ou 11 conforme o 3º dígito.
 */

export type BarcodeKind = 'bank' | 'utility';

export interface BarcodeDetails {
  digits: string;
  kind: BarcodeKind;
  /** Valor gravado no código; nulo quando é zero ou é uma referência. */
  amountCents: number | null;
  /** Vencimento pelo fator (só boleto bancário); nulo quando o fator é zero. */
  dueDate: string | null;
  formatted: string;
}

export type BarcodeResult = { ok: true; value: BarcodeDetails } | { ok: false; error: string };

export function normalizeBarcode(value: unknown): string {
  return String(value ?? '').replace(/\D/g, '');
}

/** Módulo 10: pesos 2,1 da direita para a esquerda, somando os dígitos dos produtos. */
export function mod10(digits: string): number {
  let sum = 0;
  let weight = 2;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    const product = Number(digits[index]) * weight;
    sum += Math.floor(product / 10) + (product % 10);
    weight = weight === 2 ? 1 : 2;
  }
  return (10 - (sum % 10)) % 10;
}

/** Soma ponderada do módulo 11 (pesos 2 a 9 da direita para a esquerda). */
function mod11Remainder(digits: string): number {
  let sum = 0;
  let weight = 2;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    sum += Number(digits[index]) * weight;
    weight = weight === 9 ? 2 : weight + 1;
  }
  return sum % 11;
}

/** DV geral do código de barras bancário: 0, 10 e 11 viram 1. */
export function bankMod11(digits: string): number {
  const dv = 11 - mod11Remainder(digits);
  return dv === 0 || dv === 10 || dv === 11 ? 1 : dv;
}

/** DV módulo 11 da arrecadação: restos 0 e 1 viram 0. */
export function utilityMod11(digits: string): number {
  const remainder = mod11Remainder(digits);
  return remainder === 0 || remainder === 1 ? 0 : 11 - remainder;
}

function addDays(iso: string, days: number): string {
  const [year, month, day] = iso.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day) + days * 86_400_000).toISOString().slice(0, 10);
}

function dayDistance(a: string, b: string): number {
  return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
}

/**
 * Fator de vencimento: dias desde 07/10/1997. Ao chegar a 9999 (21/02/2025) o
 * fator recomeçou em 1000 (22/02/2025); vale o ciclo mais próximo de hoje.
 */
export function dueDateFromFactor(factor: number, today: string): string | null {
  if (factor === 0) return null;
  const firstCycle = addDays('1997-10-07', factor);
  if (factor < 1000) return firstCycle;
  const secondCycle = addDays('2025-02-22', factor - 1000);
  return dayDistance(secondCycle, today) < dayDistance(firstCycle, today) ? secondCycle : firstCycle;
}

function parseBank(digits: string, today: string): BarcodeResult {
  const fields = [digits.slice(0, 9), digits.slice(10, 20), digits.slice(21, 31)];
  const checks = [digits[9], digits[20], digits[31]].map(Number);
  for (let index = 0; index < fields.length; index += 1) {
    if (mod10(fields[index]) !== checks[index]) {
      return { ok: false, error: `Linha digitável inválida: o dígito do ${index + 1}º campo não confere.` };
    }
  }
  const generalDv = Number(digits[32]);
  const factorAndAmount = digits.slice(33, 47);
  // Código de barras: banco+moeda, DV geral, fator+valor, campo livre.
  const barcode = digits.slice(0, 4) + generalDv + factorAndAmount + digits.slice(4, 9) + digits.slice(10, 20) + digits.slice(21, 31);
  if (bankMod11(barcode.slice(0, 4) + barcode.slice(5)) !== generalDv) {
    return { ok: false, error: 'Linha digitável inválida: o dígito verificador geral não confere.' };
  }
  const amountCents = Number(digits.slice(37, 47));
  return {
    ok: true,
    value: {
      digits,
      kind: 'bank',
      amountCents: amountCents > 0 ? amountCents : null,
      dueDate: dueDateFromFactor(Number(digits.slice(33, 37)), today),
      formatted: formatBarcodeDigits(digits),
    },
  };
}

function parseUtility(digits: string): BarcodeResult {
  if (digits[0] !== '8') return { ok: false, error: 'Linha digitável de arrecadação deve começar com 8.' };
  const valueId = digits[2];
  if (!['6', '7', '8', '9'].includes(valueId)) {
    return { ok: false, error: 'Linha digitável de arrecadação inválida: 3º dígito deve ser 6, 7, 8 ou 9.' };
  }
  const check = valueId === '6' || valueId === '7' ? mod10 : utilityMod11;
  const blocks: string[] = [];
  for (let index = 0; index < 4; index += 1) {
    const block = digits.slice(index * 12, index * 12 + 11);
    if (check(block) !== Number(digits[index * 12 + 11])) {
      return { ok: false, error: `Linha digitável inválida: o dígito do ${index + 1}º bloco não confere.` };
    }
    blocks.push(block);
  }
  const barcode = blocks.join('');
  // DV geral (4ª posição) do código de barras, sem ele no cálculo.
  if (check(barcode.slice(0, 3) + barcode.slice(4)) !== Number(barcode[3])) {
    return { ok: false, error: 'Linha digitável inválida: o dígito verificador geral não confere.' };
  }
  // 6 e 8 trazem o valor efetivo; 7 e 9, um valor de referência.
  const amountCents = valueId === '6' || valueId === '8' ? Number(barcode.slice(4, 15)) : 0;
  return {
    ok: true,
    value: {
      digits,
      kind: 'utility',
      amountCents: amountCents > 0 ? amountCents : null,
      dueDate: null,
      formatted: formatBarcodeDigits(digits),
    },
  };
}

/** Formata para leitura: campos do boleto (47) ou blocos da arrecadação (48). */
export function formatBarcodeDigits(digits: string): string {
  if (digits.length === 47) {
    return `${digits.slice(0, 5)}.${digits.slice(5, 10)} ${digits.slice(10, 15)}.${digits.slice(15, 21)} ${digits.slice(21, 26)}.${digits.slice(26, 32)} ${digits[32]} ${digits.slice(33)}`;
  }
  if (digits.length === 48) {
    return [0, 1, 2, 3].map((index) => `${digits.slice(index * 12, index * 12 + 11)}-${digits[index * 12 + 11]}`).join(' ');
  }
  return digits;
}

/** Valida a linha digitável (com ou sem pontos e espaços) e extrai o que ela traz. */
export function parseBarcode(value: unknown, today: string): BarcodeResult {
  const digits = normalizeBarcode(value);
  if (digits.length === 47) return parseBank(digits, today);
  if (digits.length === 48) return parseUtility(digits);
  return { ok: false, error: 'A linha digitável tem 47 dígitos (boleto) ou 48 (conta de consumo ou tributo).' };
}
