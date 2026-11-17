import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseHandle } from '../src/db/client';
import { buildApp } from '../src/app';
import { formatBarcodeDigits, parseBarcode } from '../src/lib/barcode';
import { createBill, findBeneficiary, readBoleto, suggestFromHistory, updateBill } from '../src/services/bills';
import { ensureLookup } from '../src/services/lookups';
import { bankBarcodeLine, createTestDatabase, textPdf, utilityBarcodeLine } from './helpers';

const TODAY = '2026-11-17';
let handle: DatabaseHandle;
let education: number;
let utilities: number;

beforeEach(() => {
  handle = createTestDatabase();
  education = ensureLookup(handle.db, 'category', 'Educação').id;
  utilities = ensureLookup(handle.db, 'category', 'Contas residenciais').id;
});

afterEach(() => handle.sqlite.close());

const details = (line: string) => {
  const parsed = parseBarcode(line, TODAY);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
};

describe('boleto — beneficiário', () => {
  it('lê o nome depois do rótulo, na mesma linha ou na seguinte, sem documento nem rótulos vizinhos', () => {
    expect(findBeneficiary(['Beneficiário: COLEGIO SAO PAULO LTDA CNPJ 11.222.333/0001-81'])).toBe('COLEGIO SAO PAULO LTDA');
    expect(findBeneficiary(['Local de pagamento', 'Beneficiário', 'Águas do Rio S.A. - 12.345.678/0001-90 Agência/Código 1234'])).toBe('Águas do Rio S.A.');
    expect(findBeneficiary(['Cedente: Imobiliária Centro | Data do documento 01/11/2026'])).toBe('Imobiliária Centro');
    expect(findBeneficiary(['Beneficiário 12.345.678/0001-90', '0001/12345-6'])).toBeNull();
    expect(findBeneficiary(['Pagador: Fulano'])).toBeNull();
  });
});

describe('boleto — sugestão pelo histórico', () => {
  it('conta de consumo da mesma empresa vem pelo código de barras, mesmo com descrição diferente', () => {
    const old = createBill(handle.db, { description: 'Água casa', amountCents: 9000, dueDate: '2026-10-10', categoryId: utilities }, TODAY);
    updateBill(handle.db, old.id, { barcode: utilityBarcodeLine('00000009000', '0123') }, TODAY);
    const reading = { barcode: details(utilityBarcodeLine('00000012345', '0123', '9999999999999999999999999')), beneficiary: 'CEDAE' };
    expect(suggestFromHistory(handle.db, reading)).toMatchObject({
      description: 'Água casa',
      categoryId: utilities,
      categoryName: 'Contas residenciais',
      source: 'same_company',
      basedOn: { id: old.id },
    });
    // Outra empresa não casa pelo código.
    const other = { barcode: details(utilityBarcodeLine('00000012345', '0456')), beneficiary: null };
    expect(suggestFromHistory(handle.db, other)).toBeNull();
  });

  it('beneficiário parecido com uma conta antiga sugere a descrição e a categoria dela; sem histórico, o nome do boleto', () => {
    createBill(handle.db, { description: 'Colégio São Paulo', amountCents: 150000, dueDate: '2026-09-05', categoryId: education }, TODAY);
    const recent = createBill(handle.db, { description: 'Colégio São Paulo', amountCents: 150000, dueDate: '2026-10-05', categoryId: education }, TODAY);
    expect(suggestFromHistory(handle.db, { barcode: null, beneficiary: 'COLEGIO SAO PAULO LTDA' })).toMatchObject({
      description: 'Colégio São Paulo',
      categoryId: education,
      source: 'similar_bill',
      basedOn: { id: recent.id, dueDate: '2026-10-05' },
    });
    expect(suggestFromHistory(handle.db, { barcode: null, beneficiary: 'ACADEMIA FORMA FISICA ME' })).toEqual({
      description: 'Academia Forma Fisica Me',
      categoryId: null,
      categoryName: null,
      source: 'boleto',
      basedOn: null,
    });
  });
});

describe('boleto — leitura do PDF', () => {
  it('extrai valor, vencimento, beneficiário e a sugestão; não grava nada', async () => {
    createBill(handle.db, { description: 'Colégio São Paulo', amountCents: 150000, dueDate: '2026-10-05', categoryId: education }, TODAY);
    const line = bankBarcodeLine('1641', '0000150000');
    const pdf = textPdf(['Recibo do Pagador', 'Beneficiário', 'COLEGIO SAO PAULO LTDA CNPJ 11.222.333/0001-81', formatBarcodeDigits(line)]);
    const before = handle.sqlite.prepare('SELECT COUNT(*) AS n FROM scheduled_bills').get();

    const reading = await readBoleto(handle.db, pdf, TODAY);
    expect(reading.barcode).toMatchObject({ digits: line, amountCents: 150000, dueDate: '2026-11-25' });
    expect(reading.beneficiary).toBe('COLEGIO SAO PAULO LTDA');
    expect(reading.suggestion).toMatchObject({ description: 'Colégio São Paulo', categoryId: education, source: 'similar_bill' });
    expect(handle.sqlite.prepare('SELECT COUNT(*) AS n FROM scheduled_bills').get()).toEqual(before);

    await expect(readBoleto(handle.db, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]), TODAY)).rejects.toThrow(/PDF/);
    await expect(readBoleto(handle.db, textPdf(['Sem nada útil']), TODAY)).resolves.toEqual({ barcode: null, beneficiary: null, suggestion: null });
  });

  it('a rota recebe o PDF por multipart', async () => {
    const app = await buildApp({ db: handle.db, logger: false });
    try {
      const pdf = textPdf(['Beneficiário: Energia Rio S.A.', formatBarcodeDigits(bankBarcodeLine('1641', '0000035664'))]);
      const boundary = 'financetestboundary';
      const payload = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="boleto.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
        pdf,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      const response = await app.inject({
        method: 'POST',
        url: '/api/bills/boleto/read',
        payload,
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        barcode: { amountCents: 35664 },
        beneficiary: 'Energia Rio S.A.',
        suggestion: { description: 'Energia Rio S.A.', source: 'boleto' },
      });
    } finally {
      await app.close();
    }
  });
});
