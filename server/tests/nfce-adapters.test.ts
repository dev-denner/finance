import { describe, expect, it, vi } from 'vitest';
import { previewNfceForPurchase, importNfceForPurchase, importPreviewedNfceForPurchase } from '../src/services/nfce-adapters';
import type { PurchaseInput } from '../src/services/purchase-input';
import { findPurchaseByAccessKey, importPurchase } from '../src/services/purchases';
import { createTestDatabase } from './helpers';

const accessKey = '9'.repeat(44);
const qrUrl = `https://consultadfe.fazenda.rj.gov.br/consultaNFCe/QRCode?p=${accessKey}%7C3%7C1`;

function purchase(): PurchaseInput {
  return {
    accessKey,
    supplierName: 'Fornecedor Sintético',
    supplierCnpj: '12345678000195',
    invoiceNumber: '4321',
    series: '1',
    issuedAt: '2026-01-02T12:00:00-03:00',
    totalCents: 2000,
    invoiceDiscountCents: 0,
    paymentMethod: null,
    items: [{
      description: 'Item sintético',
      quantity: '1',
      unit: 'UN',
      unitPriceCents: 2000,
      discountCents: null,
      totalCents: 2000,
    }],
  };
}

describe('deduplicação da importação individual de NFC-e', () => {
  it('retorna o ID existente na prévia sem iniciar consulta ao portal', async () => {
    const handle = createTestDatabase();
    const existing = importPurchase(handle.db, purchase());
    const beginAttempt = vi.fn();
    const preview = vi.fn(async () => purchase());
    try {
      const result = await previewNfceForPurchase(handle.db, qrUrl, {
        guard: { beginAttempt, pauseRjAfterPortalBlock: vi.fn() },
        preview,
      });
      expect(result).toEqual({
        state: 'RJ',
        previewToken: null,
        purchase: null,
        alreadyImported: true,
        existingPurchaseId: existing.id,
      });
      expect(beginAttempt).not.toHaveBeenCalled();
      expect(preview).not.toHaveBeenCalled();
    } finally {
      handle.sqlite.close();
    }
  });

  it('retorna a compra existente na importação individual antes de abrir o portal', async () => {
    const handle = createTestDatabase();
    const existing = importPurchase(handle.db, purchase());
    const beginAttempt = vi.fn();
    const preview = vi.fn(async () => purchase());
    try {
      const result = await importNfceForPurchase(handle.db, qrUrl, {
        guard: { beginAttempt, pauseRjAfterPortalBlock: vi.fn() },
        preview,
      });
      expect(result).toEqual({ id: existing.id, duplicate: true });
      expect(findPurchaseByAccessKey(handle.db, accessKey)).toBe(existing.id);
      expect(beginAttempt).not.toHaveBeenCalled();
      expect(preview).not.toHaveBeenCalled();
    } finally {
      handle.sqlite.close();
    }
  });
  it("imports the exact preview without a second portal attempt", async () => {
    const handle = createTestDatabase();
    const beginAttempt = vi.fn();
    try {
      const result = await previewNfceForPurchase(handle.db, qrUrl, { guard: { beginAttempt, pauseRjAfterPortalBlock: vi.fn() }, preview: vi.fn(async () => purchase()) });
      expect(result.previewToken).toBeTruthy();
      const imported = importPreviewedNfceForPurchase(handle.db, result.previewToken!);
      expect(imported.duplicate).toBe(false);
      expect(beginAttempt).toHaveBeenCalledTimes(1);
      expect(() => importPreviewedNfceForPurchase(handle.db, result.previewToken!)).toThrow(/prévia expirou/i);
    } finally { handle.sqlite.close(); }
  });

});
