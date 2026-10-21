import path from 'node:path';
import * as XLSX from 'xlsx';
import { desc, eq } from 'drizzle-orm';
import type { AppDatabase } from '../db/client';
import { categories, importBatches, importMappingTemplates, paymentMethods, transactions } from '../db/schema';
import { parseDateValue, type DueDateSource } from '../lib/dates';
import { badRequest, nowIso } from '../lib/errors';
import {
  deriveDueDateFromPurchase,
  estimateFirstInstallmentDate,
  isCashPurchaseText,
  normalizeTransfer,
  parseInstallments,
} from '../lib/installments';
import {
  suggestCategory,
  persistCategoryAlias,
  type CategorySuggestion,
  type CategorySuggestionAlternative,
} from './category-matching';
import { parseAmountToCents } from '../lib/money';
import { displayName, EMPTY_CATEGORY_NAME, EMPTY_PAYMENT_METHOD_NAME, normalizeName } from '../lib/normalize';
import { ensureLookup } from './lookups';
import {
  detectTransferCandidates,
  fileParty,
  loadUnlinkedDatabaseParties,
  type TransferCandidate,
} from './transfer-detection';
import { insertTransferRecord } from './transfers';

export const IMPORT_FIELDS = [
  'purchaseDate',
  'dueDate',
  'description',
  'amount',
  'paymentMethod',
  'installments',
  'category',
  'transfer',
] as const;

export type ImportField = (typeof IMPORT_FIELDS)[number];
export type ColumnMapping = Partial<Record<ImportField, number | null>>;

export const REQUIRED_FIELDS: ImportField[] = ['description', 'amount'];

export const FIELD_LABELS: Record<ImportField, string> = {
  purchaseDate: 'Data Compra',
  dueDate: 'Vencimento',
  description: 'Compra',
  amount: 'Valor',
  paymentMethod: 'Pagamento',
  installments: 'Parcelas',
  category: 'Categorias',
  transfer: 'Transf',
};

/**
 * Cabeçalhos conhecidos por campo (sem acento, minúsculo — passe por `headerKey`).
 * A correspondência não depende da ordem das colunas.
 */
const ALIASES: Record<ImportField, string[]> = {
  purchaseDate: ['data compra', 'data da compra', 'data de compra', 'purchase date'],
  dueDate: [
    'vencimento',
    'data vencimento',
    'data de vencimento',
    'data movimento',
    'data de movimento',
    'dt vencimento',
    'due date',
  ],
  description: ['compra', 'descricao', 'historico', 'description', 'lancamento', 'estabelecimento', 'nome'],
  amount: ['valor', 'valor r', 'amount', 'value', 'total', 'quantia', 'montante'],
  paymentMethod: [
    'pagamento',
    'forma de pagamento',
    'forma pagamento',
    'meio de pagamento',
    'meio pagamento',
    'payment',
    'payment method',
    'conta',
    'cartao',
    'cartao usado',
    'origem',
  ],
  installments: ['parcelas', 'parcela', 'prestacao', 'installments', 'installment'],
  category: ['categorias', 'categoria', 'category', 'categories'],
  transfer: ['transf', 'transferencia', 'transfer', 'transferencia bancaria'],
};

/** Cabeçalho genérico de data, tratado por regra própria (fase 2). */
const GENERIC_DATE_HEADER = 'data';

const MAX_ROWS = 20_000;

export const DEFAULT_TRANSFER_TOLERANCE_DAYS = 3;

export type TransferDecision = 'confirm' | 'reject' | 'pending';

export interface CellMeta {
  type: string;
  format?: string;
  text?: string;
}

export interface SheetRow {
  rowNumber: number;
  cells: unknown[];
  /** Metadados das células (tipo/formato do Excel), na mesma ordem de `cells`. */
  meta: (CellMeta | null)[];
}

export interface ParsedWorkbook {
  filename: string;
  sheetName: string;
  headers: string[];
  rows: SheetRow[];
  mapping: ColumnMapping;
}

export type PurchaseDateSource = 'file' | 'due_date_fallback';

export interface ParsedImportValues {
  purchaseDate: string | null;
  /** Origem da data de compra: arquivo ou derivada do vencimento por fallback. */
  purchaseDateSource: PurchaseDateSource | null;
  dueDate: string | null;
  /** Origem da data de vencimento: arquivo ou derivada da data de compra. */
  dueDateSource: DueDateSource | null;
  description: string;
  amountCents: number | null;
  paymentMethod: string | null;
  category: string;
  cashPurchase: boolean;
  installmentNumber: number | null;
  installmentTotal: number | null;
  installmentSource: 'column' | 'description' | null;
  installmentOriginal: string | null;
  /** Data estimada da primeira parcela (calculada, nunca histórica). */
  estimatedFirstInstallmentDate: string | null;
  transfer: string | null;
}

export interface FieldIssue {
  field: ImportField;
  message: string;
}

export interface RowSuggestion {
  field: ImportField;
  number: number;
  total: number;
  label: string;
}

export interface DuplicateCounterpart {
  source: 'file' | 'database';
  rowNumber: number | null;
  transactionId: number | null;
  purchaseDate: string;
  dueDate: string;
  description: string;
  amountCents: number;
  paymentMethod: string;
  category: string;
  installmentNumber: number | null;
  installmentTotal: number | null;
  importBatchId: number | null;
  importedAt: string | null;
}

export interface DuplicateInfo {
  kind: 'exact' | 'probable';
  source: 'file' | 'database';
  /** Identificador do grupo (linha líder no arquivo ou lançamento no banco). */
  groupKey: string;
  counterpartRowNumber: number | null;
  counterpartTransactionId: number | null;
  counterpart: DuplicateCounterpart;
  reason: string;
}

export interface PreviewRow {
  rowNumber: number;
  raw: Record<ImportField, string>;
  values: ParsedImportValues;
  errors: string[];
  issues: FieldIssue[];
  suggestions: RowSuggestion[];
  installmentNote: string | null;
  duplicate: DuplicateInfo | null;
  categorySuggestion: CategorySuggestion;
}

export interface ImportPreview {
  filename: string;
  sheetName: string;
  headers: string[];
  mapping: ColumnMapping;
  mappingErrors: string[];
  /** Avisos do reconhecimento automático (ambiguidades, colunas sem campo). */
  mappingWarnings: MappingWarning[];
  /** Modelo de mapeamento aplicado automaticamente, quando houver. */
  appliedTemplate: { id: number; name: string } | null;
  totalRows: number;
  validRows: number;
  invalidRows: number;
  duplicateRows: number;
  rows: PreviewRow[];
  transferToleranceDays: number;
  transferCandidates: TransferCandidate[];
  categorySuggestions: {
    sourceCategory: string;
    sourceNormalized: string;
    count: number;
    targetCategoryId: number | null;
    targetCategoryName: string | null;
    confidence: 'high' | 'medium' | 'low';
    reason: string;
    method: string;
    ambiguous: boolean;
    alternatives: CategorySuggestionAlternative[];
  }[];
}

