import { eq } from 'drizzle-orm';
import type { AppDatabase } from '../db/client';
import { categories, scheduledBills } from '../db/schema';
import { parseDateValue } from '../lib/dates';
import { badRequest, nowIso } from '../lib/errors';
import { parseAmountToCents } from '../lib/money';
import { displayName, EMPTY_CATEGORY_NAME, normalizeName } from '../lib/normalize';
import { ensureLookup } from './lookups';
import { readWorkbook, type ColumnMapping } from './import';
import { createBill } from './bills';

export type BillImportField = 'description' | 'amount' | 'dueDate' | 'status' | 'category';

export const BILL_IMPORT_FIELDS: BillImportField[] = [
  'description',
  'amount',
  'dueDate',
  'status',
  'category',
];

export const BILL_FIELD_LABELS: Record<BillImportField, string> = {
  description: 'Despesa',
  amount: 'Valor',
  dueDate: 'Vencimento',
  status: 'Situação',
  category: 'Categoria',
};

const BILL_ALIASES: Record<BillImportField, string[]> = {
  description: ['despesa', 'descricao', 'nome', 'estabelecimento', 'compra', 'titulo'],
  amount: ['valor', 'quantia', 'montante', 'valor r'],
  dueDate: ['vencimento', 'data vencimento', 'data de vencimento', 'data', 'data movimento'],
  status: ['situacao', 'status', 'pago', 'estado'],
  category: ['categoria', 'categorias', 'category', 'categories'],
};

const BILL_REQUIRED: BillImportField[] = ['description', 'amount', 'dueDate'];

