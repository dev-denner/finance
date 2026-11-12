import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { badRequest } from '../lib/errors';
import type { PurchaseInput } from './purchase-input';

export const MAX_NFCE_PDF_BYTES = 5 * 1024 * 1024;
export const MAX_NFCE_PDF_PAGES = 5;
const MAX_NFCE_PDF_TEXT = 200_000;

interface TextLine { y: number; parts: Array<{ x: number; text: string }> }

function normalizeLines(lines: TextLine[]): string[] {
  return lines
    .sort((a, b) => b.y - a.y)
    .map((line) => line.parts.sort((a, b) => a.x - b.x).map((part) => part.text).join(' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function cents(text: string, field: string): number {
  const match = text.replace(/\s/g, "").match(/-?\d[\d.]*(?:,\d{1,2}|\.\d{2})/);
  if (!match) throw badRequest(`Não foi possível interpretar ${field} no PDF da NFC-e.`);
  const normalized = match[0].includes(",") ? match[0].replace(/\./g, "").replace(",", ".") : match[0];
  const value = Math.round(Number(normalized) * 100);
  if (!Number.isSafeInteger(value) || value < 0) throw badRequest(`Valor inválido para ${field} no PDF da NFC-e.`);
  return value;
}

function required(match: RegExpMatchArray | null, field: string): string {
  const value = match?.[1]?.trim();
  if (!value) throw badRequest(`Não foi possível identificar ${field} no PDF da NFC-e.`);
  return value;
}

function dateIso(text: string): string {
  const match = text.match(/(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}:\d{2}(?::\d{2})?)/);
  if (!match) throw badRequest('Não foi possível identificar a data de emissão no PDF da NFC-e.');
  return `${match[3]}-${match[2]}-${match[1]}T${match[4].length === 5 ? `${match[4]}:00` : match[4]}-03:00`;
}

function keyFromText(text: string): string {
  const candidates = text.split(String.fromCharCode(10)).map((line) => line.replace(/\D/g, ""));
  const key = candidates.find((candidate) => candidate.length === 44) ?? "";
  if (key.length !== 44) throw badRequest('Não foi possível identificar a chave de acesso no PDF da NFC-e.');
  return key;
}

function parseRj(lines: string[], fullText: string): PurchaseInput {
  const joined = lines.join('\n');
  const cnpjMatch = joined.match(/CNPJ\s*:?\s*([\d./-]{14,18})/i);
  const cnpj = cnpjMatch?.[1]?.replace(/\D/g, '') ?? '';
  if (cnpj.length !== 14) throw badRequest('Não foi possível identificar o CNPJ do fornecedor no PDF do RJ.');
  const supplierIndex = lines.findIndex((line) => /CNPJ/i.test(line));
  const supplierName = lines.slice(Math.max(0, supplierIndex - 1), supplierIndex).find((line) => line.length > 2) ?? '';
  const invoiceLine = lines.find((line) => /Número\s*:/i.test(line) && /Série\s*:/i.test(line) && /Emissão\s*:/i.test(line)) ?? '';
  const invoiceNumber = required(invoiceLine.match(/Número\s*:\s*(\d+)/i), 'número da NFC-e');
  const series = required(invoiceLine.match(/Série\s*:\s*(\d+)/i), 'série da NFC-e');
  const issuedAt = dateIso(invoiceLine);
  const payableIndex = lines.findIndex((line) => /Valor\s+a\s+pagar/i.test(line));
  const totalText = required(lines.slice(payableIndex, payableIndex + 3).join(" ").match(/Valor\s+a\s+pagar[\s\S]{0,40}?([\d.,]+)/i), "total a pagar");
  const paymentMethod = joined.match(/Forma\s+de\s+pagamento\s*:?\s*([\p{L} ]+?)(?=\s+Valor\s+pago|\n|$)/iu)?.[1]?.trim() ?? null;
  const items: PurchaseInput['items'] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const descriptionLine = lines[index] ?? '';
    if (!/\(Código\s*:/i.test(descriptionLine)) continue;
    const description = descriptionLine.replace(/\s*\(Código\s*:[^)]*\)/i, '').replace(/\s*Vl\.\s*Total.*$/i, '').trim();
    const dataLine = [lines[index + 1], lines[index + 2]].filter(Boolean).join(' ');
    const values = dataLine.match(/Qtde\.?\s*:\s*([\d.,]+).*?UN\s*:\s*([^\s]+).*?Vl\.\s*Unit\.?\s*:\s*([\d.,]+)/i);
    if (!values) continue;
    const amounts = [...dataLine.matchAll(/\d[\d.]*[,.]\d{2}/g)].map(([value]) => value);
    const amountText = amounts.at(-1);
    if (!amountText) throw badRequest("Não foi possível interpretar o total de um item no PDF do RJ.");
    items.push({ description, quantity: values[1]!.replace(',', '.'), unit: values[2]!, unitPriceCents: cents(values[3]!, 'preço unitário'), discountCents: null, totalCents: cents(amountText, 'total do item') });
  }
  const totalCents = cents(totalText, 'total da nota');
  if (!supplierName || items.length === 0 || items.reduce((sum, item) => sum + item.totalCents, 0) !== totalCents) {
    throw badRequest('Os itens ou o total do PDF do RJ não puderam ser conferidos.');
  }
  return { accessKey: keyFromText(fullText), supplierName, supplierCnpj: cnpj, invoiceNumber, series, issuedAt, totalCents, invoiceDiscountCents: 0, paymentMethod, items };
}