export interface ImportOverrides {
  [rowNumber: string]: Partial<Record<ImportField, string>>;
}

export type CategoryDecisionAction = 'accept' | 'use' | 'create' | 'reject';

export interface CategoryDecision {
  action: CategoryDecisionAction;
  sourceCategory?: string | null;
  targetCategoryId?: number | null;
  newCategoryName?: string | null;
}

export type CategoryDecisions = Record<string, CategoryDecision>;

export interface ImportOptions {
  mapping: ColumnMapping;
  destinationPaymentMethodId?: number | null;
  categoryDecisions?: CategoryDecisions | CategoryDecision[];
  overrides?: ImportOverrides;
  skipDuplicates?: boolean;
  rejectedRows?: number[];
  transferToleranceDays?: number;
  transferDecisions?: Record<string, TransferDecision>;
  /** Modelo de mapeamento aplicado nesta importação (registra no lote). */
  templateId?: number;
}

export interface ImportSummary {
  batchId: number;
  filename: string;
  totalRows: number;
  importedRows: number;
  rejectedRows: number;
  duplicateRows: number;
  skippedDuplicates: number;
  invalidRows: number;
  explicitRejections: number;
  createdCategories: string[];
  createdPaymentMethods: string[];
  duplicateRowsInPreview: number;
  transferCandidates: number;
  confirmedTransfers: number;
  pendingTransfers: number;
  rejectedTransfers: number;
  ignoredRows: number;
  firstDueDate: string | null;
  lastDueDate: string | null;
  errors: { rowNumber: number; errors: string[] }[];
}

function decodeCsv(buffer: Buffer): string {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.subarray(3).toString('utf8');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return new TextDecoder('windows-1252').decode(buffer);
  }
}

function detectDelimiter(text: string): string {
  const firstLine = text.split(/\r?\n/).find((line) => line.trim().length > 0) ?? '';
  const counts = { ';': 0, ',': 0, '\t': 0 };
  let quoted = false;
  for (let i = 0; i < firstLine.length; i += 1) {
    const char = firstLine[i];
    if (char === '"') {
      if (quoted && firstLine[i + 1] === '"') i += 1;
      else quoted = !quoted;
    } else if (!quoted && (char === ';' || char === ',' || char === '\t')) {
      counts[char] += 1;
    }
  }
  const entries = Object.entries(counts) as [string, number][];
  entries.sort((a, b) => b[1] - a[1] || (a[0] === ';' ? -1 : 1));
  return entries[0][1] > 0 ? entries[0][0] : ',';
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) {
    return `${value.getDate().toString().padStart(2, '0')}/${(value.getMonth() + 1)
      .toString()
      .padStart(2, '0')}/${value.getFullYear()}`;
  }
  return String(value).replace(/\u00a0/g, ' ').trim();
}

function headerKey(value: string): string {
  return normalizeName(value).replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

export interface MappingWarning {
  level: 'info' | 'warning';
  /** Campo afetado, quando aplicável. */
  field: ImportField | null;
  message: string;
}

export interface MappingSuggestion {
  mapping: ColumnMapping;
  warnings: MappingWarning[];
}

/**
 * Sugere o mapeamento dos cabeçalhos em três fases:
 *
 * 1. correspondência exata com cabeçalhos específicos de cada campo;
 * 2. coluna genérica "data": quando nenhuma outra coluna de data foi
 *    reconhecida, assume-se vencimento/movimento — primeiro desempate
 *    para compra, se o vencimento já estiver ocupado;
 * 3. semelhança (substring) de baixa confiança, sempre acompanhada de aviso
 *    para confirmação explícita do usuário.
 */
export function suggestMappingDetailed(headers: string[]): MappingSuggestion {
  const mapping: ColumnMapping = {};
  const warnings: MappingWarning[] = [];
  const used = new Set<number>();

  const keys = headers.map(headerKey);

  // Fase 1: correspondência exata com aliases específicos.
  for (const field of IMPORT_FIELDS) {
    let found = -1;
    for (const alias of ALIASES[field]) {
      const index = keys.findIndex((key, i) => key === alias && !used.has(i));
      if (index >= 0) {
        found = index;
        break;
      }
    }
    if (found >= 0) {
      mapping[field] = found;
      used.add(found);
    } else {
      mapping[field] = null;
    }
  }

  // Fase 2: coluna genérica "data".
  const genericIndex = keys.findIndex((key, i) => key === GENERIC_DATE_HEADER && !used.has(i));
  if (genericIndex >= 0) {
    if (mapping.dueDate === null) {
      mapping.dueDate = genericIndex;
      used.add(genericIndex);
      warnings.push({
        level: 'info',
        field: 'dueDate',
        message: `A coluna "${headers[genericIndex]}" foi interpretada como Vencimento (coluna de data genérica). Ajuste no seletor se for outro campo.`,
      });
    } else if (mapping.purchaseDate === null) {
      mapping.purchaseDate = genericIndex;
      used.add(genericIndex);
      warnings.push({
        level: 'info',
        field: 'purchaseDate',
        message: `A coluna "${headers[genericIndex]}" foi interpretada como Data Compra, pois o vencimento já foi reconhecido em outra coluna. Ajuste no seletor se for outro campo.`,
      });
    }
  }

  // Fase 3: semelhança (substring) — baixa confiança, exige revisão.
  for (const field of IMPORT_FIELDS) {
    if (mapping[field] !== null) continue;
    for (const alias of ALIASES[field]) {
      if (alias.length < 4) continue;
      const index = keys.findIndex((key, i) => key.includes(alias) && !used.has(i));
      if (index >= 0) {
        mapping[field] = index;
        used.add(index);
        warnings.push({
          level: 'warning',
          field,
          message: `A coluna "${headers[index]}" foi reconhecida por semelhança como ${FIELD_LABELS[field]}. Confirme ou corrija o mapeamento.`,
        });
        break;
      }
    }
  }

  // Cabeçalhos não utilizados: pista de mapeamento incompleto.
  const unusedHeaders = headers.filter((_, index) => !used.has(index));
  if (unusedHeaders.length > 0) {
    warnings.push({
      level: 'info',
      field: null,
      message: `Colunas sem campo correspondente: ${unusedHeaders.join(', ')}.`,
    });
  }

  return { mapping, warnings };
}

/** Somente o mapeamento (compatibilidade com chamadas existentes). */
export function suggestMapping(headers: string[]): ColumnMapping {
  return suggestMappingDetailed(headers).mapping;
}

export function readWorkbook(buffer: Buffer, filename: string): ParsedWorkbook {
  const ext = path.extname(filename).toLowerCase();
  let workbook: XLSX.WorkBook;

  try {
    if (ext === '.csv' || ext === '.txt') {
      const text = decodeCsv(buffer);
      const delimiter = detectDelimiter(text);
      workbook = XLSX.read(text, { type: 'string', FS: delimiter, raw: true });
    } else if (ext === '.xlsx' || ext === '.xls' || ext === '.xlsm' || ext === '') {
      workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false });
    } else {
      throw badRequest('Formato não suportado. Envie um arquivo CSV, XLS ou XLSX.');
    }
  } catch (error) {
    if (error instanceof Error && 'statusCode' in error) throw error;
    throw badRequest('Não foi possível ler o arquivo. Verifique se ele é um CSV ou Excel válido.');
  }

  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw badRequest('O arquivo não contém planilhas.');
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) throw badRequest('A planilha está vazia.');
  const sheetRange = XLSX.utils.decode_range(sheet['!ref'] ?? 'A1');

  const metaAt = (matrixIndex: number, columnIndex: number): CellMeta | null => {
    const address = XLSX.utils.encode_cell({
      r: sheetRange.s.r + matrixIndex,
      c: columnIndex,
    });
    const cell = sheet[address] as XLSX.CellObject | undefined;
    if (!cell) return null;
    return {
      type: cell.t,
      format: typeof cell.z === 'string' ? cell.z : undefined,
      text: typeof cell.w === 'string' ? cell.w : undefined,
    };
  };

  const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    raw: true,
    defval: null,
    blankrows: true,
  });

  if (matrix.length === 0) throw badRequest('A planilha está vazia.');

  let headerIndex = -1;
  for (let i = 0; i < matrix.length; i += 1) {
    const filled = (matrix[i] ?? []).filter((cell) => cellText(cell) !== '').length;
    if (filled >= 2 || (matrix[0].length === 1 && filled === 1)) {
      headerIndex = i;
      break;
    }
  }
  if (headerIndex < 0) throw badRequest('Não foi possível identificar o cabeçalho da planilha.');

  const rawHeaders = matrix[headerIndex] ?? [];
  const width = Math.max(
    rawHeaders.length,
    ...matrix.slice(headerIndex + 1).map((row) => (Array.isArray(row) ? row.length : 0)),
  );

  const seen = new Map<string, number>();
  const headers: string[] = [];
  for (let i = 0; i < width; i += 1) {
    let base = cellText(rawHeaders[i]);
    if (!base) {
      const letter = XLSX.utils.encode_col(i);
      base = `Coluna ${letter}`;
    }
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    headers.push(count === 0 ? base : `${base} (${count + 1})`);
  }

  const rows: SheetRow[] = [];
  for (let i = headerIndex + 1; i < matrix.length; i += 1) {
    const cells = matrix[i] ?? [];
    if (!cells.some((cell) => cellText(cell) !== '')) continue;
    rows.push({
      rowNumber: i + 1,
      cells,
      meta: cells.map((_, columnIndex) => metaAt(i, columnIndex)),
    });
  }

  if (rows.length === 0) throw badRequest('A planilha não possui linhas de dados.');
  if (rows.length > MAX_ROWS) {
    throw badRequest(`O arquivo possui mais de ${MAX_ROWS} linhas. Divida a importação em partes.`);
  }

  return {
    filename,
    sheetName,
    headers,
    rows,
    mapping: suggestMapping(headers),
  };
}

