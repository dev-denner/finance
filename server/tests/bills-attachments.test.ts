import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseHandle } from '../src/db/client';
import { buildApp } from '../src/app';
import { bankMod11, mod10 } from '../src/lib/barcode';
import {
  addBillAttachment,
  createBill,
  deleteBill,
  deleteBillAttachment,
  getBill,
  getBillAttachmentFile,
  listBills,
  MAX_ATTACHMENTS_PER_BILL,
  sanitizeFilename,
  updateBill,
} from '../src/services/bills';
import { ensureLookup } from '../src/services/lookups';
import { createTestDatabase } from './helpers';

const TODAY = '2026-03-05';
let handle: DatabaseHandle;
let categoryId: number;

beforeEach(() => {
  handle = createTestDatabase();
  categoryId = ensureLookup(handle.db, 'category', 'Contas').id;
});

afterEach(() => handle.sqlite.close());

const PDF = Buffer.from('%PDF-1.4\n% boleto sintético\n');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('png')]);

function bill(description = 'Condomínio') {
  return createBill(handle.db, { description, amountCents: 78200, dueDate: '2026-03-10', categoryId }, TODAY);
}

function validLine(): string {
  const bank = '0019';
  const free = '1234567890123456789012345';
  const factorAmount = '10000000078200';
  const dv = bankMod11(bank + factorAmount + free);
  const f1 = bank + free.slice(0, 5);
  const f2 = free.slice(5, 15);
  const f3 = free.slice(15, 25);
  return `${f1}${mod10(f1)}${f2}${mod10(f2)}${f3}${mod10(f3)}${dv}${factorAmount}`;
}

describe('contas — linha digitável', () => {
  it('grava só os dígitos, devolve formatada e recusa dígito verificador errado', () => {
    const target = bill();
    const line = validLine();
    const spaced = `${line.slice(0, 5)}.${line.slice(5, 10)} ${line.slice(10)}`;
    const updated = updateBill(handle.db, target.id, { barcode: spaced }, TODAY);
    expect(updated.barcode).toBe(line);
    expect(updated.barcodeFormatted).toMatch(/^\d{5}\.\d{5} /);
    expect(listBills(handle.db, 2026, 3, { today: TODAY }).bills[0].barcode).toBe(line);

    const broken = line.slice(0, 3) + ((Number(line[3]) + 1) % 10) + line.slice(4);
    expect(() => updateBill(handle.db, target.id, { barcode: broken }, TODAY)).toThrow(/1º campo/);
    expect(updateBill(handle.db, target.id, { description: 'Condomínio março' }, TODAY).barcode).toBe(line);
    expect(updateBill(handle.db, target.id, { barcode: '' }, TODAY)).toMatchObject({ barcode: null, barcodeFormatted: null });
  });
});

