import { badRequest, HttpError } from '../lib/errors';
import type { AppDatabase } from '../db/client';
import type { PurchaseInput } from './purchase-input';
import { findPurchaseByAccessKey, importPurchase } from './purchases';

export const MAX_COPIED_NFCE_TEXT_BYTES = 1024 * 1024;
export const MAX_COPIED_NFCE_BLOCKS = 50;
const MAX_ITEMS = 300;

const UF_BY_CODE: Record<string, string> = {
  '11': 'RO', '12': 'AC', '13': 'AM', '14': 'RR', '15': 'PA', '16': 'AP', '17': 'TO',
  '21': 'MA', '22': 'PI', '23': 'CE', '24': 'RN', '25': 'PB', '26': 'PE', '27': 'AL',
  '28': 'SE', '29': 'BA', '31': 'MG', '32': 'ES', '33': 'RJ', '35': 'SP', '41': 'PR',
  '42': 'SC', '43': 'RS', '50': 'MS', '51': 'MT', '52': 'GO', '53': 'DF',
};

type PublicPurchase = Omit<PurchaseInput, 'accessKey'>;
export type CopiedNfceRowStatus = 'ready' | 'invalid' | 'duplicate-file' | 'already-imported';
export interface CopiedNfcePreviewRow {
  block: number;
  state: string | null;
  status: CopiedNfceRowStatus;
  message: string | null;
  purchase: PublicPurchase | null;
  purchaseId: number | null;
}
export interface CopiedNfcePreview {
  rows: CopiedNfcePreviewRow[];
  summary: { total: number; ready: number; invalid: number; duplicateFile: number; alreadyImported: number };
}
export interface CopiedNfceImportResult {
  rows: { block: number; status: 'imported' | 'duplicate' | 'error'; message: string | null; purchaseId: number | null }[];
  summary: { total: number; imported: number; duplicate: number; error: number };
}

function invalid(message: string): never {
  throw badRequest(message);
}

function parseMoney(text: string, field: string, maxDecimals = 2): number {
  let value = text.replace(/R\$\s*/i, '').replace(/\s/g, '').trim();
  if (!value) return invalid('Não foi possível interpretar ' + field + ' da nota copiada.');
  let whole = '';
  let fraction = '';
  if (value.includes(',')) {
    const parts = value.split(',');
    if (parts.length !== 2 || !/^\d[\d.]*$/.test(parts[0] ?? '') || !new RegExp('^\\d{1,' + maxDecimals + '}$').test(parts[1] ?? '')) {
      return invalid('Valor inválido em ' + field + ' da nota copiada.');
    }
    whole = (parts[0] ?? '').replace(/\./g, '');
    fraction = parts[1] ?? '';
  } else if (value.includes('.')) {
    const lastDot = value.lastIndexOf('.');
    const trailing = value.length - lastDot - 1;
    if (trailing > 0 && trailing <= maxDecimals && /^\d[\d.]*$/.test(value)) {
      whole = value.slice(0, lastDot).replace(/\./g, '');
      fraction = value.slice(lastDot + 1);
    } else if (/^\d{1,3}(?:\.\d{3})+$/.test(value)) {
      whole = value.replace(/\./g, '');
    } else {
      return invalid('Valor inválido em ' + field + ' da nota copiada.');
    }
  } else if (/^\d+$/.test(value)) {
    whole = value;
  } else {
    return invalid('Valor inválido em ' + field + ' da nota copiada.');
  }

  try {
    let cents = BigInt(whole) * 100n + BigInt(fraction.slice(0, 2).padEnd(2, '0'));
    if (fraction.length > 2 && Number(fraction[2]) >= 5) cents += 1n;
    const result = Number(cents);
    if (!Number.isSafeInteger(result)) return invalid('Valor fora do limite em ' + field + ' da nota copiada.');
    return result;
  } catch {
    return invalid('Valor inválido em ' + field + ' da nota copiada.');
  }
}