function effectiveMapping(source: ColumnMapping, suggestions: ColumnMapping): ColumnMapping {
  const result: ColumnMapping = { ...suggestions };
  for (const field of IMPORT_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(source, field)) {
      const value = source[field];
      result[field] = value === null || value === undefined || value === -1 ? null : Number(value);
    }
  }
  return result;
}

function mappingProblems(mapping: ColumnMapping, headers: string[]): string[] {
  const errors: string[] = [];
  for (const field of REQUIRED_FIELDS) {
    const index = mapping[field];
    if (index === null || index === undefined || index < 0 || index >= headers.length) {
      errors.push(`Mapeie a coluna obrigatória "${FIELD_LABELS[field]}".`);
    }
  }
  return errors;
}

function rawValue(row: SheetRow, mapping: ColumnMapping, field: ImportField): unknown {
  const index = mapping[field];
  if (index === null || index === undefined || index < 0) return null;
  return row.cells[index] ?? null;
}

function rawMap(row: SheetRow, mapping: ColumnMapping): Record<ImportField, string> {
  const result = {} as Record<ImportField, string>;
  for (const field of IMPORT_FIELDS) {
    result[field] = cellText(rawValue(row, mapping, field));
  }
  return result;
}

export function parseRowFields(
  fields: {
    purchaseDate: unknown;
    dueDate: unknown;
    description: unknown;
    amount: unknown;
    paymentMethod: unknown;
    installments: unknown;
    category: unknown;
    transfer: unknown;
  },
  options: { installmentsMeta?: CellMeta | null } = {},
): {
  values: ParsedImportValues;
  errors: string[];
  issues: FieldIssue[];
  suggestions: RowSuggestion[];
  installmentNote: string | null;
} {
  const issues: FieldIssue[] = [];
  const errors: string[] = [];
  const push = (field: ImportField, message: string) => {
    issues.push({ field, message });
    errors.push(`${FIELD_LABELS[field]}: ${message}`);
  };

  const purchaseEmpty =
    fields.purchaseDate === null ||
    fields.purchaseDate === undefined ||
    String(fields.purchaseDate).trim() === '';
  const dueEmpty =
    fields.dueDate === null ||
    fields.dueDate === undefined ||
    String(fields.dueDate).trim() === '';

  const purchase = parseDateValue(fields.purchaseDate);
  const due = parseDateValue(fields.dueDate);

  // Data de compra: quando o arquivo não traz valor (coluna ausente ou célula
  // vazia), aplica-se o fallback já usado pela aplicação (vencimento), com
  // origem identificável. Valor presente, porém inválido, continua sendo erro.
  // O fallback só ocorre quando o vencimento veio do arquivo (due.ok).
  let purchaseDate: string | null = null;
  let purchaseDateSource: PurchaseDateSource | null = null;
  if (purchase.ok) {
    purchaseDate = purchase.value;
    purchaseDateSource = 'file';
  } else if (!purchaseEmpty && purchase.error !== 'Data não informada.') {
    push('purchaseDate', purchase.error);
  } else if (due.ok) {
    purchaseDate = due.value;
    purchaseDateSource = 'due_date_fallback';
  }

  const description = displayName(String(fields.description ?? ''));
  if (!description) push('description', 'descrição obrigatória.');
  if (description.length > 500) push('description', 'descrição muito longa (máximo 500).');

  const amount = parseAmountToCents(fields.amount);
  if (!amount.ok) push('amount', amount.error);

  const installments = parseInstallments(fields.installments, {
    meta: options.installmentsMeta ?? null,
    description,
  });
  if (installments.error) push('installments', installments.error);

  const cashPurchase = installments.cashPurchase || isCashPurchaseText(fields.description);
  if (cashPurchase) {
    installments.value = { number: null, total: null };
    installments.source = null;
  }

  // Precedência do vencimento:
  // 1. vencimento informado no arquivo;
  // 2. derivado da data de compra + parcela (ou da própria compra, à vista);
  // 3. caso contrário, ausente (erro).
  let dueDate: string | null = null;
  let dueDateSource: DueDateSource | null = null;

  if (due.ok) {
    dueDate = due.value;
    dueDateSource = 'file';
  } else if (!dueEmpty && due.error !== 'Data não informada.') {
    push('dueDate', due.error);
  } else if (purchase.ok) {
    const installmentNumber = installments.value.number;
    if (cashPurchase) {
      dueDate = purchase.value;
      dueDateSource = 'derived_from_cash_purchase';
    } else {
      const derived = deriveDueDateFromPurchase(purchase.value, installmentNumber);
      dueDate = derived ?? purchase.value;
      dueDateSource = 'estimated_from_installment';
    }
  } else if (dueEmpty && purchaseEmpty) {
    push('dueDate', 'Data de vencimento não informada.');
  }

  // Se vencimento inválido (não vazio) já reportado; se ausente e sem compra, reportado acima.

  const paymentMethodRaw = displayName(String(fields.paymentMethod ?? ''));
  const paymentMethod = paymentMethodRaw ? paymentMethodRaw : null;
  const category = displayName(String(fields.category ?? '')) || EMPTY_CATEGORY_NAME;

  // estimatedFirstInstallmentDate
  let estimatedFirstInstallmentDate: string | null = null;
  if (!cashPurchase) {
    if (dueDateSource === 'file' && due.ok) {
      estimatedFirstInstallmentDate = estimateFirstInstallmentDate(
        due.value,
        installments.value.number,
        installments.value.total,
      );
    } else if (
      (dueDateSource === 'estimated_from_installment' ||
        dueDateSource === 'derived_from_cash_purchase') &&
      purchaseDate
    ) {
      estimatedFirstInstallmentDate = purchaseDate;
    }
  }

  return {
    values: {
      purchaseDate,
      purchaseDateSource,
      dueDate,
      dueDateSource,
      description,
      amountCents: amount.ok ? amount.value : null,
      paymentMethod,
      category,
      installmentNumber: installments.value.number,
      installmentTotal: installments.value.total,
      installmentSource: installments.source,
      installmentOriginal:
        installments.source === 'description' ? (installments.original ?? null) : null,
      estimatedFirstInstallmentDate,
      cashPurchase,
      transfer: normalizeTransfer(fields.transfer),
    },
    errors,
    issues,
    suggestions: installments.suggestions.map((suggestion) => ({
      field: 'installments' as const,
      ...suggestion,
    })),
    installmentNote: installments.note ?? null,
  };
}

