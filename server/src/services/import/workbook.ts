/** Leitura do arquivo: CSV (codificação e delimitador detectados) e Excel, em linhas com metadados das células. */
import path from 'node:path';
import * as XLSX from 'xlsx';
import { badRequest } from '../../lib/errors';
import { suggestMapping } from './mapping';
import { type CellMeta, MAX_ROWS, type ParsedWorkbook, type SheetRow } from './types';

export function decodeCsv(buffer: Buffer): string {
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

export function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) {
    return `${value.getDate().toString().padStart(2, '0')}/${(value.getMonth() + 1)
      .toString()
      .padStart(2, '0')}/${value.getFullYear()}`;
  }
  return String(value).replace(/\u00a0/g, ' ').trim();
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
