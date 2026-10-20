/**
 * Normaliza nomes para identificação (não para exibição):
 * ignora caixa, acentuação, espaços redundantes e pontuação de borda.
 */
export function normalizeName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\u00a0/g, ' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Nome de exibição: mantém caixa e acentos, remove apenas espaços nas bordas. */
export function displayName(value: string): string {
  return value.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

export const EMPTY_CATEGORY_NAME = 'Sem categoria';
export const EMPTY_PAYMENT_METHOD_NAME = 'Não informado';
