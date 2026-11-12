import { afterEach, describe, expect, it } from 'vitest';
import { createTestDatabase } from './helpers';
import {
  importCopiedNfceText,
  previewCopiedNfceText,
} from '../src/services/nfce-copied-text';
import { importPurchase } from '../src/services/purchases';

function keyWithCheckDigit(base: string): string {
  let weight = 2;
  let sum = 0;
  for (let index = 42; index >= 0; index -= 1) {
    sum += Number(base[index]) * weight;
    weight = weight === 9 ? 2 : weight + 1;
  }
  const remainder = sum % 11;
  return base + String(remainder < 2 ? 0 : 11 - remainder);
}

const supplierCnpj = '12345678000195';
const accessKey = keyWithCheckDigit('33' + '2603' + supplierCnpj + '65' + '007' + '000012345' + '1' + '12345678');

function receipt(overrides: { gross?: string; discount?: string; payable?: string; key?: string } = {}): string {
  const gross = overrides.gross ?? '20,00';
  const discount = overrides.discount ?? '2,00';
  const payable = overrides.payable ?? '18,00';
  const key = overrides.key ?? accessKey;
  return [
    'Mercado Sintético LTDA',
    'CNPJ: 12.345.678/0001-95',
    'Rua de Teste, 100, Centro, RJ',
    'Filtrar itens...',
    'Produto de teste A (Código: 1001 )',
    'Qtde.:1 UN: UN Vl. Unit.: 10,00 Vl. Total',
    '10,00',
    'Produto de teste B (Código: 1002 )',
    'Qtde.:0,5 UN: KG Vl. Unit.: 20,0000 Vl. Total',
    '10,00',
    'Qtd. total de itens:2',
    'Valor total R$:' + gross,
    'Descontos R$:' + discount,
    'Valor a pagar R$:' + payable,
    'Forma de pagamento: Valor pago R$: Pix ' + payable,
    'Troco 0,00',
    'EMISSÃO NORMAL',
    'Número: 12345 Série: 7 Emissão: 02/03/2026 10:20:30 - Via Consumidor 2',
    'Protocolo de Autorização: 0000000000',
    'Chave de acesso:',
    key.match(/.{1,4}/g)?.join(' ') ?? key,
    'Consumidor CPF: 999.888.777-66',
    'DOC: 111-222-333',
  ].join('\n');
}

describe('importação local de texto copiado da NFC-e', () => {
  const handles: ReturnType<typeof createTestDatabase>[] = [];
  const db = () => {
    const handle = createTestDatabase();
    handles.push(handle);
    return handle;
  };

  afterEach(() => {
    for (const handle of handles.splice(0)) handle.sqlite.close();
  });

  it('interpreta dados fiscais e itens e não devolve chave ou identificador do consumidor', () => {
    const handle = db();
    const result = previewCopiedNfceText(handle.db, receipt());
    expect(result.summary).toEqual({ total: 1, ready: 1, invalid: 0, duplicateFile: 0, alreadyImported: 0 });
    const purchase = result.rows[0]?.purchase;
    expect(purchase).toMatchObject({
      supplierName: 'Mercado Sintético LTDA',
      supplierCnpj: supplierCnpj,
      invoiceNumber: '12345',
      series: '7',
      issuedAt: '2026-03-02T10:20:30-03:00',
      totalCents: 1800,
      invoiceDiscountCents: 200,
      paymentMethod: 'Pix',
    });
    expect(purchase?.items).toHaveLength(2);
    expect(purchase?.items[1]).toMatchObject({
      quantity: '0.5',
      unit: 'KG',
      unitPriceCents: 2000,
      totalCents: 1000,
    });
    const response = JSON.stringify(result);
    expect(response).not.toContain(accessKey);
    expect(response).not.toContain('99988877766');
    expect(response).not.toContain('111222333');
  });

  it('confere soma, desconto e total; rejeita bloco com total incompatível', () => {
    const handle = db();
    const result = previewCopiedNfceText(handle.db, receipt({ payable: '17,99' }));
    expect(result.rows[0]).toMatchObject({ status: 'invalid', purchase: null });
    expect(result.rows[0]?.message).toContain('não conferem');
  });

  it('divide blocos por linhas de hífens e marca chaves repetidas sem confundir itens iguais', () => {
    const handle = db();
    const result = previewCopiedNfceText(handle.db, receipt() + '\n\n---\n\n' + receipt());
    expect(result.rows.map((row) => row.status)).toEqual(['ready', 'duplicate-file']);
    expect(result.summary.duplicateFile).toBe(1);
  });

  it('não reimporta nota já existente e retorna link lógico para a compra', () => {
    const handle = db();
    const first = previewCopiedNfceText(handle.db, receipt()).rows[0]?.purchase;
    expect(first).not.toBeNull();
    const imported = importPurchase(handle.db, { ...first!, accessKey });
    const preview = previewCopiedNfceText(handle.db, receipt());
    expect(preview.rows[0]).toMatchObject({ status: 'already-imported', purchaseId: imported.id, purchase: null });
    const result = importCopiedNfceText(handle.db, receipt(), [1]);
    expect(result.summary).toMatchObject({ imported: 0, duplicate: 1, error: 0 });
  });

  it('marca páginas incompletas como inválidas sem consultar nenhum portal', () => {
    const handle = db();
    const incomplete = receipt().replace(/Chave de acesso:[\s\S]*$/, 'A consulta não apresentou uma nota fiscal válida.');
    const result = previewCopiedNfceText(handle.db, incomplete);
    expect(result.rows[0]).toMatchObject({ status: 'invalid', purchase: null });
    expect(result.rows[0]?.message).toContain('chave');
  });

  it('importa notas confirmadas em transação pelo serviço existente', () => {
    const handle = db();
    const preview = previewCopiedNfceText(handle.db, receipt());
    expect(preview.rows[0]?.status).toBe('ready');
    const result = importCopiedNfceText(handle.db, receipt(), [1]);
    expect(result.summary).toEqual({ total: 1, imported: 1, duplicate: 0, error: 0 });
    const repeated = importCopiedNfceText(handle.db, receipt(), [1]);
    expect(repeated.summary).toEqual({ total: 1, imported: 0, duplicate: 1, error: 0 });
    expect(handle.sqlite.prepare('SELECT count(*) AS count FROM transactions').get()).toMatchObject({ count: 0 });
  });
});
