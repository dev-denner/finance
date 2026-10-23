import { describe, expect, it } from 'vitest';
import { createTestDatabase } from './helpers';
import { importPurchase, getPurchase, listPurchases } from '../src/services/purchases';
import { isAllowedBrowserRequest, parseRjNfceSnapshot, validateRjQrUrl, withoutReferer, type PurchaseInput } from '../src/services/rj-nfce';

const syntheticSnapshot = {
  supplierName: 'Mercado Exemplo',
  supplierCnpjText: 'CNPJ: 12.345.678/0001-95',
  generalInfo: 'EMISSÃO NORMAL Número: 12345 Série: 7 Emissão: 02/03/2026 10:20:30-03:00 - Via Consumidor 2',
  accessKeyText: '1234 5678 9012 3456 7890 1234 5678 9012 3456 7890 1234',
  totalText: 'R$ 30,00',
  paymentMethod: 'Cartão de Crédito',
  items: [
    { description: 'Produto sintético A', quantityText: 'Qtde.: 2', unitText: 'UN: UN', unitPriceText: 'R$ 10,00', discountText: null, totalText: 'R$ 20,00' },
    { description: 'Produto sintético B', quantityText: 'Qtde.: 1', unitText: 'UN: UN', unitPriceText: 'R$ 10,00', discountText: 'R$ 0,00', totalText: 'R$ 10,00' },
  ],
};

describe('RJ NFC-e parser and purchases', () => {
  it('accepts only the official QR URL shape', () => {
    expect(validateRjQrUrl('https://consultadfe.fazenda.rj.gov.br/consultaNFCe/QRCode?p=12345678901234567890123456789012345678901234%7C3%7C1').hostname)
      .toBe('consultadfe.fazenda.rj.gov.br');
    const legacyUrl = 'http://www4.fazenda.rj.gov.br/consultaNFCe/QRCode?p=12345678901234567890123456789012345678901234%7C2%7C1%7C3%7Caaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    expect(validateRjQrUrl(legacyUrl).hostname).toBe('www4.fazenda.rj.gov.br');
    for (const url of [
      'http://consultadfe.fazenda.rj.gov.br/consultaNFCe/QRCode?p=12345678901234567890123456789012345678901234%7C3%7C1',
      'https://127.0.0.1/consultaNFCe/QRCode?p=12345678901234567890123456789012345678901234%7C3%7C1',
      'https://consultadfe.fazenda.rj.gov.br.evil.test/consultaNFCe/QRCode?p=12345678901234567890123456789012345678901234%7C3%7C1',
    ]) expect(() => validateRjQrUrl(url)).toThrow();
    expect(() => validateRjQrUrl(legacyUrl.replace('www4.fazenda.rj.gov.br', 'www4.fazenda.rj.gov.br.evil.test'))).toThrow();
    expect(() => validateRjQrUrl(legacyUrl.replace('http:', 'https:'))).toThrow();
  });

  it('allows only the exact jQuery CDN script and strips its Referer header', () => {
    const assetRequest = {
      url: 'https://code.jquery.com/jquery-1.9.1.js',
      method: 'GET',
      resourceType: 'script',
    };
    expect(isAllowedBrowserRequest(assetRequest)).toBe(true);
    expect(isAllowedBrowserRequest({
      url: 'http://www4.fazenda.rj.gov.br/consultaNFCe/QRCode?p=12345678901234567890123456789012345678901234%7C2%7C1%7C3%7Caaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      method: 'GET',
      resourceType: 'document',
    })).toBe(true);
    for (const request of [
      { ...assetRequest, url: 'https://code.jquery.com/jquery-1.9.1.js?x=1' },
      { ...assetRequest, url: 'https://code.jquery.com/jquery-3.7.1.js' },
      { ...assetRequest, url: 'https://code.jquery.com/jquery-1.9.1.js.evil.test' },
      { ...assetRequest, method: 'POST' },
      { ...assetRequest, resourceType: 'document' },
      { ...assetRequest, url: 'https://www.google-analytics.com/analytics.js' },
    ]) expect(isAllowedBrowserRequest(request)).toBe(false);
    expect(withoutReferer({ referer: 'https://example.test/private?key=secret', accept: '*/*' }))
      .toEqual({ accept: '*/*' });
  });

  it('parses unit prices rendered with one decimal place by the RJ portal', () => {
    const snapshot = { ...syntheticSnapshot, items: syntheticSnapshot.items.map((item, index) =>
      index === 0 ? { ...item, unitPriceText: 'R$ 10,0' } : item) };
    expect(parseRjNfceSnapshot(snapshot).items[0]?.unitPriceCents).toBe(1000);
  });

  it('maps the synthetic RJ DOM fields and checks item totals', () => {
    const parsed = parseRjNfceSnapshot(syntheticSnapshot);
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items[0]).toMatchObject({ quantity: '2', unit: 'UN', unitPriceCents: 1000, totalCents: 2000 });
    expect(parsed.totalCents).toBe(3000);
    expect(parsed.paymentMethod).toBe('Cartão de Crédito');
    expect(parsed.issuedAt).toBe('2026-03-02T10:20:30-03:00');
    expect('consumerCpf' in parsed).toBe(false);
  });

  it('rejects a synthetic page when item totals disagree with the note total', () => {
    expect(() => parseRjNfceSnapshot({ ...syntheticSnapshot, totalText: 'R$ 31,00' })).toThrow(/soma dos itens/i);
  });

  it('stores purchase and items atomically and deduplicates by access key', () => {
    const handle = createTestDatabase();
    try {
      const purchase = parseRjNfceSnapshot(syntheticSnapshot);
      const first = importPurchase(handle.db, purchase);
      const second = importPurchase(handle.db, purchase);
      expect(first.duplicate).toBe(false);
      expect(second).toEqual({ id: first.id, duplicate: true });
      expect(getPurchase(handle.db, first.id).items).toHaveLength(2);
      expect(listPurchases(handle.db)).toHaveLength(1);
      expect(handle.sqlite.prepare('SELECT count(*) AS count FROM transactions').get()).toMatchObject({ count: 0 });
      expect(handle.sqlite.prepare('SELECT count(*) AS count FROM import_batches').get()).toMatchObject({ count: 0 });
    } finally { handle.sqlite.close(); }
  });

  it('does not leave a purchase behind if item insertion fails', () => {
    const handle = createTestDatabase();
    try {
      const purchase: PurchaseInput = parseRjNfceSnapshot(syntheticSnapshot);
      const item = purchase.items[0];
      purchase.items = [item, { ...item, description: 'Duplicado de posição' }];
      // Use a trigger that forces the second item insert to fail inside the SQL transaction.
      handle.sqlite.exec("CREATE TRIGGER fail_purchase_item BEFORE INSERT ON purchase_items WHEN NEW.position = 2 BEGIN SELECT RAISE(ABORT, 'synthetic'); END");
      expect(() => importPurchase(handle.db, purchase)).toThrow();
      expect(handle.sqlite.prepare('SELECT count(*) AS count FROM purchases').get()).toMatchObject({ count: 0 });
    } finally { handle.sqlite.close(); }
  });
});