function amountAfterLabel(lines: string[], label: RegExp, field: string, optional = false): number | null {
  for (let index = 0; index < lines.length; index += 1) {
    const match = label.exec(lines[index] ?? '');
    if (!match) continue;
    const remainder = (lines[index] ?? '').slice(match.index + match[0].length);
    const sameLine = remainder.match(/-?\d[\d.]*(?:,\d{1,2})?/);
    if (sameLine) return parseMoney(sameLine[0], field);
    for (const candidate of lines.slice(index + 1, index + 3)) {
      const nextAmount = candidate.match(/^-?\d[\d.]*(?:,\d{1,2})?$/);
      if (nextAmount) return parseMoney(nextAmount[0], field);
      if (/^(?:Forma de pagamento|Descontos|Valor a pagar|Troco|Qtd\.)/i.test(candidate)) break;
    }
    if (optional) return null;
    return invalid('Não foi possível ler ' + field + ' da nota copiada.');
  }
  if (optional) return null;
  return invalid('A nota copiada não contém ' + field + '.');
}

function validAccessKey(key: string): boolean {
  if (!/^\d{44}$/.test(key) || !UF_BY_CODE[key.slice(0, 2)] || key.slice(20, 22) !== '65') return false;
  let weight = 2;
  let sum = 0;
  for (let index = 42; index >= 0; index -= 1) {
    sum += Number(key[index]) * weight;
    weight = weight === 9 ? 2 : weight + 1;
  }
  const remainder = sum % 11;
  return (remainder < 2 ? 0 : 11 - remainder) === Number(key[43]);
}

function accessKeyFromLines(lines: string[]): string {
  const marker = lines.findIndex((line) => /Chave de acesso\s*:/i.test(line));
  if (marker < 0) return '';
  const sameLine = (lines[marker] ?? '').replace(/^.*?Chave de acesso\s*:/i, '').replace(/\D/g, '');
  if (sameLine.length === 44) return sameLine;
  for (const line of lines.slice(marker + 1, marker + 4)) {
    const digits = line.replace(/\D/g, '');
    if (digits.length === 44) return digits;
  }
  return '';
}

function parseQuantity(text: string): string {
  const normalized = text.replace(',', '.');
  const value = Number(normalized);
  if (!/^\d+(?:\.\d+)?$/.test(normalized) || !Number.isFinite(value) || value <= 0) {
    return invalid('A nota copiada contém uma quantidade inválida.');
  }
  return normalized;
}

function parseItem(lines: string[], index: number): PurchaseInput['items'][number] {
  const descriptionLine = lines[index] ?? '';
  const description = descriptionLine.replace(/\s*\(\s*Código\s*:\s*\d+\s*\)\s*$/i, '').trim();
  const detail = lines[index + 1] ?? '';
  const quantity = detail.match(/Qtde\.?\s*:\s*([\d.,]+)/i)?.[1];
  const unit = detail.match(/\bUN\s*:\s*([\p{L}\d._-]+)/iu)?.[1];
  const unitPrice = detail.match(/Vl\.?\s*Unit\.?\s*:\s*(?:R\$\s*)?([\d.,]+)/i)?.[1];
  const discount = detail.match(/(?:Vl\.?\s*Desc\.?|Desconto)\s*:\s*(?:R\$\s*)?([\d.,]+)/i)?.[1] ?? null;
  const totalRemainder = detail.match(/Vl\.?\s*Total\s*:?\s*(.*)$/i)?.[1]?.trim() ?? '';
  const totalText = totalRemainder || lines[index + 2] || '';
  if (!description || !quantity || !unit || !unitPrice || !/^\d+(?:[.,]\d{1,2})?$/.test(totalText.trim())) {
    return invalid('Um item da nota copiada está incompleto.');
  }
  return {
    description: description.slice(0, 500),
    quantity: parseQuantity(quantity),
    unit: unit.slice(0, 20),
    unitPriceCents: parseMoney(unitPrice, 'preço unitário', 6),
    discountCents: discount === null ? null : parseMoney(discount, 'desconto do item'),
    totalCents: parseMoney(totalText, 'total do item'),
  };
}

