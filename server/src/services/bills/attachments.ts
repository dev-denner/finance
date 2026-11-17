/**
 * Anexos das contas a pagar: boleto em PDF ou foto da conta (PNG/JPEG). O
 * tipo é conferido pelos primeiros bytes, não pela extensão nem pelo
 * cabeçalho enviado.
 */
import { and, count, eq } from 'drizzle-orm';
import type { AppDatabase } from '../../db/client';
import { billAttachments } from '../../db/schema';
import { findBarcodeInText, type BarcodeDetails } from '../../lib/barcode';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { readPdfTextLines } from '../../lib/pdf-text';
import type { BillAttachmentDto } from './dto';
import { loadBillRow } from './occurrences';

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_BILL = 10;

/** Tipo pelo conteúdo: PDF, PNG ou JPEG. */
export function sniffAttachmentType(buffer: Buffer): string | null {
  if (buffer.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  return null;
}

/** Nome sem pasta, sem caracteres de controle e com no máximo 200 caracteres. */
export function sanitizeFilename(value: string): string {
  const base = value.split(/[\\/]/).pop()?.replace(/[\u0000-\u001f\u007f]/g, '').trim() ?? '';
  return (base || 'anexo').slice(0, 200);
}

function toDto(row: typeof billAttachments.$inferSelect): BillAttachmentDto {
  return {
    id: row.id,
    filename: row.filename,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    createdAt: row.createdAt,
  };
}

export function addBillAttachment(
  db: AppDatabase,
  billId: number,
  file: { buffer: Buffer; filename: string },
): BillAttachmentDto {
  loadBillRow(db, billId);
  if (file.buffer.length === 0) throw badRequest('O arquivo está vazio.');
  if (file.buffer.length > MAX_ATTACHMENT_BYTES) throw badRequest('O anexo pode ter no máximo 10 MB.');
  const contentType = sniffAttachmentType(file.buffer);
  if (!contentType) throw badRequest('Envie um PDF, PNG ou JPEG.');
  const existing = db.select({ n: count() }).from(billAttachments).where(eq(billAttachments.billId, billId)).get()?.n ?? 0;
  if (existing >= MAX_ATTACHMENTS_PER_BILL) {
    throw conflict(`Uma conta pode ter no máximo ${MAX_ATTACHMENTS_PER_BILL} anexos.`);
  }
  const row = db
    .insert(billAttachments)
    .values({
      billId,
      filename: sanitizeFilename(file.filename),
      contentType,
      sizeBytes: file.buffer.length,
      data: file.buffer,
    })
    .returning()
    .get();
  return toDto(row);
}

export function getBillAttachmentFile(
  db: AppDatabase,
  billId: number,
  attachmentId: number,
): { filename: string; contentType: string; data: Buffer } {
  const row = db
    .select()
    .from(billAttachments)
    .where(and(eq(billAttachments.id, attachmentId), eq(billAttachments.billId, billId)))
    .get();
  if (!row) throw notFound('Anexo não encontrado nesta conta.');
  return { filename: row.filename, contentType: row.contentType, data: row.data };
}

export function deleteBillAttachment(db: AppDatabase, billId: number, attachmentId: number): { ok: true } {
  const result = db
    .delete(billAttachments)
    .where(and(eq(billAttachments.id, attachmentId), eq(billAttachments.billId, billId)))
    .run();
  if (result.changes === 0) throw notFound('Anexo não encontrado nesta conta.');
  return { ok: true };
}

/**
 * Lê a linha digitável no texto do PDF anexado. Devolve null quando o PDF não
 * tem texto (boleto escaneado) ou nenhuma sequência passa nos dígitos
 * verificadores.
 */
export async function readBarcodeFromAttachment(
  db: AppDatabase,
  billId: number,
  attachmentId: number,
  today: string,
): Promise<BarcodeDetails | null> {
  const file = getBillAttachmentFile(db, billId, attachmentId);
  if (file.contentType !== 'application/pdf') throw badRequest('Só dá para ler a linha digitável de um PDF.');
  const lines = await readPdfTextLines(file.data, {
    maxPages: 10,
    maxChars: 200_000,
    pagesError: 'O PDF deve ter no máximo dez páginas para a leitura da linha digitável.',
    textError: 'O texto do PDF passa do limite para a leitura da linha digitável.',
  });
  // Cada linha com as partes em ordem horizontal; depois o texto todo, para códigos quebrados em duas linhas.
  const texts = lines
    .sort((a, b) => b.y - a.y)
    .map((line) => line.parts.sort((a, b) => a.x - b.x).map((part) => part.text).join(' '));
  for (const text of [...texts, texts.join(' ')]) {
    const found = findBarcodeInText(text, today);
    if (found) return found;
  }
  return null;
}