describe('contas — anexos', () => {
  it('aceita PDF e imagem pelo conteúdo, lista na conta sem o arquivo e devolve o arquivo', () => {
    const target = bill();
    const pdf = addBillAttachment(handle.db, target.id, { buffer: PDF, filename: '../../boleto março.pdf' });
    expect(pdf).toMatchObject({ filename: 'boleto março.pdf', contentType: 'application/pdf', sizeBytes: PDF.length });
    addBillAttachment(handle.db, target.id, { buffer: PNG, filename: 'foto.png' });
    expect(getBill(handle.db, target.id, TODAY).attachments.map((item) => item.contentType)).toEqual(['application/pdf', 'image/png']);
    expect(listBills(handle.db, 2026, 3, { today: TODAY }).bills[0].attachments).toHaveLength(2);
    expect(getBillAttachmentFile(handle.db, target.id, pdf.id).data.equals(PDF)).toBe(true);
  });

  it('recusa tipo desconhecido, arquivo vazio, grande demais e acima do limite por conta', () => {
    const target = bill();
    expect(() => addBillAttachment(handle.db, target.id, { buffer: Buffer.from('MZ executável'), filename: 'boleto.pdf' })).toThrow(/PDF, PNG ou JPEG/);
    expect(() => addBillAttachment(handle.db, target.id, { buffer: Buffer.alloc(0), filename: 'x.pdf' })).toThrow(/vazio/);
    expect(() => addBillAttachment(handle.db, target.id, { buffer: Buffer.concat([PDF, Buffer.alloc(10 * 1024 * 1024)]), filename: 'x.pdf' })).toThrow(/10 MB/);
    for (let index = 0; index < MAX_ATTACHMENTS_PER_BILL; index += 1) addBillAttachment(handle.db, target.id, { buffer: PDF, filename: `${index}.pdf` });
    expect(() => addBillAttachment(handle.db, target.id, { buffer: PDF, filename: 'extra.pdf' })).toThrow(/no máximo/);
    expect(() => addBillAttachment(handle.db, 9999, { buffer: PDF, filename: 'x.pdf' })).toThrow(/não encontrada/);
  });

  it('excluir o anexo ou a conta remove o arquivo; anexo de outra conta não é acessível', () => {
    const a = bill('A');
    const b = bill('B');
    const attachment = addBillAttachment(handle.db, a.id, { buffer: PDF, filename: 'a.pdf' });
    expect(() => getBillAttachmentFile(handle.db, b.id, attachment.id)).toThrow(/não encontrado/);
    expect(() => deleteBillAttachment(handle.db, b.id, attachment.id)).toThrow(/não encontrado/);
    deleteBillAttachment(handle.db, a.id, attachment.id);
    expect(getBill(handle.db, a.id, TODAY).attachments).toEqual([]);

    addBillAttachment(handle.db, b.id, { buffer: PDF, filename: 'b.pdf' });
    deleteBill(handle.db, b.id);
    expect((handle.sqlite.prepare('SELECT COUNT(*) AS n FROM bill_attachments').get() as { n: number }).n).toBe(0);
  });

  it('o nome do arquivo perde pastas e caracteres de controle', () => {
    expect(sanitizeFilename('C:\\Users\\x\\boleto.pdf')).toBe('boleto.pdf');
    expect(sanitizeFilename('a\u0000b\nc.pdf')).toBe('abc.pdf');
    expect(sanitizeFilename('')).toBe('anexo');
  });

  it('rotas: envio multipart, download com o tipo certo, exclusão e conferência da linha digitável', async () => {
    const target = bill();
    const app = await buildApp({ db: handle.db, logger: false });
    try {
      const boundary = 'financetestboundary';
      const payload = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="boleto.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
        PDF,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      const upload = await app.inject({
        method: 'POST',
        url: `/api/bills/${target.id}/attachments`,
        payload,
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      });
      expect(upload.statusCode).toBe(201);
      const { attachment } = upload.json() as { attachment: { id: number } };

      const download = await app.inject({ method: 'GET', url: `/api/bills/${target.id}/attachments/${attachment.id}` });
      expect(download.statusCode).toBe(200);
      expect(download.headers['content-type']).toBe('application/pdf');
      expect(download.headers['x-content-type-options']).toBe('nosniff');
      expect(download.headers['content-disposition']).toBe("inline; filename*=UTF-8''boleto.pdf");
      expect(download.rawPayload.equals(PDF)).toBe(true);

      const removed = await app.inject({ method: 'DELETE', url: `/api/bills/${target.id}/attachments/${attachment.id}` });
      expect(removed.statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: `/api/bills/${target.id}/attachments/${attachment.id}` })).statusCode).toBe(404);

      const parsed = await app.inject({ method: 'POST', url: '/api/bills/barcode/parse', payload: { barcode: validLine() } });
      expect(parsed.json()).toMatchObject({ valid: true, kind: 'bank', amountCents: 78200 });
      const invalid = await app.inject({ method: 'POST', url: '/api/bills/barcode/parse', payload: { barcode: '123' } });
      expect(invalid.json()).toMatchObject({ valid: false, error: expect.stringContaining('47 dígitos') });
    } finally {
      await app.close();
    }
  });
});
