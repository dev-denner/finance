import { eq } from 'drizzle-orm';
import type { AppDatabase } from '../db/client';
import { categories, scheduledBills } from '../db/schema';
import { parseDateValue } from '../lib/dates';
import { badRequest, nowIso } from '../lib/errors';
import { parseAmountToCents } from '../lib/money';
import { displayName, EMPTY_CATEGORY_NAME, normalizeName } from '../lib/normalize';
import { ensureLookup } from './lookups';
import { readWorkbook, type ColumnMapping } from './import';
import { createBill, createTemplate, describeRecurrence, type BillFrequency } from './bills';

export type BillImportField = 'description' | 'amount' | 'dueDate' | 'status' | 'category' | 'repeat';

export const BILL_IMPORT_FIELDS: BillImportField[] = [
  'description',
  'amount',
  'dueDate',
  'status',
  'category',
  'repeat',
];

export const BILL_FIELD_LABELS: Record<BillImportField, string> = {
  description: 'Despesa',
  amount: 'Valor',
  dueDate: 'Vencimento',
  status: 'Situação',
  category: 'Categoria',
  repeat: 'Repetição',
};

const BILL_ALIASES: Record<BillImportField, string[]> = {
  description: ['despesa', 'descricao', 'nome', 'estabelecimento', 'compra', 'titulo'],
  amount: ['valor', 'quantia', 'montante', 'valor r'],
  dueDate: ['vencimento', 'data vencimento', 'data de vencimento', 'data', 'data movimento'],
  status: ['situacao', 'status', 'pago', 'estado'],
  category: ['categoria', 'categorias', 'category', 'categories'],
  repeat: ['repeticao', 'recorrencia', 'frequencia', 'periodicidade', 'repetir', 'repete'],
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

/** Repetição lida da planilha; a primeira ocorrência é o vencimento da linha. */
export interface BillImportRecurrence {
  frequency: BillFrequency;
  interval: number;
  lastBusinessDay: boolean;
  /** "12x": repete N vezes; nulo = sem término. */
  occurrenceCount: number | null;
  /** "Mensal, dia 10", como na tela de contas. */
  label: string;
}

export interface BillPreviewValues {
  description: string;
  amountCents: number | null;
  dueDate: string | null;
  status: '' | 'AG' | 'PG';
  category: string;
  /** Nulo = conta avulsa. */
  recurrence: BillImportRecurrence | null;
}

export interface BillPreviewRow {
  rowNumber: number;
  raw: Record<string, string>;
  values: BillPreviewValues;
  errors: string[];
  /** Repete uma conta já gravada ou uma linha anterior do arquivo. */
  duplicate: boolean;
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
  /** Linhas que viraram recorrência (as demais são contas avulsas). */
  createdTemplates: number;
  errors: { rowNumber: number; errors: string[] }[];
}

function rawMap(row: { cells: unknown[] }, mapping: Partial<Record<BillImportField, number | null>>) {
  const result: Record<BillImportField, unknown> = {
    description: null,
    amount: null,
    dueDate: null,
    status: null,
    category: null,
    repeat: null,
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

const REPEAT_WORDS: Record<string, { frequency: BillFrequency; interval: number }> = {
  mensal: { frequency: 'monthly', interval: 1 },
  bimestral: { frequency: 'monthly', interval: 2 },
  trimestral: { frequency: 'monthly', interval: 3 },
  semestral: { frequency: 'monthly', interval: 6 },
  anual: { frequency: 'yearly', interval: 1 },
  semanal: { frequency: 'weekly', interval: 1 },
  quinzenal: { frequency: 'weekly', interval: 2 },
};

const REPEAT_HELP =
  'Use mensal, bimestral, trimestral, semestral, anual, semanal ou quinzenal; opcionalmente "12x" e, no mensal, "último dia útil".';

/**
 * Coluna Repetição: "Mensal", "Trimestral 4x", "Mensal, último dia útil",
 * "Quinzenal 6 vezes". Vazio, "não" ou "avulsa" = conta avulsa.
 */
export function parseRepeat(
  value: unknown,
): { ok: true; value: Omit<BillImportRecurrence, 'label'> | null } | { ok: false; error: string } {
  let text = normalizeName(String(value ?? '')).replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (text === '' || text === 'nao' || text === 'avulsa' || text === 'unica' || text === 'n') return { ok: true, value: null };

  let lastBusinessDay = false;
  if (/\bultimo dia util\b/.test(text)) {
    lastBusinessDay = true;
    text = text.replace(/\bultimo dia util\b/, ' ').trim();
  }
  let occurrenceCount: number | null = null;
  const count = /(?:^|\s)(?:x\s*(\d+)|(\d+)\s*(?:x|vezes))(?:\s|$)/.exec(text);
  if (count) {
    occurrenceCount = Number(count[1] ?? count[2]);
    text = text.replace(count[0], ' ').trim();
  }
  const words = text.split(' ').filter((word) => word && word !== 'no' && word !== 'em' && word !== 'e');
  if (words.length !== 1 || !REPEAT_WORDS[words[0]]) return { ok: false, error: `Repetição inválida. ${REPEAT_HELP}` };
  const rule = REPEAT_WORDS[words[0]];
  if (occurrenceCount !== null && (occurrenceCount < 1 || occurrenceCount > 600)) {
    return { ok: false, error: 'Repetição: a quantidade de vezes deve ser de 1 a 600.' };
  }
  if (lastBusinessDay && rule.frequency !== 'monthly') {
    return { ok: false, error: 'Repetição: o último dia útil só vale para mensal, bimestral, trimestral ou semestral.' };
  }
  return { ok: true, value: { ...rule, lastBusinessDay, occurrenceCount } };
}

/** Regra completa a partir da primeira data, como a tela faz ao criar uma recorrência. */
function recurrenceRule(recurrence: Omit<BillImportRecurrence, 'label'>, dueDate: string) {
  const day = Number(dueDate.slice(8, 10));
  const month = Number(dueDate.slice(5, 7));
  return {
    frequency: recurrence.frequency,
    interval: recurrence.interval,
    dayOfMonth: recurrence.frequency === 'weekly' || recurrence.lastBusinessDay ? null : day,
    weekday: null,
    monthOfYear: recurrence.frequency === 'yearly' ? month : null,
    lastBusinessDay: recurrence.lastBusinessDay,
  };
}

function parseBillRow(fields: {
  description: unknown;
  amount: unknown;
  dueDate: unknown;
  status: unknown;
  category: unknown;
  repeat: unknown;
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

  let recurrence: BillImportRecurrence | null = null;
  const repeat = parseRepeat(fields.repeat);
  if (!repeat.ok) errors.push(repeat.error);
  else if (repeat.value) {
    recurrence = { ...repeat.value, label: describeRecurrence(recurrenceRule(repeat.value, dueDate ?? '2000-01-01')) };
    if (status !== '') {
      errors.push('Situação: só vale para conta avulsa. Numa recorrência, marque o pagamento depois, na tela de contas.');
    }
  }

  return {
    values: { description, amountCents, dueDate, status, category, recurrence },
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

/** Impressões das contas já gravadas (descrição, valor, vencimento, categoria). */
function existingBillFingerprints(db: AppDatabase): Set<string> {
  const rows = db
    .select({ description: scheduledBills.description, amountCents: scheduledBills.amountCents, dueDate: scheduledBills.dueDate, categoryName: categories.name })
    .from(scheduledBills)
    .innerJoin(categories, eq(scheduledBills.categoryId, categories.id))
    .all();
  return new Set(
    rows.map((row) => [normalizeName(row.description), row.amountCents, row.dueDate, normalizeName(row.categoryName)].join('|')),
  );
}

/**
 * Números das linhas válidas que repetem uma conta já gravada ou uma linha
 * anterior do arquivo (M1-06: a prévia e a importação usam o mesmo cálculo).
 */
function duplicateRowNumbers(db: AppDatabase, rows: BillPreviewRow[]): Set<number> {
  const known = existingBillFingerprints(db);
  const duplicates = new Set<number>();
  for (const row of rows) {
    if (row.errors.length > 0) continue;
    const fingerprint = billFingerprint(row.values);
    if (known.has(fingerprint)) duplicates.add(row.rowNumber);
    known.add(fingerprint);
  }
  return duplicates;
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
      repeat: fields.repeat,
    });
    return {
      rowNumber: row.rowNumber,
      raw: Object.fromEntries(
        BILL_IMPORT_FIELDS.map((field) => [field, String(raw[field] ?? '')]),
      ) as Record<string, string>,
      values: parsed.values,
      errors: parsed.errors,
      duplicate: false,
    };
  });

  const validRows = rows.filter((r) => r.errors.length === 0).length;
  const invalidRows = rows.filter((r) => r.errors.length > 0).length;

  const duplicates = duplicateRowNumbers(db, rows);
  for (const row of rows) row.duplicate = duplicates.has(row.rowNumber);
  const duplicateRows = duplicates.size;

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
  let skippedDuplicates = 0;
  // Mesmo cálculo da prévia; as linhas rejeitadas não contam.
  const duplicates = duplicateRowNumbers(db, preview.rows.filter((row) => !rejected.has(row.rowNumber)));

  for (const row of preview.rows) {
    if (rejected.has(row.rowNumber)) continue;
    if (row.errors.length > 0) {
      invalidRows += 1;
      errors.push({ rowNumber: row.rowNumber, errors: row.errors });
      continue;
    }
    if (duplicates.has(row.rowNumber) && options.skipDuplicates) {
      skippedDuplicates += 1;
      continue;
    }
    accepted.push(row);
  }

  let createdTemplates = 0;
  // Tudo ou nada: um erro numa linha não deixa parte do arquivo gravada.
  db.transaction(() => {
    for (const row of accepted) {
      const values = row.values;
      const category = ensureLookup(db, 'category', values.category || EMPTY_CATEGORY_NAME);
      if (values.recurrence) {
        createTemplate(db, {
          description: values.description,
          amountCents: values.amountCents as number,
          categoryId: category.id,
          recurrence: recurrenceRule(values.recurrence, values.dueDate as string),
          startDate: values.dueDate as string,
          occurrenceCount: values.recurrence.occurrenceCount,
        });
        createdTemplates += 1;
      } else {
        createBill(db, {
          description: values.description,
          amountCents: values.amountCents as number,
          dueDate: values.dueDate as string,
          categoryId: category.id,
          status: values.status,
        });
      }
    }
  });

  return {
    filename,
    totalRows: preview.totalRows,
    importedRows: accepted.length,
    rejectedRows: rejected.size,
    duplicateRows: duplicates.size,
    skippedDuplicates,
    invalidRows,
    createdTemplates,
    errors,
  };
}
