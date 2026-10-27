/**
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImportsPage } from './ImportsPage';
import { api } from '../lib/api';
import type { ImportBatch, Purchase } from '../lib/types';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

vi.mock('../lib/api', () => ({
  api: {
    getImports: vi.fn(),
    listPurchases: vi.fn(),
  },
  errorMessage: (error: unknown) =>
    error instanceof Error ? error.message : 'Não foi possível concluir a operação.',
}));

const batch: ImportBatch = {
  id: 4,
  filename: 'movimentacoes.csv',
  importedAt: '2026-03-01T10:00:00.000Z',
  totalRows: 12,
  importedRows: 10,
  rejectedRows: 2,
  templateName: 'Cartão',
};

const purchase: Purchase = {
  id: 9,
  supplierName: 'Mercado Sintético',
  supplierCnpj: '12345678000195',
  invoiceNumber: '555',
  series: '2',
  issuedAt: '2026-03-02T10:20:30-03:00',
  totalCents: 4500,
  invoiceDiscountCents: 0,
  paymentMethod: 'Pix',
  importedAt: '2026-03-02T13:30:00.000Z',
  itemCount: 3,
};

let container: HTMLDivElement;
let root: Root;

async function mount() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <MemoryRouter>
        <ImportsPage />
      </MemoryRouter>,
    );
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('ImportsPage - area central', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    vi.mocked(api.getImports).mockResolvedValue({ batches: [batch] });
    vi.mocked(api.listPurchases).mockResolvedValue([purchase]);
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    container?.remove();
    vi.clearAllMocks();
  });

  it('oferece os dois fluxos e um historico unico com tipo, processado e resultado', async () => {
    await mount();

    expect(container.querySelector('a[href="/importacoes/movimentacoes"]')).toBeTruthy();
    expect(container.querySelector('a[href="/importacoes/nfce"]')).toBeTruthy();
    expect(container.querySelector('a[href="/compras"]')).toBeTruthy();
    expect(container.querySelector('a[href="/compras/9"]')).toBeTruthy();

    const text = container.textContent ?? '';
    expect(text).toContain('Importar movimentações');
    expect(text).toContain('Importar NFC-e/compras');
    expect(text).toContain('movimentacoes.csv');
    expect(text).toContain('Mercado Sintético');
    expect(text).toContain('12 linha(s)');
    expect(text).toContain('3 item(ns)');
    expect(text).toContain('Parcial');
    expect(text).toContain('Importada');
  });

  it('mostra estado vazio quando ainda nao ha importacoes', async () => {
    vi.mocked(api.getImports).mockResolvedValue({ batches: [] });
    vi.mocked(api.listPurchases).mockResolvedValue([]);

    await mount();

    expect(container.textContent).toContain('Nenhuma importação realizada ainda');
  });

  it('preserva o historico disponivel quando apenas uma fonte falha', async () => {
    vi.mocked(api.getImports).mockResolvedValue({ batches: [batch] });
    vi.mocked(api.listPurchases).mockRejectedValue(new Error('falha sintética'));

    await mount();

    const text = container.textContent ?? '';
    expect(text).toContain('Não foi possível carregar o histórico de compras');
    expect(text).toContain('movimentacoes.csv');
  });
});