export function transactionFingerprint(input: {
  purchaseDate: string;
  dueDate: string;
  description: string;
  amountCents: number;
  paymentMethod: string;
  category: string;
  installmentNumber: number | null;
  installmentTotal: number | null;
  transfer: string | null;
}): string {
  return [
    input.purchaseDate,
    input.dueDate,
    normalizeName(input.description),
    input.amountCents,
    normalizeName(input.paymentMethod),
    normalizeName(input.category),
    input.installmentNumber ?? '',
    input.installmentTotal ?? '',
    normalizeName(input.transfer ?? ''),
  ].join('|');
}

/** Chave mais branda: mesma data, valor e conta, mesmo com descrição diferente. */
export function probableDuplicateKey(input: {
  purchaseDate: string;
  dueDate: string;
  amountCents: number;
  paymentMethod: string;
}): string {
  return [
    input.purchaseDate,
    input.dueDate,
    input.amountCents,
    normalizeName(input.paymentMethod),
  ].join('|');
}

function loadDatabaseComparisons(db: AppDatabase): {
  exact: Map<string, DuplicateCounterpart>;
  probable: Map<string, DuplicateCounterpart>;
} {
  const rows = db
    .select({
      transactionId: transactions.id,
      purchaseDate: transactions.purchaseDate,
      dueDate: transactions.dueDate,
      description: transactions.description,
      amountCents: transactions.amountCents,
      installmentNumber: transactions.installmentNumber,
      installmentTotal: transactions.installmentTotal,
      transfer: transactions.transfer,
      categoryName: categories.name,
      paymentMethodName: paymentMethods.name,
      importBatchId: transactions.importBatchId,
      importedAt: importBatches.importedAt,
    })
    .from(transactions)
    .innerJoin(categories, eq(transactions.categoryId, categories.id))
    .innerJoin(paymentMethods, eq(transactions.paymentMethodId, paymentMethods.id))
    .leftJoin(importBatches, eq(transactions.importBatchId, importBatches.id))
    .orderBy(desc(transactions.id))
    .all();

  const exact = new Map<string, DuplicateCounterpart>();
  const probable = new Map<string, DuplicateCounterpart>();

  for (const row of rows) {
    const counterpart: DuplicateCounterpart = {
      source: 'database',
      rowNumber: null,
      transactionId: row.transactionId,
      purchaseDate: row.purchaseDate,
      dueDate: row.dueDate,
      description: row.description,
      amountCents: row.amountCents,
      paymentMethod: row.paymentMethodName,
      category: row.categoryName,
      installmentNumber: row.installmentNumber,
      installmentTotal: row.installmentTotal,
      importBatchId: row.importBatchId,
      importedAt: row.importedAt ?? null,
    };
    const fingerprint = transactionFingerprint({
      ...row,
      category: row.categoryName,
      paymentMethod: row.paymentMethodName,
    });
    if (!exact.has(fingerprint)) exact.set(fingerprint, counterpart);
    const probableKey = probableDuplicateKey({
      purchaseDate: row.purchaseDate,
      dueDate: row.dueDate,
      amountCents: row.amountCents,
      paymentMethod: row.paymentMethodName,
    });
    if (!probable.has(probableKey)) probable.set(probableKey, counterpart);
  }

  return { exact, probable };
}

function fileComparable(
  rowNumber: number,
  values: ParsedImportValues,
): DuplicateCounterpart {
  return {
    source: 'file',
    rowNumber,
    transactionId: null,
    purchaseDate: values.purchaseDate as string,
    dueDate: values.dueDate as string,
    description: values.description,
    amountCents: values.amountCents as number,
    paymentMethod: values.paymentMethod ?? '',
    category: values.category,
    installmentNumber: values.installmentNumber,
    installmentTotal: values.installmentTotal,
    importBatchId: null,
    importedAt: null,
  };
}

