import { describe, expect, it } from 'vitest';
import { createTestDatabase } from './helpers';
import { ensureLookup } from '../src/services/lookups';
import { importPurchase, getPurchase, listPurchases, updatePurchaseCategory, updatePurchaseItemsCategory } from '../src/services/purchases';
import { isAllowedBrowserRequest, parseRjNfceSnapshot, validateRjQrUrl, withoutReferer, type PurchaseInput } from '../src/services/rj-nfce';

const syntheticSnapshot = {
  supplierName: 'Mercado Exemplo',
  supplierCnpjText: 'CNPJ: 12.345.678/0001-95',
  generalInfo: 'EMISSÃO NORMAL Número: 12345 Série: 7 Emissão: 02/03/2026 10:20:30-03:00 - Via Consumidor 2',
  accessKeyText: '1234 5678 9012 3456 7890 1234 5678 9012 3456 7890 1234',
  grossTotalText: 'R$ 30,00',
  discountText: 'R$ 0,00',
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
    const currentV2Url = `https://consultadfe.fazenda.rj.gov.br/consultaNFCe/QRCode?p=12345678901234567890123456789012345678901234%7C2%7C2%7C123456%7C${'a'.repeat(40)}`;
    expect(validateRjQrUrl(currentV2Url).hostname).toBe('consultadfe.fazenda.rj.gov.br');
    const legacyUrl = 'http://www4.fazenda.rj.gov.br/consultaNFCe/QRCode?p=12345678901234567890123456789012345678901234%7C2%7C1%7C3%7Caaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    expect(validateRjQrUrl(legacyUrl).hostname).toBe('www4.fazenda.rj.gov.br');
    for (const url of [
      'http://consultadfe.fazenda.rj.gov.br/consultaNFCe/QRCode?p=12345678901234567890123456789012345678901234%7C3%7C1',
      'https://127.0.0.1/consultaNFCe/QRCode?p=12345678901234567890123456789012345678901234%7C3%7C1',
      'https://consultadfe.fazenda.rj.gov.br.evil.test/consultaNFCe/QRCode?p=12345678901234567890123456789012345678901234%7C3%7C1',
      `https://consultadfe.fazenda.rj.gov.br/consultaNFCe/QRCode?p=12345678901234567890123456789012345678901234%7C2%7C3%7C1%7C${'a'.repeat(40)}`,
      `https://consultadfe.fazenda.rj.gov.br/consultaNFCe/QRCode?p=12345678901234567890123456789012345678901234%7C2%7C1%7C1234567%7C${'a'.repeat(40)}`,
      `https://consultadfe.fazenda.rj.gov.br/consultaNFCe/QRCode?p=12345678901234567890123456789012345678901234%7C2%7C1%7C1%7C${'a'.repeat(39)}`,
      `https://consultadfe.fazenda.rj.gov.br/consultaNFCe/QRCode?p=12345678901234567890123456789012345678901234%7C2%7C1%7C1%7C${'g'.repeat(40)}`,
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

  it('allows the RJ result page only after the same-host redirect is upgraded to HTTPS', () => {
    const resultPage = {
      method: 'GET',
      resourceType: 'document',
      url: 'https://consultadfe.fazenda.rj.gov.br/consultaNFCe/paginas/resultadoQRCode2.faces?cid=1',
    };
    expect(isAllowedBrowserRequest(resultPage)).toBe(true);
    expect(isAllowedBrowserRequest({
      ...resultPage,
      url: resultPage.url.replace('https:', 'http:'),
    })).toBe(false);
    expect(isAllowedBrowserRequest({
      ...resultPage,
      url: 'https://example.com/consultaNFCe/paginas/resultadoQRCode2.faces?cid=1',
    })).toBe(false);
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

  it('keeps the invoice-wide discount separate from item values and net total', () => {
    const parsed = parseRjNfceSnapshot({
      ...syntheticSnapshot,
      discountText: 'R$ 5,00',
      totalText: 'R$ 25,00',
    });
    expect(parsed).toMatchObject({ totalCents: 2500, invoiceDiscountCents: 500 });
    expect(parsed.items.reduce((sum, item) => sum + item.totalCents, 0)).toBe(3000);
  });

  it('rejects a synthetic page when the invoice total arithmetic is inconsistent', () => {
    expect(() => parseRjNfceSnapshot({ ...syntheticSnapshot, totalText: 'R$ 31,00' }))
      .toThrow(/itens, descontos e total a pagar/i);
  });

  it('stores purchase and items atomically and deduplicates by access key', () => {
    const handle = createTestDatabase();
    try {
      const purchase = parseRjNfceSnapshot({
        ...syntheticSnapshot,
        discountText: 'R$ 5,00',
        totalText: 'R$ 25,00',
      });
      const first = importPurchase(handle.db, purchase);
      const second = importPurchase(handle.db, purchase);
      expect(first.duplicate).toBe(false);
      expect(second).toEqual({ id: first.id, duplicate: true });
      expect(getPurchase(handle.db, first.id)).toMatchObject({
        totalCents: 2500,
        invoiceDiscountCents: 500,
      });
      expect(getPurchase(handle.db, first.id).items).toHaveLength(2);
      expect(listPurchases(handle.db)).toMatchObject([{ totalCents: 2500, invoiceDiscountCents: 500 }]);
      expect(handle.sqlite.prepare('SELECT count(*) AS count FROM transactions').get()).toMatchObject({ count: 0 });
      expect(handle.sqlite.prepare('SELECT count(*) AS count FROM import_batches').get()).toMatchObject({ count: 0 });
    } finally { handle.sqlite.close(); }
  });

  it('salva e remove a categoria local sem alterar os itens fiscais', () => {
    const handle = createTestDatabase();
    try {
      const purchase = parseRjNfceSnapshot(syntheticSnapshot);
      const id = importPurchase(handle.db, purchase).id;
      const category = ensureLookup(handle.db, 'category', 'Mercado');
      expect(updatePurchaseCategory(handle.db, id, category.id)).toMatchObject({ categoryId: category.id, categoryName: 'Mercado' });
      expect(getPurchase(handle.db, id).items).toHaveLength(2);
      expect(updatePurchaseCategory(handle.db, id, null)).toMatchObject({ categoryId: null, categoryName: null });
      expect(() => updatePurchaseCategory(handle.db, id, 9999)).toThrow(/categoria selecionada/i);
    } finally { handle.sqlite.close(); }
  });

  it('classifica itens selecionados em lote sem alterar os dados fiscais ou movimentações', () => {
    const handle = createTestDatabase();
    try {
      const purchase = parseRjNfceSnapshot(syntheticSnapshot);
      const id = importPurchase(handle.db, purchase).id;
      const items = getPurchase(handle.db, id).items;
      const category = ensureLookup(handle.db, 'category', 'Eletrônicos');
      expect(updatePurchaseItemsCategory(handle.db, id, items.map((item) => item.id), category.id))
        .toEqual({ updated: 2 });
      expect(getPurchase(handle.db, id).items).toMatchObject([
        { id: items[0]?.id, categoryId: category.id, categoryName: 'Eletrônicos', description: 'Produto sintético A', totalCents: 2000 },
        { id: items[1]?.id, categoryId: category.id, categoryName: 'Eletrônicos', description: 'Produto sintético B', totalCents: 1000 },
      ]);
      expect(handle.sqlite.prepare('SELECT count(*) AS count FROM transactions').get()).toMatchObject({ count: 0 });
      expect(updatePurchaseItemsCategory(handle.db, id, [items[0]!.id], null)).toEqual({ updated: 1 });
      expect(getPurchase(handle.db, id).items[0]).toMatchObject({ categoryId: null, description: 'Produto sintético A', totalCents: 2000 });
    } finally { handle.sqlite.close(); }
  });

  it('rejeita atomicamente item pertencente a outra compra', () => {
    const handle = createTestDatabase();
    try {
      const purchase = parseRjNfceSnapshot(syntheticSnapshot);
      const first = importPurchase(handle.db, purchase).id;
      const second = importPurchase(handle.db, { ...purchase, accessKey: `${purchase.accessKey.slice(0, -1)}0`, invoiceNumber: '54321' }).id;
      const firstItemId = getPurchase(handle.db, first).items[0]!.id;
      const secondItemId = getPurchase(handle.db, second).items[0]!.id;
      const category = ensureLookup(handle.db, 'category', 'Eletrônicos');
      expect(() => updatePurchaseItemsCategory(handle.db, first, [firstItemId, secondItemId], category.id))
        .toThrow(/não pertencem/i);
      expect(getPurchase(handle.db, first).items[0]?.categoryId).toBeNull();
      expect(getPurchase(handle.db, second).items[0]?.categoryId).toBeNull();
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
