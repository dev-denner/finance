import { describe, expect, it } from 'vitest';
import { getPurchase, importPurchase } from '../src/services/purchases';
import type { PurchaseInput } from '../src/services/purchase-input';
import { createTestDatabase } from './helpers';
import {
  canonicalPaymentMethod,
  consistentPayments,
  itemCodeFrom,
  normalizeEan,
  paymentsFromRows,
  paymentsFromText,
} from '../src/services/purchase-input';

describe('dados da nota para o Módulo 4 (R7)', () => {
  it('lê o código do item no formato "(Código: X)"', () => {
    expect(itemCodeFrom('ARROZ 5KG (Código: 7890001)')).toBe('7890001');
    expect(itemCodeFrom('(codigo: ABC-12 )')).toBe('ABC-12');
    expect(itemCodeFrom('SEM CÓDIGO')).toBeNull();
  });

  it('aceita só GTIN com 8, 12, 13 ou 14 dígitos', () => {
    expect(normalizeEan('7891000100103')).toBe('7891000100103');
    expect(normalizeEan('12345678')).toBe('12345678');
    expect(normalizeEan('SEM GTIN')).toBeNull();
    expect(normalizeEan('123')).toBeNull();
    expect(normalizeEan(null)).toBeNull();
  });

  it('padroniza o nome da forma de pagamento e mantém nomes desconhecidos', () => {
    expect(canonicalPaymentMethod('CARTÃO DE CRÉDITO')).toBe('Cartão de crédito');
    expect(canonicalPaymentMethod('Vale Refeição')).toBe('Vale-refeição');
    expect(canonicalPaymentMethod('PIX')).toBe('Pix');
    expect(canonicalPaymentMethod('  Carteira   digital ')).toBe('Carteira digital');
  });

  it('lê pares forma/valor das linhas do portal e do texto da seção de pagamento', () => {
    expect(paymentsFromRows([
      { label: 'Cartão de Débito', amountText: '20,00' },
      { label: 'Dinheiro', amountText: 'R$ 1.050,00' },
      { label: 'Pix', amountText: 'sem valor' },
    ])).toEqual([
      { method: 'Cartão de débito', amountCents: 2000 },
      { method: 'Dinheiro', amountCents: 105000 },
    ]);
    expect(paymentsFromText(' Valor pago R$: Pix 30,00 Cartão de Crédito 15,50 ')).toEqual([
      { method: 'Pix', amountCents: 3000 },
      { method: 'Cartão de crédito', amountCents: 1550 },
    ]);
    expect(paymentsFromText('Valor pago R$:')).toEqual([]);
  });

  it('só guarda pagamentos que cobrem o total da nota; o excedente é troco', () => {
    const pix = { method: 'Pix', amountCents: 3000 };
    const cash = { method: 'Dinheiro', amountCents: 5000 };
    expect(consistentPayments([pix], 3000)).toEqual([pix]);
    expect(consistentPayments([cash], 4200)).toEqual([cash]);
    expect(consistentPayments([pix], 4500)).toEqual([]);
    expect(consistentPayments(undefined, 100)).toEqual([]);
    expect(consistentPayments([{ method: ' ', amountCents: 3000 }], 3000)).toEqual([]);
  });
});

function purchase(keyDigit: string, overrides: Partial<PurchaseInput> = {}): PurchaseInput {
  return {
    accessKey: keyDigit.repeat(44),
    supplierName: 'Fornecedor Sintético',
    supplierCnpj: '12345678000195',
    invoiceNumber: keyDigit,
    series: '1',
    issuedAt: '2026-10-20T12:00:00-03:00',
    totalCents: 3000,
    invoiceDiscountCents: 0,
    paymentMethod: 'Pagamento misto',
    items: [
      { description: 'Arroz', quantity: '1', unit: 'UN', unitPriceCents: 2000, discountCents: null, totalCents: 2000, code: ' A-01 ', ean: '7891000100103' },
      { description: 'Feijão', quantity: '1', unit: 'UN', unitPriceCents: 1000, discountCents: null, totalCents: 1000, code: null, ean: 'SEM GTIN' },
    ],
    ...overrides,
  };
}

describe('gravação do código do item e das formas de pagamento (R7)', () => {
  it('grava código, EAN válido e os pagamentos em ordem; o detalhe da compra devolve tudo', () => {
    const handle = createTestDatabase();
    try {
      const { id } = importPurchase(handle.db, purchase('1', {
        payments: [{ method: 'Cartão de crédito', amountCents: 2000 }, { method: 'Vale-refeição', amountCents: 1000 }],
      }));
      const detail = getPurchase(handle.db, id);
      expect(detail.items.map((item) => [item.code, item.ean])).toEqual([['A-01', '7891000100103'], [null, null]]);
      expect(detail.payments).toEqual([
        { method: 'Cartão de crédito', amountCents: 2000 },
        { method: 'Vale-refeição', amountCents: 1000 },
      ]);
    } finally { handle.sqlite.close(); }
  });

  it('pagamentos que não cobrem o total não são gravados, e a nota é importada mesmo assim', () => {
    const handle = createTestDatabase();
    try {
      const { id } = importPurchase(handle.db, purchase('2', { payments: [{ method: 'Pix', amountCents: 1000 }] }));
      expect(getPurchase(handle.db, id).payments).toEqual([]);
      const legacy = importPurchase(handle.db, purchase('3'));
      expect(getPurchase(handle.db, legacy.id).payments).toEqual([]);
      expect(handle.sqlite.prepare('SELECT COUNT(*) AS n FROM purchase_payments').get()).toEqual({ n: 0 });
    } finally { handle.sqlite.close(); }
  });
});
