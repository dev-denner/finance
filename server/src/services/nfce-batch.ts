import type { AppDatabase } from '../db/client';
import { badRequest, HttpError } from '../lib/errors';
import { decodeCsv } from './import';
import { findPurchaseByAccessKey, importPurchase } from './purchases';
import { NfcePortalAccessBlockedError } from './nfce-browser';
import { isNfceQueryStopError, NfcePortalPausedError, NfceQueryPersistenceError } from './nfce-query-guard';
import { previewNfce, validateNfceQrUrl, type NfceState } from './nfce-adapters';
import type { PurchaseInput } from './purchase-input';

/**
 * Limites explícitos da importação em lote de NFC-e por arquivo.
 *
 * A prévia e a importação consultam os portais estaduais em série, uma nota por vez.
 * `MAX_BATCH_QUERIES` evita sobrecarregar o portal e mantém o lote previsível;
 * arquivos maiores precisam ser divididos pelo usuário.
 */
export const MAX_BATCH_FILE_BYTES = 1 * 1024 * 1024;
export const MAX_BATCH_LINES = 200;
export const MAX_BATCH_QUERIES = 50;
export const MAX_BATCH_COLUMNS = 20;
export const MAX_BATCH_LINE_CHARS = 2048;

export type NfceBatchRowStatus =
  | 'valid'
  | 'invalid'
  | 'blank'
  | 'duplicate-file'
  | 'already-imported'
  | 'error'
  | 'not-queried';

export interface NfceBatchLimits {
  fileBytes: number;
  lines: number;
  queries: number;
  lineChars: number;
}

export interface NfceBatchColumnInfo {
  index: number;
  label: string;
  /** Células não vazias que passaram na validação estrita da URL. */
  validCount: number;
  /** Células não vazias avaliadas nas linhas de dados. */
  totalCount: number;
}

export interface NfceBatchInspection {
  /** `null` quando o arquivo não tem cabeçalho. */
  headers: string[] | null;
  columns: NfceBatchColumnInfo[];
  suggestedColumn: number | null;
  dataLines: number;
  blankLines: number;
  tooLongLines: number;
  limits: NfceBatchLimits;
}

export interface NfceBatchRow {
  line: number;
  state: NfceState | null;
  status: NfceBatchRowStatus;
  message: string | null;
  supplierName: string | null;
  supplierCnpj: string | null;
  invoiceNumber: string | null;
  series: string | null;
  issuedAt: string | null;
  totalCents: number | null;
  invoiceDiscountCents: number | null;
  itemCount: number | null;
}

export interface NfceBatchSummary {
  total: number;
  valid: number;
  invalid: number;
  blank: number;
  duplicateFile: number;
  alreadyImported: number;
  error: number;
  notQueried: number;
}

export interface NfceBatchPreviewResult {
  inspection: NfceBatchInspection;
  rows: NfceBatchRow[];
  summary: NfceBatchSummary;
}

export type NfceBatchImportStatus = 'imported' | 'duplicate' | 'error' | 'not-queried';

export interface NfceBatchImportRow {
  line: number;
  status: NfceBatchImportStatus;
  message: string | null;
  purchaseId: number | null;
}

export interface NfceBatchImportSummary {
  total: number;
  imported: number;
  duplicate: number;
  error: number;
  notQueried: number;
}

export interface NfceBatchImportResult {
  rows: NfceBatchImportRow[];
  summary: NfceBatchImportSummary;
}

/** Injetável em teste para não abrir o navegador/consultar a SEFAZ. */
export interface NfceBatchDeps {
  preview: (url: string) => Promise<PurchaseInput>;
}

const DEFAULT_DEPS: NfceBatchDeps = { preview: previewNfce };

const KEY_MISMATCH_MESSAGE =
  'A chave de acesso retornada pela SEFAZ não confere com a URL do QR Code.';
const NOT_QUERIED_AFTER_BLOCK_MESSAGE =
  'Não consultada: o lote foi interrompido após o portal informar bloqueio do acesso.';
const NOT_QUERIED_AFTER_LIMIT_MESSAGE =
  'Não consultada: o lote foi interrompido pelo limite ou intervalo mínimo local de consultas.';
const NOT_QUERIED_DURING_PAUSE_MESSAGE =
  'Não consultada: há uma pausa local ativa para consultas à SEFAZ-RJ.';
