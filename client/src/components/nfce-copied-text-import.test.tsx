/**
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NfceCopiedTextImport } from './NfceCopiedTextImport';
import { api } from '../lib/api';
import type { CopiedNfceImportResult, CopiedNfcePreview } from '../lib/types';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

vi.mock('../lib/api', () => ({
  ApiError: class ApiError extends Error {},
  api: {
    previewCopiedNfceText: vi.fn(),
    importCopiedNfceText: vi.fn(),
  },
}));

const key = '12345678901234567890123456789012345678901234';
const text = 'Texto sintético da nota; chave e identificadores não são exibidos.';
const preview: CopiedNfcePreview = {
  rows: [
    {
      block: 1,
      state: 'RJ',
      status: 'ready',
      message: null,
      purchase: {
        supplierName: 'Fornecedor Sintético',
        supplierCnpj: '12345678000195',
        invoiceNumber: '12345',
        series: '7',
        issuedAt: '2026-03-02T10:20:30-03:00',
        totalCents: 1800,
        invoiceDiscountCents: 200,
        paymentMethod: 'Pix',
        items: [{ description: 'Item Sintético', quantity: '1', unit: 'UN', unitPriceCents: 1800, discountCents: null, totalCents: 1800 }],
      },
      purchaseId: null,
    },
    { block: 2, state: null, status: 'invalid', message: 'A chave da NFC-e está ausente ou inválida.', purchase: null, purchaseId: null },
  ],
  summary: { total: 2, ready: 1, invalid: 1, duplicateFile: 0, alreadyImported: 0 },
};
const imported: CopiedNfceImportResult = {
  rows: [{ block: 1, status: 'imported', message: null, purchaseId: 42 }],
  summary: { total: 1, imported: 1, duplicate: 0, error: 0 },
};
let container: HTMLDivElement;
let root: Root;

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function mount() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<MemoryRouter><NfceCopiedTextImport /></MemoryRouter>);
  });
}

async function clickButton(label: string) {
  const button = [...container.querySelectorAll('button')].find((item) => item.textContent?.trim() === label);
  expect(button).toBeTruthy();
  await act(async () => { (button as HTMLButtonElement).click(); });
  await flush();
}

describe('NfceCopiedTextImport', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    vi.mocked(api.previewCopiedNfceText).mockResolvedValue(preview);
    vi.mocked(api.importCopiedNfceText).mockResolvedValue(imported);
  });
  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    vi.clearAllMocks();
  });

  it('pré-visualiza blocos, protege identificadores e importa somente os selecionados', async () => {
    await mount();
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(textarea, text);
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await clickButton('Conferir notas copiadas');
    expect(api.previewCopiedNfceText).toHaveBeenCalledWith(text);
    expect(container.textContent).toContain('Fornecedor Sintético');
    expect(container.textContent).toContain('Item Sintético');
    expect(container.textContent).toContain('Precisa conferir');
    expect(container.textContent).not.toContain(key);
    expect(container.textContent).not.toContain('99988877766');

    const checkbox = container.querySelector('input[aria-label="Selecionar bloco 1"]') as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    await clickButton('Importar 1 nota(s)');
    expect(api.importCopiedNfceText).toHaveBeenCalledWith(text, [1]);
    expect(container.querySelector('a[href="/compras/42"]')).toBeTruthy();
    expect(container.textContent).toContain('Importadas: 1');
  });
});