function buildFileParties(
  rows: { rowNumber: number; values: ParsedImportValues }[],
  classifications: Map<string, string | null>,
) {
  return rows
    .map((row) =>
      fileParty(row.rowNumber, {
        purchaseDate: row.values.purchaseDate,
        dueDate: row.values.dueDate,
        description: row.values.description,
        amountCents: row.values.amountCents,
        paymentMethod: row.values.paymentMethod ?? '',
        transfer: row.values.transfer,
        category: row.values.category,
        classification: classifications.get(normalizeName(row.values.category)) ?? null,
      }),
    )
    .filter((party): party is NonNullable<typeof party> => party !== null);
}

function loadCategoryClassifications(db: AppDatabase): Map<string, string | null> {
  const rows = db
    .select({
      normalizedName: categories.normalizedName,
      classification: categories.classification,
    })
    .from(categories)
    .all();
  return new Map(rows.map((row) => [row.normalizedName, row.classification ?? null]));
}

function detectCandidates(
  db: AppDatabase,
  fileRows: { rowNumber: number; values: ParsedImportValues }[],
  toleranceDays: number,
): TransferCandidate[] {
  const classifications = loadCategoryClassifications(db);
  const fileParties = buildFileParties(fileRows, classifications);
  if (fileParties.length === 0) return [];
  const databaseParties = loadUnlinkedDatabaseParties(db);
  return detectTransferCandidates([...fileParties, ...databaseParties], { toleranceDays });
}

export function previewImport(
  db: AppDatabase,
  buffer: Buffer,
  filename: string,
  requestedMapping?: ColumnMapping,
  overrides?: ImportOverrides,
  toleranceDays: number = DEFAULT_TRANSFER_TOLERANCE_DAYS,
  templateId?: number,
): ImportPreview {
  const workbook = readWorkbook(buffer, filename);
  const requested = requestedMapping ?? {};
  let mapping: ColumnMapping;
  let headerWarnings: MappingWarning[] = [];
  let appliedTemplate: { id: number; name: string } | null = null;
  if (Object.keys(requested).length > 0) {
    // Mapeamento explícito do usuário tem prioridade sobre modelos.
    mapping = effectiveMapping(requested, workbook.mapping);
  } else {
    const applied = applyTemplateMapping(db, workbook.headers, templateId);
    mapping = applied.mapping;
    headerWarnings = applied.warnings;
    appliedTemplate = applied.appliedTemplate;
  }
  const errors = mappingProblems(mapping, workbook.headers);
  const comparisons = loadDatabaseComparisons(db);
  const fileExact = new Map<string, DuplicateCounterpart>();
  const fileProbable = new Map<string, DuplicateCounterpart>();

  const duplicateInfo = (
    kind: 'exact' | 'probable',
    counterpart: DuplicateCounterpart,
    reason: string,
  ): DuplicateInfo => ({
    kind,
    source: counterpart.source,
    groupKey:
      counterpart.source === 'database'
        ? `${kind === 'exact' ? 'db' : 'dbp'}:${counterpart.transactionId}`
        : `${kind === 'exact' ? 'file' : 'filep'}:${counterpart.rowNumber}`,
    counterpartRowNumber: counterpart.rowNumber,
    counterpartTransactionId: counterpart.transactionId,
    counterpart,
    reason,
  });

  const rows: PreviewRow[] = workbook.rows.map((row) => {
    const raw = rawMap(row, mapping);
    const override = overrides?.[String(row.rowNumber)] ?? {};
    const merged = { ...raw, ...override };
    const installmentsIndex = mapping.installments;
    const installmentsMeta =
      Object.prototype.hasOwnProperty.call(override, 'installments') ||
      installmentsIndex === null ||
      installmentsIndex === undefined
        ? null
        : (row.meta[installmentsIndex] ?? null);
    const parsed = parseRowFields(merged, { installmentsMeta });

    const categorySuggestion = suggestCategory(
      db,
      parsed.values.category,
      parsed.values.description,
      parsed.values.amountCents ?? 0,
    );

    let duplicate: DuplicateInfo | null = null;
    if (parsed.errors.length === 0) {
      const values = parsed.values;
      const fingerprint = transactionFingerprint({
        purchaseDate: values.purchaseDate as string,
        dueDate: values.dueDate as string,
        description: values.description,
        amountCents: values.amountCents as number,
        paymentMethod: values.paymentMethod ?? '',
        category: values.category,
        installmentNumber: values.installmentNumber,
        installmentTotal: values.installmentTotal,
        transfer: values.transfer,
      });
      const probableKey = probableDuplicateKey({
        purchaseDate: values.purchaseDate as string,
        dueDate: values.dueDate as string,
        amountCents: values.amountCents as number,
        paymentMethod: values.paymentMethod ?? '',
      });

      const exactDatabase = comparisons.exact.get(fingerprint);
      const exactFile = fileExact.get(fingerprint);
      const probableDatabase = comparisons.probable.get(probableKey);
      const probableFile = fileProbable.get(probableKey);

      if (exactDatabase) {
        duplicate = duplicateInfo(
          'exact',
          exactDatabase,
          'Já existe um lançamento com os mesmos dados no banco.',
        );
      } else if (exactFile) {
        duplicate = duplicateInfo(
          'exact',
          exactFile,
          'Linha idêntica já encontrada neste mesmo arquivo.',
        );
      } else if (probableDatabase) {
        duplicate = duplicateInfo(
          'probable',
          probableDatabase,
          'Mesma data, valor e conta de um lançamento já existente; descrição/categoria podem diferir.',
        );
      } else if (probableFile) {
        duplicate = duplicateInfo(
          'probable',
          probableFile,
          'Mesma data, valor e conta de outra linha deste arquivo; descrição/categoria podem diferir.',
        );
      }

      if (!fileExact.has(fingerprint)) {
        fileExact.set(fingerprint, fileComparable(row.rowNumber, values));
      }
      if (!fileProbable.has(probableKey)) {
        fileProbable.set(probableKey, fileComparable(row.rowNumber, values));
      }
    }

    return {
      rowNumber: row.rowNumber,
      raw,
      values: parsed.values,
      errors: parsed.errors,
      issues: parsed.issues,
      suggestions: parsed.suggestions,
      installmentNote: parsed.installmentNote,
      duplicate,
      categorySuggestion,
    };
  });

  const categorySuggestionGroupsMap = new Map<
    string,
    {
      sourceCategory: string;
      sourceNormalized: string;
      count: number;
      targetCategoryId: number | null;
      targetCategoryName: string | null;
      confidence: 'high' | 'medium' | 'low';
      reason: string;
      method: string;
      ambiguous: boolean;
      alternatives: CategorySuggestionAlternative[];
    }
  >();
  for (const row of rows) {
    const suggestion = row.categorySuggestion;
    const key = suggestion.sourceNormalized;
    if (!categorySuggestionGroupsMap.has(key)) {
      categorySuggestionGroupsMap.set(key, {
        sourceCategory: suggestion.sourceCategory,
        sourceNormalized: suggestion.sourceNormalized,
        count: 0,
        targetCategoryId: suggestion.targetCategoryId,
        targetCategoryName: suggestion.targetCategoryName,
        confidence: suggestion.confidence,
        reason: suggestion.reason,
        method: suggestion.method,
        ambiguous: suggestion.ambiguous,
        alternatives: suggestion.alternatives,
      });
    }
    const group = categorySuggestionGroupsMap.get(key)!;
    group.count += 1;
  }
  const categorySuggestions = [...categorySuggestionGroupsMap.values()];

  return {
    filename,
    sheetName: workbook.sheetName,
    headers: workbook.headers,
    mapping,
    mappingErrors: errors,
    mappingWarnings: headerWarnings,
    appliedTemplate,
    totalRows: rows.length,
    validRows: rows.filter((row) => row.errors.length === 0).length,
    invalidRows: rows.filter((row) => row.errors.length > 0).length,
    duplicateRows: rows.filter((row) => row.duplicate !== null).length,
    rows,
    transferToleranceDays: toleranceDays,
    categorySuggestions,
    transferCandidates: detectCandidates(
      db,
      rows
        .filter((row) => row.errors.length === 0)
        .map((row) => ({ rowNumber: row.rowNumber, values: row.values })),
      toleranceDays,
    ),
  };
}