function parseMg(lines: string[], fullText: string): PurchaseInput {
  const joined = lines.join("\n");
  const supplierIndex = lines.findIndex((line) => /CNPJ/i.test(line));
  const supplierName = required(lines[supplierIndex - 1]?.match(/(.+)/), "fornecedor");
  const supplierCnpj = (lines[supplierIndex] ?? "").match(/CNPJ\s*:?\s*([\d .\/-]+)/i)?.[1]?.replace(/\D/g, "").slice(0, 14) ?? "";
  if (supplierCnpj.length !== 14) throw badRequest("Não foi possível identificar o CNPJ do fornecedor no PDF de MG.");
  const invoiceIndex = lines.findIndex((line) => /Número/i.test(line) && /Série/i.test(line));
  const valuesLine = lines[invoiceIndex + 1] ?? "";
  const dateMatch = valuesLine.match(/(\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}(?::\d{2})?)/);
  const prefix = dateMatch ? valuesLine.slice(0, dateMatch.index) : "";
  const invoiceValues = prefix.match(/\d+/g) ?? [];
  const invoiceNumber = required(invoiceValues.length >= 2 ? [invoiceValues.at(-1)!, invoiceValues.at(-1)!] as unknown as RegExpMatchArray : null, "número da NFC-e");
  const series = required(invoiceValues.length >= 2 ? [invoiceValues.at(-2)!, invoiceValues.at(-2)!] as unknown as RegExpMatchArray : null, "série da NFC-e");
  const issuedAt = dateIso(valuesLine);
  const itemCountIndex = lines.findIndex((line) => /Qtde.*total.*it[eé]ns/i.test(line) && !/Código/i.test(line));
  const totalIndex = lines.findIndex((line, index) => index > itemCountIndex && /Valor\s+(?:a\s+pagar|total)/i.test(line) && !/Código/i.test(line));
  const totalText = required(lines.slice(totalIndex, totalIndex + 4).join(" ").match(/(?:Valor\s+total|Valor\s+a\s+pagar)[^\d]{0,40}([\d.,]+)/i), "total da nota");
  const paymentMethod = joined.match(/Forma\s+de\s+Pagamento\s*:?\s*([^\n]+)/i)?.[1]?.trim() ?? null;
  const items: PurchaseInput["items"] = [];
  for (const line of lines) {
    if (!/Qtde/i.test(line) || !/(?:Valor\s+total|Vl\.?\s*Total)/i.test(line)) continue;
    const quantity = line.match(/Qtde(?:\s+total)?[^\d]*([\d.,]+)/i)?.[1];
    const unit = line.match(/(?:Unidade|Un\.?|UN)\s*:?\s*([\p{L}]+)/iu)?.[1];
    const unitPrice = line.match(/(?:Valor\s+unit[aá]rio|Vl\.?\s*Unit\.?)[^\d]*([\d.,]+)/i)?.[1];
    const itemTotal = line.match(/(?:Valor\s+total|Vl\.?\s*Total)[^\d]*([\d.,]+)/i)?.[1];
    const description = line.split(/(?:C[oó]digo|Qtde)/i)[0]?.trim() ?? "";
    if (!quantity || !unit || !itemTotal || !description) continue;
    const quantityNumber = Number(quantity.replace(",", "."));
    if (!Number.isFinite(quantityNumber) || quantityNumber <= 0) continue;
    const totalCents = cents(itemTotal, "total do item");
    const unitPriceCents = unitPrice ? cents(unitPrice, "preço unitário") : Math.round(totalCents / quantityNumber);
    items.push({ description, quantity: quantityNumber.toString(), unit, unitPriceCents, discountCents: null, totalCents });
  }
  const totalCents = cents(totalText, "total da nota");
  if (items.length === 0 || items.reduce((sum, item) => sum + item.totalCents, 0) !== totalCents) {
    throw badRequest("Os itens ou o total do PDF de MG não puderam ser conferidos.");
  }
  let accessKey: string;
  try {
    accessKey = keyFromText(fullText);
  } catch {
    throw badRequest("O PDF de MG não contém a chave de acesso. Expanda a seção “Chave de acesso” no portal antes de salvar o PDF, ou importe pela URL do QR Code.");
  }
  return { accessKey, supplierName, supplierCnpj, invoiceNumber, series, issuedAt, totalCents, invoiceDiscountCents: 0, paymentMethod, items };
}