function parseCopiedNfceBlock(block: string): { purchase: PurchaseInput; state: string } {
  const lines = block.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const cnpjIndex = lines.findIndex((line) => /\bCNPJ\s*:/i.test(line));
  const cnpjText = cnpjIndex >= 0 ? lines[cnpjIndex] ?? '' : '';
  const supplierCnpj = cnpjText.match(/\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/)?.[0].replace(/\D/g, '') ?? '';
  const supplierName = cnpjIndex > 0 ? (lines[cnpjIndex - 1] ?? '').trim() : '';
  if (!supplierName || supplierName.length > 200) invalid('Não foi possível identificar o fornecedor da nota copiada.');
  if (supplierCnpj.length !== 14) invalid('Não foi possível identificar o CNPJ do fornecedor na nota copiada.');

  const accessKey = accessKeyFromLines(lines);
  if (!validAccessKey(accessKey)) invalid('A chave da NFC-e está ausente ou inválida no texto copiado.');
  if (accessKey.slice(6, 20) !== supplierCnpj) invalid('A chave de acesso e o CNPJ do fornecedor não conferem.');

  const metadata = lines.join(' ');
  const invoiceMatch = metadata.match(/Número\s*:\s*(\d+)\s+Série\s*:\s*(\d+)\s+Emissão\s*:\s*(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}:\d{2}(?::\d{2})?)/i);
  if (!invoiceMatch) invalid('Não foi possível ler número, série e data da nota copiada.');
  const invoiceNumber = invoiceMatch[1] ?? '';
  const series = invoiceMatch[2] ?? '';
  const day = invoiceMatch[3] ?? '';
  const month = invoiceMatch[4] ?? '';
  const year = invoiceMatch[5] ?? '';
  const time = invoiceMatch[6]?.length === 5 ? invoiceMatch[6] + ':00' : invoiceMatch[6] ?? '';
  const date = new Date(Number(year), Number(month) - 1, Number(day), 12, 0, 0);
  if (date.getFullYear() !== Number(year) || date.getMonth() !== Number(month) - 1 || date.getDate() !== Number(day)) {
    invalid('A data de emissão da nota copiada é inválida.');
  }
  if (Number(invoiceNumber) !== Number(accessKey.slice(25, 34)) ||
      Number(series) !== Number(accessKey.slice(22, 25)) ||
      accessKey.slice(2, 6) !== year.slice(-2) + month) {
    invalid('Número, série ou data não conferem com a chave de acesso da nota.');
  }

  const itemIndexes = lines.map((line, index) => /\(Código\s*:\s*\d+\s*\)/i.test(line) ? index : -1).filter((index) => index >= 0);
  if (itemIndexes.length === 0 || itemIndexes.length > MAX_ITEMS) invalid('A nota copiada não contém uma quantidade válida de itens.');
  const items = itemIndexes.map((index) => parseItem(lines, index));
  const receiptCountLine = lines.find((line) => /Qtd\.\s*total de itens\s*:/i.test(line));
  const receiptCount = receiptCountLine?.match(/:\s*(\d+)/)?.[1];
  if (receiptCount !== undefined && Number(receiptCount) !== items.length) {
    invalid('A quantidade de itens não confere com o resumo da nota.');
  }

  const grossTotal = amountAfterLabel(lines, /Valor total\s*R\$\s*:?\s*/i, 'valor total dos itens', true);
  const invoiceDiscount = amountAfterLabel(lines, /Descontos\s*R\$\s*:?\s*/i, 'desconto total', true) ?? 0;
  const total = amountAfterLabel(lines, /Valor a pagar\s*R\$\s*:?\s*/i, 'valor a pagar');
  const itemsTotal = items.reduce((sum, item) => sum + item.totalCents, 0);
  const expectedGross = grossTotal ?? itemsTotal;
  if (itemsTotal !== expectedGross || expectedGross - invoiceDiscount !== total) {
    invalid('Os itens, descontos e valor a pagar não conferem na nota copiada.');
  }

  const paymentSection = metadata.match(/Forma de pagamento\s*:?(.*?)(?=Troco\s*:|Informação dos Tributos|EMISSÃO NORMAL|$)/i)?.[1] ?? '';
  const paymentMethod = paymentSection.match(/Cartão de Crédito|Cartão de Débito|Dinheiro|Pix|Cheque|Boleto|Transferência|Vale[- ](?:refeição|alimentação|presente)|Outros?/i)?.[0] ?? null;

  return {
    state: UF_BY_CODE[accessKey.slice(0, 2)] ?? null,
    purchase: {
      accessKey,
      supplierName,
      supplierCnpj,
      invoiceNumber,
      series,
      issuedAt: year + '-' + month + '-' + day + 'T' + time + '-03:00',
      totalCents: total,
      invoiceDiscountCents: invoiceDiscount,
      paymentMethod,
      items,
    },
  };
}