export function importWorkbook(
  db: AppDatabase,
  buffer: Buffer,
  filename: string,
  options: ImportOptions,
): ImportSummary {
  const workbook = readWorkbook(buffer, filename);
  const requested = options.mapping ?? {};
  let mapping: ColumnMapping;
  let batchTemplateId: number | null = null;
  if (Object.keys(requested).length > 0) {
    mapping = effectiveMapping(requested, workbook.mapping);
    if (options.templateId !== undefined) {
      batchTemplateId = findTemplateById(db, options.templateId).id;
    }
  } else {
    const applied = applyTemplateMapping(db, workbook.headers, options.templateId);
    mapping = applied.mapping;
    batchTemplateId = applied.appliedTemplate?.id ?? null;
  }
  const problems = mappingProblems(mapping, workbook.headers);
  if (problems.length > 0) {
    throw badRequest('Mapeamento de colunas incompleto.', problems.map((message) => ({ message })));
  }

  const databaseComparisons = loadDatabaseComparisons(db);
  const fileFingerprints = new Set<string>();
  const rejected = new Set((options.rejectedRows ?? []).map(Number));
  const parsedRows = workbook.rows.map((row) => {
    const raw = rawMap(row, mapping);
    const override = options.overrides?.[String(row.rowNumber)] ?? {};
    const installmentsIndex = mapping.installments;
    const installmentsMeta =
      Object.prototype.hasOwnProperty.call(override, 'installments') ||
      installmentsIndex === null ||
      installmentsIndex === undefined
        ? null
        : (row.meta[installmentsIndex] ?? null);
    const parsed = parseRowFields({ ...raw, ...override }, { installmentsMeta });
    return { rowNumber: row.rowNumber, parsed };
  });

  const accepted: typeof parsedRows = [];
  const errors: { rowNumber: number; errors: string[] }[] = [];
  let skippedDuplicates = 0;
  let duplicateRows = 0;
  let invalidRows = 0;
  let explicitRejections = 0;

  for (const row of parsedRows) {
    if (rejected.has(row.rowNumber)) {
      explicitRejections += 1;
      continue;
    }
    if (row.parsed.errors.length > 0) {
      invalidRows += 1;
      errors.push({ rowNumber: row.rowNumber, errors: row.parsed.errors });
      continue;
    }

    const values = row.parsed.values;
    const fingerprint = transactionFingerprint({
      purchaseDate: values.purchaseDate as string,
      dueDate: values.dueDate as string,
      description: values.description,
      amountCents: values.amountCents as number,
      paymentMethod: values.paymentMethod ?? '',
      category: values.category,
      installmentNumber: values.installmentNumber,
      installmentTotal: values.installmentTotal,
      transfer: values.transfer,
    });
    const isDuplicate =
      databaseComparisons.exact.has(fingerprint) || fileFingerprints.has(fingerprint);
    fileFingerprints.add(fingerprint);
    if (isDuplicate) duplicateRows += 1;

    if (isDuplicate && options.skipDuplicates) {
      skippedDuplicates += 1;
      continue;
    }
    accepted.push(row);
  }

  const createdCategories = new Set<string>();
  const createdPaymentMethods = new Set<string>();
  const dates: string[] = [];

  const decisionsMap = new Map<string, CategoryDecision>();
  if (Array.isArray(options.categoryDecisions)) {
    for (const decision of options.categoryDecisions) {
      const key = normalizeName(decision.sourceCategory ?? '');
      if (key) decisionsMap.set(key, decision);
    }
  } else if (options.categoryDecisions) {
    for (const [key, decision] of Object.entries(options.categoryDecisions)) {
      decisionsMap.set(normalizeName(decision.sourceCategory ?? key), decision);
    }
  }

  const toleranceDays = options.transferToleranceDays ?? DEFAULT_TRANSFER_TOLERANCE_DAYS;
  const acceptedRowNumbers = new Set(accepted.map((row) => row.rowNumber));
  const candidates = detectCandidates(
    db,
    accepted.map((row) => ({ rowNumber: row.rowNumber, values: row.parsed.values })),
    toleranceDays,
  ).filter((candidate) => {
    const isAccepted = (party: TransferCandidate['outgoing']) =>
      party.source !== 'file' ||
      (party.rowNumber !== null && acceptedRowNumbers.has(party.rowNumber));
    return isAccepted(candidate.outgoing) && isAccepted(candidate.incoming);
  });
  const decisions = options.transferDecisions ?? {};
  const confirmedCandidates: TransferCandidate[] = [];
  const usedParty = new Set<string>();
  let rejectedTransfers = 0;
  let pendingTransfers = 0;

  for (const candidate of candidates) {
    const explicit = decisions[candidate.key];
    const decision: TransferDecision =
      explicit ?? (candidate.confidence === 'high' && !candidate.ambiguous ? 'confirm' : 'pending');
    if (decision === 'reject') {
      rejectedTransfers += 1;
      continue;
    }
    if (decision === 'pending') {
      pendingTransfers += 1;
      continue;
    }
    if (usedParty.has(candidate.outgoing.key) || usedParty.has(candidate.incoming.key)) {
      rejectedTransfers += 1;
      continue;
    }
    usedParty.add(candidate.outgoing.key);
    usedParty.add(candidate.incoming.key);
    confirmedCandidates.push(candidate);
  }

  let confirmedTransfers = 0;

  const batchId = db.transaction((tx) => {
    const batch = tx
      .insert(importBatches)
      .values({
        filename,
        importedAt: nowIso(),
        totalRows: parsedRows.length,
        importedRows: accepted.length,
        rejectedRows: parsedRows.length - accepted.length,
        mappingTemplateId: batchTemplateId,
      })
      .returning()
      .get();

    const insertedIds = new Map<number, number>();

    for (const row of accepted) {
      const values = row.parsed.values;

      // Categoria: aplica decisão do usuário, se houver.
      const sourceCategory = values.category;
      const decision = decisionsMap.get(normalizeName(sourceCategory));
      let categoryId: number;
      let createdCategoryName: string | null = null;

      if (!decision || decision.action === 'reject') {
        const categoryBefore = tx
          .select()
          .from(categories)
          .where(eq(categories.normalizedName, normalizeName(sourceCategory)))
          .get();
        const category = ensureLookup(tx, 'category', sourceCategory);
        if (!categoryBefore) createdCategories.add(category.name);
        categoryId = category.id;
      } else if (decision.action === 'create') {
        const newName = decision.newCategoryName?.trim() || sourceCategory;
        const categoryBefore = tx
          .select()
          .from(categories)
          .where(eq(categories.normalizedName, normalizeName(newName)))
          .get();
        const category = ensureLookup(tx, 'category', newName);
        if (!categoryBefore) createdCategories.add(category.name);
        categoryId = category.id;
      } else {
        // accept / use
        const targetId = decision.targetCategoryId;
        if (targetId) {
          const target = tx.select().from(categories).where(eq(categories.id, targetId)).get();
          if (!target) throw badRequest('Categoria de destino não encontrada.');
          categoryId = target.id;
          if (normalizeName(sourceCategory) !== target.normalizedName) {
            persistCategoryAlias(tx as unknown as AppDatabase, sourceCategory, target.id);
          }
        } else {
          const categoryBefore = tx
            .select()
            .from(categories)
            .where(eq(categories.normalizedName, normalizeName(sourceCategory)))
            .get();
          const category = ensureLookup(tx, 'category', sourceCategory);
          if (!categoryBefore) createdCategories.add(category.name);
          categoryId = category.id;
        }
      }

      // Forma de pagamento: usa destino quando ausente no arquivo.
      let paymentMethodId: number;
      if (values.paymentMethod === null) {
        if (!options.destinationPaymentMethodId) {
          throw badRequest('Informe a conta/forma de pagamento de destino para linhas sem pagamento.');
        }
        const destination = tx
          .select()
          .from(paymentMethods)
          .where(eq(paymentMethods.id, options.destinationPaymentMethodId))
          .get();
        if (!destination) throw badRequest('Forma de pagamento de destino não encontrada.');
        paymentMethodId = destination.id;
      } else {
        const paymentBefore = tx
          .select()
          .from(paymentMethods)
          .where(eq(paymentMethods.normalizedName, normalizeName(values.paymentMethod)))
          .get();
        const payment = ensureLookup(tx, 'payment', values.paymentMethod);
        if (!paymentBefore) createdPaymentMethods.add(payment.name);
        paymentMethodId = payment.id;
      }

      const inserted = tx
        .insert(transactions)
        .values({
          purchaseDate: values.purchaseDate as string,
          purchaseDateSource: values.purchaseDateSource,
          dueDate: values.dueDate as string,
          dueDateSource: values.dueDateSource,
          description: values.description,
          amountCents: values.amountCents as number,
          paymentMethodId,
          categoryId,
          installmentNumber: values.installmentNumber,
          installmentTotal: values.installmentTotal,
          installmentSource: values.installmentSource,
          installmentOriginal: values.installmentOriginal,
          transfer: values.transfer,
          importBatchId: batch.id,
          createdAt: nowIso(),
          updatedAt: nowIso(),
        })
        .returning({ id: transactions.id })
        .get();
      insertedIds.set(row.rowNumber, inserted.id);

      dates.push(values.dueDate as string);
    }

    const resolveId = (party: TransferCandidate['outgoing']): number | undefined =>
      party.transactionId ?? (party.rowNumber !== null ? insertedIds.get(party.rowNumber) : undefined);

    for (const candidate of confirmedCandidates) {
      const outgoingId = resolveId(candidate.outgoing);
      const incomingId = resolveId(candidate.incoming);
      if (!outgoingId || !incomingId) continue;
      try {
        insertTransferRecord(tx, {
          outgoingTransactionId: outgoingId,
          incomingTransactionId: incomingId,
          confidence: candidate.confidence === 'high' ? 'high' : 'probable',
          origin: 'import',
        });
        confirmedTransfers += 1;
      } catch {
        rejectedTransfers += 1;
      }
    }

    return batch.id;
  });

  dates.sort();

  return {
    batchId,
    filename,
    totalRows: parsedRows.length,
    importedRows: accepted.length,
    rejectedRows: parsedRows.length - accepted.length,
    duplicateRows,
    skippedDuplicates,
    invalidRows,
    explicitRejections,
    createdCategories: [...createdCategories],
    createdPaymentMethods: [...createdPaymentMethods],
    duplicateRowsInPreview: duplicateRows,
    transferCandidates: candidates.length,
    confirmedTransfers,
    pendingTransfers,
    rejectedTransfers,
    ignoredRows: parsedRows.length - accepted.length,
    firstDueDate: dates[0] ?? null,
    lastDueDate: dates[dates.length - 1] ?? null,
    errors,
  };
}

