/** Modelo normalizado compartilhado pelos adaptadores estaduais de NFC-e. */
export interface PurchaseItemInput {
  description: string;
  quantity: string;
  unit: string;
  unitPriceCents: number;
  discountCents: number | null;
  totalCents: number;
  /** Código do produto no emitente (cProd), quando a nota informa. */
  code?: string | null;
  /** GTIN/EAN válido do produto, quando a nota informa. */
  ean?: string | null;
}

/** Forma de pagamento declarada na nota, com o valor pago nela. */
export interface PurchasePaymentInput {
  method: string;
  amountCents: number;
}

export interface PurchaseInput {
  accessKey: string;
  supplierName: string;
  supplierCnpj: string;
  invoiceNumber: string;
  series: string;
  issuedAt: string;
  totalCents: number;
  invoiceDiscountCents: number;
  paymentMethod: string | null;
  items: PurchaseItemInput[];
  payments?: PurchasePaymentInput[];
}

const MAX_CODE_LENGTH = 60;
const MAX_PAYMENTS = 20;

/** Lê o código do item no formato "(Código: 7890001)" usado pelos portais e cupons. */
export function itemCodeFrom(text: string): string | null {
  const code = text.match(/\(\s*C[oó]digo\s*:\s*([^)]+?)\s*\)/i)?.[1]?.trim();
  return code ? code.slice(0, MAX_CODE_LENGTH) : null;
}

/** GTIN com 8, 12, 13 ou 14 dígitos; "SEM GTIN" e outros textos viram null. */
export function normalizeEan(value: string | null | undefined): string | null {
  const digits = (value ?? '').trim();
  return /^(?:\d{8}|\d{12,14})$/.test(digits) ? digits : null;
}

const PAYMENT_METHODS: Array<[RegExp, string]> = [
  [/cart[aã]o\s+de\s+cr[eé]dito/i, 'Cartão de crédito'],
  [/cart[aã]o\s+de\s+d[eé]bito/i, 'Cartão de débito'],
  [/vale[-\s]?alimenta[cç][aã]o/i, 'Vale-alimentação'],
  [/vale[-\s]?refei[cç][aã]o/i, 'Vale-refeição'],
  [/vale[-\s]?presente/i, 'Vale-presente'],
  [/vale[-\s]?combust[ií]vel/i, 'Vale-combustível'],
  [/dinheiro/i, 'Dinheiro'],
  [/\bpix\b/i, 'Pix'],
  [/cheque/i, 'Cheque'],
  [/boleto/i, 'Boleto'],
  [/dep[oó]sito/i, 'Depósito bancário'],
  [/transfer[eê]ncia/i, 'Transferência'],
  [/fidelidade|cashback|cr[eé]dito\s+loja/i, 'Programa de fidelidade'],
  [/outros?/i, 'Outros'],
];

/** Nome padronizado da forma de pagamento; textos desconhecidos são mantidos, aparados. */
export function canonicalPaymentMethod(label: string): string {
  const text = label.replace(/\s+/g, ' ').trim();
  return PAYMENT_METHODS.find(([pattern]) => pattern.test(text))?.[1] ?? text.slice(0, 100);
}

function moneyCents(text: string): number | null {
  const match = text.match(/\d{1,3}(?:\.\d{3})*,\d{2}|\d+,\d{2}/);
  if (!match) return null;
  const value = Math.round(Number(match[0].replace(/\./g, '').replace(',', '.')) * 100);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** Linhas (rótulo, valor) lidas do bloco de pagamento de uma página do portal. */
export function paymentsFromRows(rows: Array<{ label: string; amountText: string }>): PurchasePaymentInput[] {
  return rows.flatMap(({ label, amountText }) => {
    const amountCents = moneyCents(amountText);
    const method = canonicalPaymentMethod(label);
    return amountCents === null || !method ? [] : [{ method, amountCents }];
  }).slice(0, MAX_PAYMENTS);
}

/** Pares "forma valor" no texto da seção "Forma de pagamento" de cupons copiados ou PDFs. */
export function paymentsFromText(section: string): PurchasePaymentInput[] {
  const names = PAYMENT_METHODS.map(([pattern]) => pattern.source).join('|');
  const pairs = section.matchAll(new RegExp(`(${names})\\s*:?\\s*(?:R\\$\\s*)?(\\d{1,3}(?:\\.\\d{3})*,\\d{2}|\\d+,\\d{2})`, 'gi'));
  return paymentsFromRows([...pairs].map((pair) => ({ label: pair[1] ?? '', amountText: pair[2] ?? '' })));
}

/**
 * Só guarda os pagamentos quando cobrem o total da nota (o excedente é troco).
 * Uma leitura parcial gravaria um rateio enganoso; nesse caso nada é gravado.
 */
export function consistentPayments(payments: PurchasePaymentInput[] | undefined, totalCents: number): PurchasePaymentInput[] {
  const list = (payments ?? []).filter((payment) => Number.isSafeInteger(payment.amountCents) && payment.amountCents > 0 && payment.method.trim());
  const sum = list.reduce((total, payment) => total + payment.amountCents, 0);
  return list.length > 0 && list.length <= MAX_PAYMENTS && sum >= totalCents ? list : [];
}