const NOT_QUERIED_AFTER_STATE_FAILURE_MESSAGE =
  'Não consultada: o controle local de consultas não está disponível.';

interface ParsedBatchLine {
  line: number;
  cells: string[];
  isBlank: boolean;
  tooLong: boolean;
}

interface ParsedBatch {
  headers: string[] | null;
  lines: ParsedBatchLine[];
  width: number;
}

function limits(): NfceBatchLimits {
  return {
    fileBytes: MAX_BATCH_FILE_BYTES,
    lines: MAX_BATCH_LINES,
    queries: MAX_BATCH_QUERIES,
    lineChars: MAX_BATCH_LINE_CHARS,
  };
}

function assertSupportedFile(buffer: Buffer, filename: string): void {
  if (!/\.(csv|txt)$/i.test(filename)) {
    throw badRequest('Envie um arquivo CSV ou TXT com as URLs de QR Code.');
  }
  if (buffer.length > MAX_BATCH_FILE_BYTES) {
    throw badRequest('O arquivo deve ter no máximo 1 MB.');
  }
  if (buffer.includes(0)) {
    throw badRequest('O arquivo não parece ser um CSV ou TXT de texto.');
  }
  if (buffer.length === 0) {
    throw badRequest('O arquivo está vazio.');
  }
}