function splitBlocks(text: string): string[] {
  if (Buffer.byteLength(text, 'utf8') > MAX_COPIED_NFCE_TEXT_BYTES) {
    invalid('O texto copiado excede o limite de 1 MB.');
  }
  const blocks = text.split(/^\s*-{3,}\s*$/m).map((block) => block.trim()).filter(Boolean);
  if (blocks.length === 0) invalid('Cole ao menos uma nota fiscal.');
  if (blocks.length > MAX_COPIED_NFCE_BLOCKS) {
    invalid('O texto contém mais de 50 blocos. Divida as notas em grupos menores.');
  }
  return blocks;
}

function publicPurchase(purchase: PurchaseInput): PublicPurchase {
  const { accessKey: _accessKey, ...safe } = purchase;
  return safe;
}

export function previewCopiedNfceText(db: AppDatabase, text: string): CopiedNfcePreview {
  const blocks = splitBlocks(text);
  const seen = new Set<string>();
  const rows: CopiedNfcePreviewRow[] = blocks.map((block, index) => {
    try {
      const parsed = parseCopiedNfceBlock(block);
      if (seen.has(parsed.purchase.accessKey)) {
        return { block: index + 1, state: parsed.state, status: 'duplicate-file', message: 'Nota repetida neste texto.', purchase: null, purchaseId: null };
      }
      seen.add(parsed.purchase.accessKey);
      const purchaseId = findPurchaseByAccessKey(db, parsed.purchase.accessKey);
      if (purchaseId !== null) {
        return { block: index + 1, state: parsed.state, status: 'already-imported', message: 'Esta nota já está nas compras.', purchase: null, purchaseId };
      }
      return { block: index + 1, state: parsed.state, status: 'ready', message: null, purchase: publicPurchase(parsed.purchase), purchaseId: null };
    } catch (error) {
      return {
        block: index + 1,
        state: null,
        status: 'invalid',
        message: error instanceof HttpError ? error.message : 'Não foi possível interpretar este bloco da nota.',
        purchase: null,
        purchaseId: null,
      };
    }
  });
  return {
    rows,
    summary: {
      total: rows.length,
      ready: rows.filter((row) => row.status === 'ready').length,
      invalid: rows.filter((row) => row.status === 'invalid').length,
      duplicateFile: rows.filter((row) => row.status === 'duplicate-file').length,
      alreadyImported: rows.filter((row) => row.status === 'already-imported').length,
    },
  };
}

export function importCopiedNfceText(
  db: AppDatabase,
  text: string,
  selectedBlocks: number[],
): CopiedNfceImportResult {
  const blocks = splitBlocks(text);
  if (!Array.isArray(selectedBlocks) || selectedBlocks.length === 0 || selectedBlocks.length > MAX_COPIED_NFCE_BLOCKS) {
    invalid('Selecione ao menos uma nota para importar.');
  }
  if (selectedBlocks.some((block) => !Number.isInteger(block) || block < 1 || block > blocks.length)) {
    invalid('A seleção de blocos da nota é inválida.');
  }
  const unique = [...new Set(selectedBlocks)].sort((a, b) => a - b);
  const rows: CopiedNfceImportResult['rows'] = [];
  for (const blockNumber of unique) {
    try {
      const parsed = parseCopiedNfceBlock(blocks[blockNumber - 1] ?? '');
      const result = importPurchase(db, parsed.purchase);
      rows.push({
        block: blockNumber,
        status: result.duplicate ? 'duplicate' : 'imported',
        message: result.duplicate ? 'Esta nota já estava nas compras.' : null,
        purchaseId: result.id,
      });
    } catch (error) {
      rows.push({
        block: blockNumber,
        status: 'error',
        message: error instanceof HttpError ? error.message : 'Não foi possível importar este bloco da nota.',
        purchaseId: null,
      });
    }
  }
  return {
    rows,
    summary: {
      total: rows.length,
      imported: rows.filter((row) => row.status === 'imported').length,
      duplicate: rows.filter((row) => row.status === 'duplicate').length,
      error: rows.filter((row) => row.status === 'error').length,
    },
  };
}
