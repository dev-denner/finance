import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseHandle } from '../src/db/client';
import { buildApp } from '../src/app';
import { bankMod11, findBarcodeInText, formatBarcodeDigits, mod10 } from '../src/lib/barcode';
import { addBillAttachment, createBill, readBarcodeFromAttachment } from '../src/services/bills';
import { ensureLookup } from '../src/services/lookups';
import { readPdfTextLines } from '../src/lib/pdf-text';
import { createTestDatabase, pdfFromStream, textPdf } from './helpers';

const TODAY = '2026-11-17';

function validLine(): string {
  const bank = '3419';
  const free = '1090012345678901234567890';
  const factorAmount = '16410000035664';
  const dv = bankMod11(bank + factorAmount + free);
  const f1 = bank + free.slice(0, 5);
  const f2 = free.slice(5, 15);
  const f3 = free.slice(15, 25);
  return `${f1}${mod10(f1)}${f2}${mod10(f2)}${f3}${mod10(f3)}${dv}${factorAmount}`;
}

let handle: DatabaseHandle;
let categoryId: number;

beforeEach(() => {
  handle = createTestDatabase();
  categoryId = ensureLookup(handle.db, 'category', 'Contas').id;
});

afterEach(() => handle.sqlite.close());

describe('linha digitável no texto', () => {
  it('acha a linha formatada no meio do texto e ignora números que não passam nos dígitos', () => {
    const line = validLine();
    const text = `Banco Itaú 341-7 Pagador: Fulano CPF 123.456.789-09 ${formatBarcodeDigits(line)} Vencimento 25/11/2026 Valor 356,64`;
    expect(findBarcodeInText(text, TODAY)).toMatchObject({ digits: line, amountCents: 35664, dueDate: '2026-11-25' });
    expect(findBarcodeInText(`Nosso número 12345678901234567890123456789012345678901234567 fim`, TODAY)).toBeNull();
    expect(findBarcodeInText('sem código', TODAY)).toBeNull();
  });
});

describe('linha digitável no PDF anexado', () => {
  it('lê do PDF com texto, devolve null sem código e recusa imagem', async () => {
    const bill = createBill(handle.db, { description: 'Escola', amountCents: 35664, dueDate: '2026-11-25', categoryId }, TODAY);
    const line = validLine();
    const pdf = addBillAttachment(handle.db, bill.id, {
      buffer: textPdf(['Recibo do pagador', `${formatBarcodeDigits(line)}`, 'Autenticação mecânica']),
      filename: 'boleto.pdf',
    });
    await expect(readBarcodeFromAttachment(handle.db, bill.id, pdf.id, TODAY)).resolves.toMatchObject({ digits: line, kind: 'bank' });

    const empty = addBillAttachment(handle.db, bill.id, { buffer: textPdf(['Comprovante sem linha digitável']), filename: 'outro.pdf' });
    await expect(readBarcodeFromAttachment(handle.db, bill.id, empty.id, TODAY)).resolves.toBeNull();

    const png = addBillAttachment(handle.db, bill.id, {
      buffer: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('x')]),
      filename: 'foto.png',
    });
    await expect(readBarcodeFromAttachment(handle.db, bill.id, png.id, TODAY)).rejects.toThrow(/PDF/);

    const app = await buildApp({ db: handle.db, logger: false });
    try {
      const found = await app.inject({ method: 'POST', url: `/api/bills/${bill.id}/attachments/${pdf.id}/barcode` });
      expect(found.json()).toMatchObject({ found: true, digits: line, amountCents: 35664 });
      const none = await app.inject({ method: 'POST', url: `/api/bills/${bill.id}/attachments/${empty.id}/barcode` });
      expect(none.json()).toEqual({ found: false });
    } finally {
      await app.close();
    }
  });
});

describe('texto do PDF', () => {
  const limits = { maxPages: 10, maxChars: 200_000, pagesError: 'páginas', textError: 'texto demais' };

  it('agrupa trechos na mesma altura e separa alturas diferentes', async () => {
    const lines = await readPdfTextLines(textPdf(['A', 'B', 'C']), limits);
    expect(lines.map((line) => line.parts.map((part) => part.text).join(''))).toEqual(['A', 'B', 'C']);
  });

  it('recusa PDF fragmentado demais em vez de travar o servidor', async () => {
    // Grade de trechos de um caractere (50 por linha): o pdfjs mantém cada um como item separado.
    const grid = (count: number) =>
      pdfFromStream(
        Array.from({ length: count }, (_, index) => `BT /F1 2 Tf ${20 + (index % 50) * 11} ${820 - Math.floor(index / 50) * 2} Td (x) Tj ET`).join('\n'),
      );
    const fine = await readPdfTextLines(grid(3_000), limits);
    expect(fine).toHaveLength(60);
    expect(fine.every((line) => line.parts.length === 50)).toBe(true);
    await expect(readPdfTextLines(grid(20_001), limits)).rejects.toThrow('texto demais');
  }, 30_000);
});