function splitCsvLine(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (!quoted && char === delimiter) {
      cells.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells.map((cell) => cell.trim());
}

/**
 * Detecta o delimitador considerando todas as linhas (e não só a primeira,
 * que num arquivo sem cabeçalho costuma ser uma URL única).
 */
function detectBatchDelimiter(lines: string[]): string {
  const candidates = [';', ',', '\t'];
  const counts = new Map<string, number>(candidates.map((candidate) => [candidate, 0]));
  for (const line of lines) {
    let quoted = false;
    for (let index = 0; index < line.length; index += 1) {
      const char = line[index];
      if (char === '"') {
        if (quoted && line[index + 1] === '"') index += 1;
        else quoted = !quoted;
      } else if (!quoted && counts.has(char)) {
        counts.set(char, (counts.get(char) ?? 0) + 1);
      }
    }
  }
  let best = ',';
  let bestCount = 0;
  for (const candidate of candidates) {
    const count = counts.get(candidate) ?? 0;
    if (count > bestCount || (count === bestCount && count > 0 && candidate === ';' && best !== ';')) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}

const HEADER_HINTS = /url|link|qr|nota|nfce|c[oó]digo|chave|comprovante|endere[cç]o|cupom/i;

function looksLikeHeader(cells: string[]): boolean {
  const values = cells.map((cell) => cell.trim()).filter(Boolean);
  if (values.length === 0) return false;
  if (values.some((value) => /^https?:\/\//i.test(value))) return false;
  const joined = values.join(' ');
  if (joined.length > 120) return false;
  return HEADER_HINTS.test(joined);
}

function columnLabel(index: number): string {
  if (index < 26) return `Coluna ${String.fromCharCode(65 + index)}`;
  return `Coluna ${index + 1}`;
}

function parseNfceBatch(buffer: Buffer, filename: string): ParsedBatch {
  assertSupportedFile(buffer, filename);
  const text = decodeCsv(buffer);
  const rawLines = text.split(/\r?\n/);
  if (rawLines.length > 1 && rawLines[rawLines.length - 1] === '') rawLines.pop();

  const delimiter = detectBatchDelimiter(rawLines);
  const allLines: ParsedBatchLine[] = rawLines.map((raw, index) => {
    const tooLong = raw.length > MAX_BATCH_LINE_CHARS;
    return {
      line: index + 1,
      cells: tooLong ? [] : splitCsvLine(raw, delimiter),
      isBlank: raw.trim() === '',
      tooLong,
    };
  });

  const width = Math.max(1, ...allLines.map((line) => line.cells.length));
  if (width > MAX_BATCH_COLUMNS) {
    throw badRequest(`O arquivo possui mais de ${MAX_BATCH_COLUMNS} colunas. Use um arquivo mais simples.`);
  }

  let headers: string[] | null = null;
  let dataLines = allLines;
  const firstContent = allLines.find((line) => !line.isBlank);
  if (firstContent && looksLikeHeader(firstContent.cells)) {
    const seen = new Map<string, number>();
    headers = Array.from({ length: width }, (_, index) => {
      const base = firstContent.cells[index] || columnLabel(index);
      const count = seen.get(base) ?? 0;
      seen.set(base, count + 1);
      return count === 0 ? base : `${base} (${count + 1})`;
    });
    dataLines = allLines.filter((line) => line !== firstContent);
  }

  if (dataLines.length > MAX_BATCH_LINES) {
    throw badRequest(`O arquivo possui mais de ${MAX_BATCH_LINES} linhas. Divida a importação em partes.`);
  }
  if (dataLines.length === 0) {
    throw badRequest('O arquivo não possui linhas de dados.');
  }

  return { headers, lines: dataLines, width };
}

function columnStats(parsed: ParsedBatch): NfceBatchColumnInfo[] {
  const columns: NfceBatchColumnInfo[] = [];
  for (let index = 0; index < parsed.width; index += 1) {
    let validCount = 0;
    let totalCount = 0;
    for (const line of parsed.lines) {
      if (line.isBlank || line.tooLong) continue;
      const cell = (line.cells[index] ?? '').trim();
      if (!cell) continue;
      totalCount += 1;
      try {
        validateNfceQrUrl(cell);
        validCount += 1;
      } catch {
        // A célula entra no denominador, mas não é uma URL oficial do RJ.
      }
    }
    columns.push({
      index,
      label: parsed.headers?.[index] ?? columnLabel(index),
      validCount,
      totalCount,
    });
  }
  return columns;
}

function suggestColumn(columns: NfceBatchColumnInfo[]): number | null {
  let best: number | null = null;
  for (const column of columns) {
    if (column.validCount === 0) continue;
    if (best === null || column.validCount > (columns[best]?.validCount ?? 0)) {
      best = column.index;
    }
  }
  return best;
}

function buildInspection(parsed: ParsedBatch): NfceBatchInspection {
  const columns = columnStats(parsed);
  return {
    headers: parsed.headers,
    columns,
    suggestedColumn: suggestColumn(columns),
    dataLines: parsed.lines.length,
    blankLines: parsed.lines.filter((line) => line.isBlank).length,
    tooLongLines: parsed.lines.filter((line) => line.tooLong).length,
    limits: limits(),
  };
}

export function inspectNfceBatch(buffer: Buffer, filename: string): NfceBatchInspection {
  return buildInspection(parseNfceBatch(buffer, filename));
}

function resolveColumn(parsed: ParsedBatch, requested: number | null | undefined): number {
  if (requested !== null && requested !== undefined) {
    if (!Number.isInteger(requested) || requested < 0 || requested >= parsed.width) {
      throw badRequest('Coluna de URL inválida para este arquivo.');
    }
    return requested;
  }
  return suggestColumn(columnStats(parsed)) ?? 0;
}

/**
 * A chave de acesso (44 dígitos) é a parte inicial do parâmetro `p`, que já
 * passou pela validação estrita do QR oficial do RJ. Ela é usada apenas para
 * deduplicar em memória/banco; nunca é devolvida ao cliente.
 */
function accessKeyFromQrUrl(url: URL): string {
  return (url.searchParams.get('p') ?? '').slice(0, 44);
}

function emptyRow(line: number): NfceBatchRow {
  return {
    line,
    state: null,
    status: 'blank',
    message: null,
    supplierName: null,
    supplierCnpj: null,
    invoiceNumber: null,
    series: null,
    issuedAt: null,
    totalCents: null,
    invoiceDiscountCents: null,
    itemCount: null,
  };
}

function fillRow(row: NfceBatchRow, purchase: PurchaseInput, state: NfceState): void {
  row.status = 'valid';
  row.state = state;
  row.message = null;
  row.supplierName = purchase.supplierName;
  row.supplierCnpj = purchase.supplierCnpj;
  row.invoiceNumber = purchase.invoiceNumber;
  row.series = purchase.series;
  row.issuedAt = purchase.issuedAt;
  row.totalCents = purchase.totalCents;
  row.invoiceDiscountCents = purchase.invoiceDiscountCents;
  row.itemCount = purchase.items.length;
}

function summarize(rows: NfceBatchRow[]): NfceBatchSummary {
  const summary: NfceBatchSummary = {
    total: rows.length,
    valid: 0,
    invalid: 0,
    blank: 0,
    duplicateFile: 0,
    alreadyImported: 0,
    error: 0,
    notQueried: 0,
  };
  for (const row of rows) {
    if (row.status === 'valid') summary.valid += 1;
    else if (row.status === 'invalid') summary.invalid += 1;
    else if (row.status === 'blank') summary.blank += 1;
    else if (row.status === 'duplicate-file') summary.duplicateFile += 1;
    else if (row.status === 'already-imported') summary.alreadyImported += 1;
    else if (row.status === 'not-queried') summary.notQueried += 1;
    else summary.error += 1;
  }
  return summary;
}

function safeMessage(error: unknown): string {
  return error instanceof HttpError
    ? error.message
    : 'Não foi possível consultar esta nota. Verifique o portal estadual e tente novamente.';
}

function messageForUnqueriedRows(error: unknown): string {
  if (error instanceof NfcePortalAccessBlockedError) return NOT_QUERIED_AFTER_BLOCK_MESSAGE;
  if (error instanceof NfcePortalPausedError) return NOT_QUERIED_DURING_PAUSE_MESSAGE;
  if (error instanceof NfceQueryPersistenceError) return NOT_QUERIED_AFTER_STATE_FAILURE_MESSAGE;
  return NOT_QUERIED_AFTER_LIMIT_MESSAGE;
}

export async function previewNfceBatch(
  db: AppDatabase,
  buffer: Buffer,
  filename: string,
  options: { column?: number | null } = {},
  deps: NfceBatchDeps = DEFAULT_DEPS,
): Promise<NfceBatchPreviewResult> {
  const parsed = parseNfceBatch(buffer, filename);
  const column = resolveColumn(parsed, options.column);
  const rows: NfceBatchRow[] = [];
  const seenInFile = new Map<string, number>();
  const pending: { row: NfceBatchRow; url: string; accessKey: string; state: NfceState }[] = [];

  for (const line of parsed.lines) {
    const row = emptyRow(line.line);
    rows.push(row);

    if (line.isBlank) {
      row.message = 'Linha vazia.';
      continue;
    }
    if (line.tooLong) {
      row.status = 'invalid';
      row.message = `A linha excede ${MAX_BATCH_LINE_CHARS} caracteres.`;
      continue;
    }
    const cell = (line.cells[column] ?? '').trim();
    if (!cell) {
      row.status = 'invalid';
      row.message = 'A coluna escolhida está vazia nesta linha.';
      continue;
    }

    let validated: ReturnType<typeof validateNfceQrUrl>;
    try {
      validated = validateNfceQrUrl(cell);
    } catch {
      row.status = 'invalid';
      row.message = 'URL de QR Code inválida ou fora do padrão de uma SEFAZ suportada.';
      continue;
    }

    row.state = validated.state;
    const accessKey = accessKeyFromQrUrl(validated.url);
    const firstLine = seenInFile.get(accessKey);
    if (firstLine !== undefined) {
      row.status = 'duplicate-file';
      row.message = `Nota repetida no arquivo (já aparece na linha ${firstLine}).`;
      continue;
    }
    seenInFile.set(accessKey, line.line);

    if (findPurchaseByAccessKey(db, accessKey) !== null) {
      row.status = 'already-imported';
      row.message = 'Esta NFC-e já existe nas compras.';
      continue;
    }

    pending.push({ row, url: validated.url.toString(), accessKey, state: validated.state });
  }

  if (pending.length > MAX_BATCH_QUERIES) {
    throw badRequest(
      `O arquivo possui ${pending.length} notas a consultar; o limite por lote é ${MAX_BATCH_QUERIES}. Divida o arquivo em partes.`,
    );
  }

  // Uma consulta por vez para não sobrecarregar os portais estaduais.
  for (let index = 0; index < pending.length; index += 1) {
    const item = pending[index];
    try {
      const purchase = await deps.preview(item.url);
      if (purchase.accessKey !== item.accessKey) {
        item.row.status = 'error';
        item.row.message = KEY_MISMATCH_MESSAGE;
        continue;
      }
      fillRow(item.row, purchase, item.state);
    } catch (error) {
      item.row.status = 'error';
      item.row.message = safeMessage(error);
      if (error instanceof NfcePortalAccessBlockedError || isNfceQueryStopError(error)) {
        const message = messageForUnqueriedRows(error);
        for (const unqueried of pending.slice(index + 1)) {
          unqueried.row.status = 'not-queried';
          unqueried.row.message = message;
        }
        break;
      }
    }
  }

  return { inspection: buildInspection(parsed), rows, summary: summarize(rows) };
}

export async function importNfceBatch(
  db: AppDatabase,
  buffer: Buffer,
  filename: string,
  options: { column?: number | null; lines: number[] },
  deps: NfceBatchDeps = DEFAULT_DEPS,
): Promise<NfceBatchImportResult> {
  const parsed = parseNfceBatch(buffer, filename);
  const column = resolveColumn(parsed, options.column);

  if (!Array.isArray(options.lines) || options.lines.length === 0) {
    throw badRequest('Selecione ao menos uma linha para importar.');
  }
  if (options.lines.length > MAX_BATCH_QUERIES) {
    throw badRequest(`Selecione no máximo ${MAX_BATCH_QUERIES} linhas por lote.`);
  }
  const requested = [...new Set(options.lines)].sort((left, right) => left - right);
  if (requested.some((line) => !Number.isInteger(line) || line <= 0)) {
    throw badRequest('Seleção de linhas inválida.');
  }

  const byLine = new Map(parsed.lines.map((line) => [line.line, line]));
  const rows: NfceBatchImportRow[] = [];

  for (let selectedIndex = 0; selectedIndex < requested.length; selectedIndex += 1) {
    const lineNumber = requested[selectedIndex];
    const line = byLine.get(lineNumber);
    if (!line) {
      rows.push({ line: lineNumber, status: 'error', message: 'Linha não encontrada no arquivo.', purchaseId: null });
      continue;
    }
    if (line.isBlank) {
      rows.push({ line: lineNumber, status: 'error', message: 'Linha vazia.', purchaseId: null });
      continue;
    }
    if (line.tooLong) {
      rows.push({ line: lineNumber, status: 'error', message: `A linha excede ${MAX_BATCH_LINE_CHARS} caracteres.`, purchaseId: null });
      continue;
    }
    const cell = (line.cells[column] ?? '').trim();
    if (!cell) {
      rows.push({ line: lineNumber, status: 'error', message: 'A coluna escolhida está vazia nesta linha.', purchaseId: null });
      continue;
    }

    let validated: ReturnType<typeof validateNfceQrUrl>;
    try {
      validated = validateNfceQrUrl(cell);
    } catch {
      rows.push({ line: lineNumber, status: 'error', message: 'URL de QR Code inválida ou fora do padrão de uma SEFAZ suportada.', purchaseId: null });
      continue;
    }

    const accessKey = accessKeyFromQrUrl(validated.url);
    const existingId = findPurchaseByAccessKey(db, accessKey);
    if (existingId !== null) {
      rows.push({ line: lineNumber, status: 'duplicate', message: 'Esta NFC-e já existe nas compras.', purchaseId: existingId });
      continue;
    }

    try {
      const purchase = await deps.preview(validated.url.toString());
      if (purchase.accessKey !== accessKey) throw badRequest(KEY_MISMATCH_MESSAGE);
      const result = importPurchase(db, purchase);
      rows.push({
        line: lineNumber,
        status: result.duplicate ? 'duplicate' : 'imported',
        message: result.duplicate ? 'Esta NFC-e já existe nas compras.' : null,
        purchaseId: result.id,
      });
    } catch (error) {
      rows.push({ line: lineNumber, status: 'error', message: safeMessage(error), purchaseId: null });
      if (error instanceof NfcePortalAccessBlockedError || isNfceQueryStopError(error)) {
        const message = messageForUnqueriedRows(error);
        for (const unqueriedLine of requested.slice(selectedIndex + 1)) {
          rows.push({
            line: unqueriedLine,
            status: 'not-queried',
            message,
            purchaseId: null,
          });
        }
        break;
      }
    }
  }

  const summary: NfceBatchImportSummary = {
    total: requested.length,
    imported: rows.filter((row) => row.status === 'imported').length,
    duplicate: rows.filter((row) => row.status === 'duplicate').length,
    error: rows.filter((row) => row.status === 'error').length,
    notQueried: rows.filter((row) => row.status === 'not-queried').length,
  };
  return { rows, summary };
}