export function listImportBatches(db: AppDatabase, limit = 50) {
  return db
    .select({ batch: importBatches, templateName: importMappingTemplates.name })
    .from(importBatches)
    .leftJoin(importMappingTemplates, eq(importBatches.mappingTemplateId, importMappingTemplates.id))
    .orderBy(desc(importBatches.importedAt))
    .limit(limit)
    .all()
    .map((row) => ({ ...row.batch, templateName: row.templateName ?? null }));
}

/**
 * Associação campo ↔ cabeçalho do arquivo salva por NOME (não por posição),
 * para que o modelo continue válido mesmo quando as colunas mudam de ordem.
 */
export interface ImportMappingTemplate {
  id: number;
  name: string;
  headers: string[];
  mapping: Partial<Record<ImportField, string | null>>;
  createdAt: string;
  updatedAt: string;
}

interface TemplateRow {
  id: number;
  name: string;
  headers: string;
  mapping: string;
  createdAt: string;
  updatedAt: string;
}

function toTemplateDto(row: TemplateRow): ImportMappingTemplate {
  let headers: string[] = [];
  let mapping: Partial<Record<ImportField, string | null>> = {};
  try {
    const parsedHeaders = JSON.parse(row.headers);
    const parsedMapping = JSON.parse(row.mapping);
    if (Array.isArray(parsedHeaders)) {
      headers = parsedHeaders.filter((value) => typeof value === 'string');
    }
    if (parsedMapping && typeof parsedMapping === 'object' && !Array.isArray(parsedMapping)) {
      for (const field of IMPORT_FIELDS) {
        const value = (parsedMapping as Record<string, unknown>)[field];
        if (typeof value === 'string' || value === null) {
          mapping[field] = typeof value === 'string' ? value : null;
        }
      }
    }
  } catch {
    // Modelo corrompido: devolve estrutura vazia em vez de quebrar a listagem.
  }
  return {
    id: row.id,
    name: row.name,
    headers,
    mapping,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function listMappingTemplates(db: AppDatabase): ImportMappingTemplate[] {
  return db
    .select()
    .from(importMappingTemplates)
    .orderBy(desc(importMappingTemplates.updatedAt))
    .all()
    .map(toTemplateDto);
}

function normalizeHeaderNames(headers: string[], mapping: ColumnMapping): Record<string, string | null> {
  const stored: Record<string, string | null> = {};
  for (const field of IMPORT_FIELDS) {
    const value = mapping[field];
    if (value === null || value === undefined) {
      stored[field] = null;
      continue;
    }
    const index = Number(value);
    const header = Number.isInteger(index) ? headers[index] : undefined;
    if (!header) {
      throw badRequest(`Modelo inválido: campo "${FIELD_LABELS[field]}" aponta para coluna inexistente.`);
    }
    stored[field] = header;
  }
  return stored;
}

/** Cria ou atualiza (por nome) um modelo de mapeamento. */
export function saveMappingTemplate(
  db: AppDatabase,
  input: { name: string; headers: string[]; mapping: ColumnMapping },
): ImportMappingTemplate {
  const name = displayName(input.name ?? '');
  if (!name || name.length > 80) {
    throw badRequest('Informe um nome para o modelo (até 80 caracteres).');
  }
  if (!Array.isArray(input.headers) || input.headers.length === 0) {
    throw badRequest('O modelo precisa dos cabeçalhos do arquivo.');
  }
  const headers = input.headers.map((header) => String(header));
  const stored = normalizeHeaderNames(headers, input.mapping ?? {});

  const now = nowIso();
  const existing = db
    .select()
    .from(importMappingTemplates)
    .all()
    .find((row) => normalizeName(row.name) === normalizeName(name));
  if (existing) {
    const updated = db
      .update(importMappingTemplates)
      .set({
        name,
        headers: JSON.stringify(headers),
        mapping: JSON.stringify(stored),
        updatedAt: now,
      })
      .where(eq(importMappingTemplates.id, existing.id))
      .returning()
      .get();
    return toTemplateDto(updated);
  }
  const created = db
    .insert(importMappingTemplates)
    .values({
      name,
      headers: JSON.stringify(headers),
      mapping: JSON.stringify(stored),
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
  return toTemplateDto(created);
}

export function deleteMappingTemplate(db: AppDatabase, id: number): { removed: true } {
  const removed = db
    .delete(importMappingTemplates)
    .where(eq(importMappingTemplates.id, id))
    .returning({ id: importMappingTemplates.id })
    .get();
  if (!removed) throw badRequest('Modelo de mapeamento não encontrado.');
  return { removed: true };
}

function findTemplateById(db: AppDatabase, id: number): ImportMappingTemplate {
  const row = db
    .select()
    .from(importMappingTemplates)
    .where(eq(importMappingTemplates.id, id))
    .get();
  if (!row) throw badRequest('Modelo de mapeamento não encontrado.');
  return toTemplateDto(row);
}

/** Reconstrói o mapeamento por índice a partir do modelo salvo por cabeçalho. */
function resolveTemplateMapping(
  headers: string[],
  templateMapping: Partial<Record<ImportField, string | null>>,
): { mapping: ColumnMapping; missing: ImportField[] } {
  const keys = headers.map(headerKey);
  const mapping: ColumnMapping = {};
  const missing: ImportField[] = [];
  for (const field of IMPORT_FIELDS) {
    const headerName = templateMapping[field];
    if (!headerName) {
      // Campo deliberadamente não mapeado no modelo.
      mapping[field] = null;
      continue;
    }
    const index = keys.findIndex((key) => key === headerKey(headerName));
    if (index >= 0) {
      mapping[field] = index;
    } else {
      mapping[field] = null;
      missing.push(field);
    }
  }
  return { mapping, missing };
}

/** Localiza um modelo cujo conjunto de cabeçalhos coincide com o arquivo. */
function autoMatchMappingTemplate(
  db: AppDatabase,
  headers: string[],
): ImportMappingTemplate | null {
  const signature = headers.map(headerKey).sort().join('|');
  const candidates = listMappingTemplates(db);
  for (const template of candidates) {
    const templateSignature = template.headers.map(headerKey).sort().join('|');
    if (templateSignature === signature) return template;
  }
  return null;
}

/**
 * Aplica um modelo (explícito ou detectado pelo formato do arquivo) sobre a
 * sugestão automática. Campos do modelo ausentes no arquivo recorrem à própria
 * sugestão, nunca à posição das colunas.
 */
function applyTemplateMapping(
  db: AppDatabase,
  headers: string[],
  templateId: number | undefined,
): { mapping: ColumnMapping; warnings: MappingWarning[]; appliedTemplate: { id: number; name: string } | null } {
  const suggestion = suggestMappingDetailed(headers);

  let template: ImportMappingTemplate | null = null;
  if (templateId !== undefined) {
    template = findTemplateById(db, templateId);
  } else {
    template = autoMatchMappingTemplate(db, headers);
  }
  if (!template) {
    return { mapping: suggestion.mapping, warnings: suggestion.warnings, appliedTemplate: null };
  }

  const resolution = resolveTemplateMapping(headers, template.mapping);
  const mapping = effectiveMapping(resolution.mapping, suggestion.mapping);
  const warnings: MappingWarning[] = [
    {
      level: 'info',
      field: null,
      message: `Modelo "${template.name}" aplicado automaticamente. Revise o mapeamento antes de importar.`,
    },
    ...suggestion.warnings,
  ];
  if (resolution.missing.length > 0) {
    warnings.push({
      level: 'warning',
      field: null,
      message: `Campos do modelo sem coluna correspondente neste arquivo: ${resolution.missing
        .map((field) => FIELD_LABELS[field])
        .join(', ')}. Confira o mapeamento.`,
    });
  }
  return { mapping, warnings, appliedTemplate: { id: template.id, name: template.name } };
}