export async function extractNfcePdf(buffer: Buffer): Promise<{ state: 'RJ' | 'MG'; purchase: PurchaseInput }> {
  if (buffer.length === 0 || buffer.length > MAX_NFCE_PDF_BYTES || buffer.subarray(0, 5).toString('ascii') !== '%PDF-') {
    throw badRequest('Envie um PDF de NFC-e válido de até 5 MB.');
  }
  const loadingTask = getDocument({ data: new Uint8Array(buffer) });
  const document = await loadingTask.promise;
  try {
    if (document.numPages < 1 || document.numPages > MAX_NFCE_PDF_PAGES) throw badRequest('O PDF deve ter no máximo cinco páginas.');
    const lines: TextLine[] = [];
    let totalChars = 0;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      for (const item of content.items) {
        if (!('str' in item) || !item.str.trim()) continue;
        totalChars += item.str.length;
        if (totalChars > MAX_NFCE_PDF_TEXT) throw badRequest('O texto extraído do PDF excede o limite permitido.');
        const y = Math.round(item.transform[5]! * 2) / 2;
        let line = lines.find((candidate) => Math.abs(candidate.y - y) < 1);
        if (!line) { line = { y, parts: [] }; lines.push(line); }
        line.parts.push({ x: item.transform[4]!, text: item.str });
      }
    }
    const normalized = normalizeLines(lines);
    const text = normalized.join('\n');
    const state = /www4?\.fazenda\.rj\.gov\.br|RIO\s+DE\s+JANEIRO/i.test(text) ? 'RJ' :
      /SEF\/MG|MINAS\s+GERAIS|portalsped\.fazenda\.mg\.gov\.br/i.test(text) ? 'MG' : null;
    if (!state) throw badRequest('O PDF não corresponde a um dos layouts de NFC-e suportados (RJ ou MG).');
    return { state, purchase: state === 'RJ' ? parseRj(normalized, text) : parseMg(normalized, text) };
  } finally {
    await loadingTask.destroy();
  }
}
