/**
 * Extrato OFX (1.x em SGML e 2.x em XML), com parser próprio: os lançamentos
 * viram uma planilha com as colunas padrão da importação, e o resto do fluxo
 * (prévia, duplicidade, categorias, transferências, contas a pagar) segue igual.
 */
import { badRequest } from '../../lib/errors';
import { FIELD_LABELS, IMPORT_FIELDS, MAX_ROWS, type ParsedWorkbook, type SheetRow } from './types';
import { suggestMapping } from './mapping';

export interface OfxTransaction {
  /** AAAA-MM-DD (data do lançamento no extrato). */
  postedAt: string;
  amountCents: number;
  description: string;
  /** Identificador do banco para o lançamento (FITID). */
  fitId: string | null;
  type: string | null;
}

export interface OfxStatement {
  kind: 'bank' | 'credit_card';
  bankId: string | null;
  accountId: string | null;
  transactions: OfxTransaction[];
}

/** Arquivo OFX pela extensão ou pelo começo do conteúdo. */
export function isOfx(buffer: Buffer, filename: string): boolean {
  if (/\.(ofx|qfx)$/i.test(filename)) return true;
  const head = buffer.subarray(0, 512).toString('latin1');
  return /OFXHEADER\s*:|<OFX>|<\?OFX /i.test(head);
}

/** Codificação pelo cabeçalho (CHARSET:1252 ou encoding do XML); sem ela, UTF-8 com recuo para Windows-1252. */
function decodeOfx(buffer: Buffer): string {
  const head = buffer.subarray(0, 512).toString('latin1');
  if (/CHARSET\s*:\s*(1252|ISO-?8859-?1|WINDOWS-1252)/i.test(head)) return new TextDecoder('windows-1252').decode(buffer);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return new TextDecoder('windows-1252').decode(buffer);
  }
}

function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, '&');
}

/** Valor de um elemento: no SGML a tag não fecha (o valor vai até a próxima tag ou o fim da linha). */
function field(block: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>([^<\\r\\n]*)`, 'i').exec(block);
  if (!match) return null;
  const value = decodeEntities(match[1]).trim();
  return value === '' ? null : value;
}

function parseDate(value: string | null): string | null {
  const match = /^(\d{4})(\d{2})(\d{2})/.exec(value ?? '');
  if (!match) return null;
  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (date.getUTCFullYear() !== Number(year) || date.getUTCMonth() !== Number(month) - 1 || date.getUTCDate() !== Number(day)) return null;
  return `${year}-${month}-${day}`;
}

/** "-150.00", "-150,00" ou "1.234,56" em centavos. */
function parseAmount(value: string | null): number | null {
  if (!value) return null;
  let text = value.replace(/\s/g, '');
  if (text.includes(',') && text.includes('.')) {
    text = text.lastIndexOf(',') > text.lastIndexOf('.') ? text.replace(/\./g, '').replace(',', '.') : text.replace(/,/g, '');
  } else if (text.includes(',')) {
    text = text.replace(',', '.');
  }
  if (!/^[+-]?\d+(\.\d+)?$/.test(text)) return null;
  return Math.round(Number(text) * 100);
}

/** Nome e memorando: o que vier; os dois, quando o memorando não repete o nome. */
function describe(name: string | null, memo: string | null): string {
  if (name && memo && !memo.toLowerCase().includes(name.toLowerCase())) return `${name} ${memo}`;
  return memo ?? name ?? '';
}

export function parseOfx(buffer: Buffer): OfxStatement {
  const text = decodeOfx(buffer);
  if (!/<OFX>/i.test(text)) throw badRequest('O arquivo não parece um OFX válido.');
  const kind = /<CCACCTFROM>/i.test(text) ? 'credit_card' : 'bank';
  const account = /<(?:BANK|CC)ACCTFROM>([\s\S]*?)<\/(?:BANK|CC)ACCTFROM>/i.exec(text)?.[1] ?? text;
  const transactions: OfxTransaction[] = [];
  const pattern = /<STMTTRN>([\s\S]*?)<\/STMTTRN>/gi;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const block = match[1];
    const postedAt = parseDate(field(block, 'DTPOSTED')) ?? parseDate(field(block, 'DTUSER'));
    const amountCents = parseAmount(field(block, 'TRNAMT'));
    if (!postedAt || amountCents === null) {
      throw badRequest(`Lançamento ${transactions.length + 1} do OFX sem data ou valor válidos.`);
    }
    transactions.push({
      postedAt,
      amountCents,
      description: describe(field(block, 'NAME'), field(block, 'MEMO')),
      fitId: field(block, 'FITID'),
      type: field(block, 'TRNTYPE'),
    });
  }
  return { kind, bankId: field(account, 'BANKID'), accountId: field(account, 'ACCTID'), transactions };
}

function brDate(iso: string): string {
  const [year, month, day] = iso.split('-');
  return `${day}/${month}/${year}`;
}

function brAmount(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)},${String(abs % 100).padStart(2, '0')}`;
}

/**
 * O extrato como planilha com as colunas padrão (Data Compra, Vencimento,
 * Compra, Valor…). A data do lançamento vale para compra e vencimento; a
 * conta fica para o seletor "Conta de destino do lote".
 */
export function ofxToWorkbook(buffer: Buffer, filename: string): ParsedWorkbook {
  const statement = parseOfx(buffer);
  if (statement.transactions.length === 0) throw badRequest('O OFX não possui lançamentos.');
  if (statement.transactions.length > MAX_ROWS) {
    throw badRequest(`O arquivo possui mais de ${MAX_ROWS} linhas. Divida a importação em partes.`);
  }
  const headers = IMPORT_FIELDS.map((key) => FIELD_LABELS[key]);
  const rows: SheetRow[] = statement.transactions.map((transaction, index) => {
    const values: Record<(typeof IMPORT_FIELDS)[number], string> = {
      purchaseDate: brDate(transaction.postedAt),
      dueDate: brDate(transaction.postedAt),
      description: transaction.description,
      amount: brAmount(transaction.amountCents),
      paymentMethod: '',
      installments: '',
      category: '',
      transfer: '',
    };
    const cells = IMPORT_FIELDS.map((key) => values[key]);
    // Linha 1 é o cabeçalho, como numa planilha: o primeiro lançamento é a linha 2.
    return { rowNumber: index + 2, cells, meta: cells.map(() => null) };
  });
  const account = statement.accountId ? ` ${statement.accountId}` : '';
  return {
    filename,
    sheetName: statement.kind === 'credit_card' ? `OFX · cartão${account}` : `OFX · conta${account}`,
    headers,
    rows,
    mapping: suggestMapping(headers),
  };
}