function headerKey(value: string): string {
  return normalizeName(value).replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function suggestBillMapping(headers: string[]): {
  mapping: Partial<Record<BillImportField, number | null>>;
  warnings: string[];
} {
  const mapping: Partial<Record<BillImportField, number | null>> = {};
  const used = new Set<number>();
  const keys = headers.map(headerKey);
  const warnings: string[] = [];

  for (const field of BILL_IMPORT_FIELDS) {
    let found = -1;
    for (const alias of BILL_ALIASES[field]) {
      const idx = keys.findIndex((key, i) => key === alias && !used.has(i));
      if (idx >= 0) {
        found = idx;
        break;
      }
    }
    if (found < 0) {
      for (const alias of BILL_ALIASES[field]) {
        if (alias.length < 4) continue;
        const idx = keys.findIndex((key, i) => key.includes(alias) && !used.has(i));
        if (idx >= 0) {
          found = idx;
          warnings.push(`A coluna "${headers[idx]}" foi reconhecida por semelhança como ${BILL_FIELD_LABELS[field]}. Confirme o mapeamento.`);
          break;
        }
      }
    }
    if (found >= 0) {
      mapping[field] = found;
      used.add(found);
    } else {
      mapping[field] = null;
    }
  }

  // coluna genérica 'data' → vencimento
  const generic = keys.findIndex((key, i) => key === 'data' && !used.has(i));
  if (generic >= 0 && mapping.dueDate === null) {
    mapping.dueDate = generic;
    used.add(generic);
    warnings.push(`A coluna "${headers[generic]}" foi interpretada como Vencimento.`);
  }

  const unused = headers.filter((_, i) => !used.has(i));
  if (unused.length > 0) {
    warnings.push(`Colunas sem campo correspondente: ${unused.join(', ')}.`);
  }

  return { mapping, warnings };
}

export interface BillPreviewValues {
  description: string;
  amountCents: number | null;
  dueDate: string | null;
  status: '' | 'AG' | 'PG';
  category: string;
}

export interface BillPreviewRow {
  rowNumber: number;
  raw: Record<string, string>;
  values: BillPreviewValues;
  errors: string[];
}

export interface BillImportPreview {
  filename: string;
  sheetName: string;
  headers: string[];
  mapping: Partial<Record<BillImportField, number | null>>;
  mappingErrors: string[];
  mappingWarnings: string[];
  totalRows: number;
  validRows: number;
  invalidRows: number;
  duplicateRows: number;
  rows: BillPreviewRow[];
}

export interface BillImportOptions {
  mapping: Partial<Record<BillImportField, number | null>>;
  overrides?: Record<string, Partial<Record<BillImportField, string>>>;
  skipDuplicates?: boolean;
  rejectedRows?: number[];
}

export interface BillImportSummary {
  filename: string;
  totalRows: number;
  importedRows: number;
  rejectedRows: number;
  duplicateRows: number;
  skippedDuplicates: number;
  invalidRows: number;
  errors: { rowNumber: number; errors: string[] }[];
}

function rawMap(row: { cells: unknown[] }, mapping: Partial<Record<BillImportField, number | null>>) {
  const result: Record<BillImportField, unknown> = {
    description: null,
    amount: null,
    dueDate: null,
    status: null,
    category: null,
  };
  for (const field of BILL_IMPORT_FIELDS) {
    const idx = mapping[field];
    if (idx === null || idx === undefined) continue;
    const cell = row.cells[idx];
    result[field] = cell;
  }
  return result;
}

function parseStatus(value: unknown): { ok: true; value: '' | 'AG' | 'PG' } | { ok: false; error: string } {
  const raw = String(value ?? '').trim().toUpperCase();
  if (raw === '') return { ok: true, value: '' };
  if (raw === 'AG' || raw === 'A' || raw === 'AGENDADO') return { ok: true, value: 'AG' };
  if (raw === 'PG' || raw === 'P' || raw === 'PAGO') return { ok: true, value: 'PG' };
  return { ok: false, error: 'Situação inválida. Use "", "AG" ou "PG".' };
}

function parseBillRow(fields: {
  description: unknown;
  amount: unknown;
  dueDate: unknown;
  status: unknown;
  category: unknown;
}): { values: BillPreviewValues; errors: string[] } {
  const errors: string[] = [];
  const description = displayName(String(fields.description ?? ''));
  if (!description) errors.push('Despesa: informe a descrição.');

  const amountParsed = parseAmountToCents(fields.amount);
  let amountCents: number | null = null;
  if (!amountParsed.ok) {
    if (String(fields.amount ?? '').trim() !== '') errors.push(`Valor: ${amountParsed.error}`);
    else errors.push('Valor: informe o valor.');
  } else {
    amountCents = Math.abs(amountParsed.value);
    if (amountCents <= 0) errors.push('Valor: deve ser positivo.');
  }

  const due = parseDateValue(fields.dueDate);
  let dueDate: string | null = null;
  if (!due.ok) {
    if (String(fields.dueDate ?? '').trim() !== '') errors.push(`Vencimento: ${due.error}`);
    else errors.push('Vencimento: informe a data.');
  } else {
    dueDate = due.value;
  }

  const statusParsed = parseStatus(fields.status);
  let status: '' | 'AG' | 'PG' = '';
  if (!statusParsed.ok) errors.push(`Situação: ${statusParsed.error}`);
  else status = statusParsed.value;

  const category = displayName(String(fields.category ?? '')) || EMPTY_CATEGORY_NAME;

  return {
    values: { description, amountCents, dueDate, status, category },
    errors,
  };
}

function billFingerprint(values: BillPreviewValues): string {
  return [
    normalizeName(values.description),
    values.amountCents ?? '',
    values.dueDate ?? '',
    normalizeName(values.category),
  ].join('|');
}

export function previewBillsImport(
  db: AppDatabase,
  buffer: Buffer,
  filename: string,
  requestedMapping?: Partial<Record<BillImportField, number | null>>,
  overrides?: Record<string, Partial<Record<BillImportField, string>>>,
): BillImportPreview {
  const workbook = readWorkbook(buffer, filename);
  const suggestion = suggestBillMapping(workbook.headers);
  const mapping = requestedMapping && Object.keys(requestedMapping).length > 0
    ? { ...suggestion.mapping, ...requestedMapping }
    : suggestion.mapping;

  const mappingErrors: string[] = [];
  for (const field of BILL_REQUIRED) {
    if (mapping[field] === null || mapping[field] === undefined) {
      mappingErrors.push(`Mapeie a coluna obrigatória ${BILL_FIELD_LABELS[field]}.`);
    }
  }

  const rows: BillPreviewRow[] = workbook.rows.map((row) => {
    const raw = rawMap(row, mapping);
    const override = overrides?.[String(row.rowNumber)] ?? {};
    const fields = { ...raw, ...override };
    const parsed = parseBillRow({
      description: fields.description,
      amount: fields.amount,
      dueDate: fields.dueDate,
      status: fields.status,
      category: fields.category,
    });
    return {
      rowNumber: row.rowNumber,
      raw: Object.fromEntries(
        BILL_IMPORT_FIELDS.map((field) => [field, String(raw[field] ?? '')]),
      ) as Record<string, string>,
      values: parsed.values,
      errors: parsed.errors,
    };
  });

  const validRows = rows.filter((r) => r.errors.length === 0).length;
  const invalidRows = rows.filter((r) => r.errors.length > 0).length;

  // duplicate detection against DB
  const dbFingerprints = new Set<string>();
  const dbRows = db.select({ bill: scheduledBills, categoryName: categories.name })
    .from(scheduledBills)
    .innerJoin(categories, eq(scheduledBills.categoryId, categories.id))
    .all();
  for (const row of dbRows) {
    dbFingerprints.add(
      [
        normalizeName(row.bill.description),
        row.bill.amountCents,
        row.bill.dueDate,
        normalizeName(row.categoryName),
      ].join('|'),
    );
  }
  const fileFingerprints = new Set<string>();
  let duplicateRows = 0;
  for (const row of rows) {
    if (row.errors.length > 0) continue;
    const fp = billFingerprint(row.values);
    const isDup = dbFingerprints.has(fp) || fileFingerprints.has(fp);
    if (isDup) duplicateRows += 1;
    fileFingerprints.add(fp);
  }

  return {
    filename,
    sheetName: workbook.sheetName,
    headers: workbook.headers,
    mapping,
    mappingErrors,
    mappingWarnings: suggestion.warnings,
    totalRows: rows.length,
    validRows,
    invalidRows,
    duplicateRows,
    rows,
  };
}

export function importBills(
  db: AppDatabase,
  buffer: Buffer,
  filename: string,
  options: BillImportOptions,
): BillImportSummary {
  const preview = previewBillsImport(db, buffer, filename, options.mapping, options.overrides);
  if (preview.mappingErrors.length > 0) {
    throw badRequest('Mapeamento de colunas incompleto.', preview.mappingErrors.map((m) => ({ message: m })));
  }

  const rejected = new Set((options.rejectedRows ?? []).map(Number));
  const accepted: BillPreviewRow[] = [];
  const errors: { rowNumber: number; errors: string[] }[] = [];
  let invalidRows = 0;
  let duplicateRows = 0;
  let skippedDuplicates = 0;

  const dbFingerprints = new Set<string>();
  const dbRows = db.select({ bill: scheduledBills, categoryName: categories.name })
    .from(scheduledBills)
    .innerJoin(categories, eq(scheduledBills.categoryId, categories.id))
    .all();
  for (const row of dbRows) {
    dbFingerprints.add(
      [normalizeName(row.bill.description), row.bill.amountCents, row.bill.dueDate, normalizeName(row.categoryName)].join('|'),
    );
  }
  const fileFingerprints = new Set<string>();

  for (const row of preview.rows) {
    if (rejected.has(row.rowNumber)) continue;
    if (row.errors.length > 0) {
      invalidRows += 1;
      errors.push({ rowNumber: row.rowNumber, errors: row.errors });
      continue;
    }
    const fp = billFingerprint(row.values);
    const isDup = dbFingerprints.has(fp) || fileFingerprints.has(fp);
    if (isDup) duplicateRows += 1;
    fileFingerprints.add(fp);
    if (isDup && options.skipDuplicates) {
      skippedDuplicates += 1;
      continue;
    }
    accepted.push(row);
  }

  for (const row of accepted) {
    const values = row.values;
    const category = ensureLookup(db, 'category', values.category || EMPTY_CATEGORY_NAME);
    createBill(db, {
      description: values.description,
      amountCents: values.amountCents as number,
      dueDate: values.dueDate as string,
      categoryId: category.id,
      status: values.status,
    });
  }

  return {
    filename,
    totalRows: preview.totalRows,
    importedRows: accepted.length,
    rejectedRows: rejected.size,
    duplicateRows,
    skippedDuplicates,
    invalidRows,
    errors,
  };
}
