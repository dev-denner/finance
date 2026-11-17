import type { AppDatabase, DatabaseHandle } from '../src/db/client';
import { createDatabase, runMigrations } from '../src/db/client';
import { ensureLookup } from '../src/services/lookups';
import { createTransaction, type TransactionWriteInput } from '../src/services/transactions';
import { bankMod11, mod10 } from '../src/lib/barcode';

export function createTestDatabase(): DatabaseHandle {
  const handle = createDatabase(':memory:');
  runMigrations(handle);
  return handle;
}

export function seedTransaction(
  db: AppDatabase,
  input: TransactionWriteInput & {
    category?: string;
    payment?: string;
    dueDate: string;
    amount: string;
  },
) {
  const category = ensureLookup(db, 'category', input.category ?? 'Mercado');
  const payment = ensureLookup(db, 'payment', input.payment ?? 'Pix');
  return createTransaction(db, {
    purchaseDate: input.purchaseDate ?? input.dueDate,
    dueDate: input.dueDate,
    description: input.description ?? 'Lançamento de teste',
    amount: input.amount,
    categoryId: category.id,
    paymentMethodId: payment.id,
    installmentNumber: input.installmentNumber ?? null,
    installmentTotal: input.installmentTotal ?? null,
    transfer: input.transfer ?? null,
  });
}

export function csvBuffer(content: string): Buffer {
  return Buffer.from(content, 'utf8');
}

export function makeCsv(rows: string[], header = 'Data Compra;Vencimento;Compra;Valor;Pagamento;Parcelas;Categorias;Transf') {
  return csvBuffer([header, ...rows].join('\r\n'));
}

/** PDF mínimo de uma página com uma linha de texto por item (Helvetica), com xref correto. */
export function textPdf(lines: string[]): Buffer {
  const escape = (text: string) => text.replace(/[\\()]/g, (char) => `\\${char}`);
  return pdfFromStream(lines.map((text, index) => `BT /F1 10 Tf 40 ${780 - index * 20} Td (${escape(text)}) Tj ET`).join('\n'));
}

export function pdfFromStream(stream: string): Buffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`,
  ];
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body, 'latin1'));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body, 'latin1');
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

/** Linha digitável bancária válida (47 dígitos) montada pelo padrão FEBRABAN. */
export function bankBarcodeLine(factor: string, amount: string, free = '1090012345678901234567890', bank = '3419'): string {
  const dv = bankMod11(bank + factor + amount + free);
  const f1 = bank + free.slice(0, 5);
  const f2 = free.slice(5, 15);
  const f3 = free.slice(15, 25);
  return `${f1}${mod10(f1)}${f2}${mod10(f2)}${f3}${mod10(f3)}${dv}${factor}${amount}`;
}

/** Linha de arrecadação válida (48 dígitos): segmento 2 (saneamento), valor efetivo (6) e empresa de 4 dígitos. */
export function utilityBarcodeLine(amount: string, company = '0123', rest = '0102030405060708091011121'): string {
  const withoutDv = `826${amount}${company}${rest}`;
  const barcode = withoutDv.slice(0, 3) + mod10(withoutDv) + withoutDv.slice(3);
  return [0, 1, 2, 3].map((index) => barcode.slice(index * 11, index * 11 + 11)).map((block) => block + mod10(block)).join('');
}

