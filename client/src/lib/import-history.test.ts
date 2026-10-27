import { describe, expect, it } from 'vitest';
import { buildImportHistory } from './import-history';
import type { ImportBatch, Purchase } from './types';

function batch(overrides: Partial<ImportBatch> = {}): ImportBatch {
  return {
    id: 1,
    filename: 'planilha.csv',
    importedAt: '2026-03-01T10:00:00.000Z',
    totalRows: 10,
    importedRows: 10,
    rejectedRows: 0,
    templateName: null,
    ...overrides,
  };
}

function purchase(overrides: Partial<Purchase> = {}): Purchase {
  return {
    id: 7,
    supplierName: 'Mercado Sintético',
    supplierCnpj: '12345678000195',
    invoiceNumber: '12345',
    series: '7',
    issuedAt: '2026-03-02T10:20:30-03:00',
    totalCents: 3000,
    invoiceDiscountCents: 0,
    paymentMethod: 'Cartão de Crédito',
    importedAt: '2026-03-02T13:30:00.000Z',
    itemCount: 3,
    ...overrides,
  };
}

describe('buildImportHistory', () => {
  it('combina lotes e compras em uma linha do tempo decrescente', () => {
    const entries = buildImportHistory([batch()], [purchase()]);

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      id: 'purchase-7',
      kind: 'purchase',
      kindLabel: 'Compras',
      title: 'Mercado Sintético',
      quantityLabel: '3 item(ns)',
      status: 'success',
      statusLabel: 'Importada',
      href: '/compras/7',
    });
    expect(entries[1]).toMatchObject({
      id: 'transactions-1',
      kind: 'transactions',
      kindLabel: 'Movimentações',
      title: 'planilha.csv',
      quantityLabel: '10 linha(s)',
      status: 'success',
      statusLabel: 'Concluída',
    });
  });

  it('distingue lote parcial e lote sem nenhuma linha importada', () => {
    const entries = buildImportHistory(
      [
        batch({ id: 2, importedRows: 8, rejectedRows: 2 }),
        batch({
          id: 3,
          importedAt: '2026-02-01T10:00:00.000Z',
          importedRows: 0,
          rejectedRows: 4,
          totalRows: 4,
        }),
      ],
      [],
    );

    expect(entries[0]).toMatchObject({ status: 'partial', statusLabel: 'Parcial' });
    expect(entries[0].statusDetail).toContain('2 rejeitada(s)');
    expect(entries[1]).toMatchObject({
      status: 'warning',
      statusLabel: 'Sem importação',
    });
  });

  it('não inventa eventos para compras sem identificador persistido', () => {
    const entries = buildImportHistory([], [purchase({ id: undefined })]);
    expect(entries).toEqual([]);
  });
});
