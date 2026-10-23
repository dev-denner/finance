/**
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PurchasesPage } from './PurchasesPage';
import { api } from '../lib/api';
import type { Purchase } from '../lib/types';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

vi.mock('../lib/api', () => ({
  ApiError: class ApiError extends Error {
    constructor(message: string) {
      super(message);
    }
  },
  api: {
    listPurchases: vi.fn(),
    getPurchase: vi.fn(),
  },
}));

const list: Purchase[] = [
  {
    id: 1,
    supplierName: 'Mercado Sintético',
    supplierCnpj: '12345678000195',
    invoiceNumber: '111',
    series: '1',
    issuedAt: '2026-03-01T10:00:00.000Z',
    totalCents: 3000,
    paymentMethod: 'Pix',
    importedAt: '2026-03-01T11:00:00.000Z',
    itemCount: 2,
  },
  {
    id: 2,
    supplierName: 'Farmácia Exemplo',
    supplierCnpj: '98765432000110',
    invoiceNumber: '222',
    series: '2',
    issuedAt: '2026-03-02T10:00:00.000Z',
    totalCents: 1500,
    paymentMethod: 'Cartão',
    importedAt: '2026-03-02T11:00:00.000Z',
    itemCount: 1,
  },
];

const detail: Purchase = {
  ...list[0],
  accessKey: '12345678901234567890123456789012345678901234',
  items: [
    {
      id: 10,
      description: 'Produto sintético',
      quantity: '2',
      unit: 'UN',
      unitPriceCents: 1500,
      discountCents: null,
      totalCents: 3000,
    },
  ],
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

async function mount(initialEntries: string[]) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={initialEntries}>
        <Routes>
          <Route path="/compras" element={<PurchasesPage />} />
          <Route path="/compras/:id" element={<PurchasesPage />} />
        </Routes>
      </MemoryRouter>,
    );
  });
  await flush();
}

async function fillSearch(value: string) {
  const input = container.querySelector('input[type=search]') as HTMLInputElement;
  expect(input).toBeTruthy();
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('PurchasesPage', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    vi.mocked(api.listPurchases).mockResolvedValue(list);
    vi.mocked(api.getPurchase).mockResolvedValue(detail);
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    container?.remove();
    vi.clearAllMocks();
  });

  it('lista, filtra e oferece o caminho para importar uma NFC-e', async () => {
    await mount(['/compras']);

    expect(container.querySelector('a[href="/importacoes/nfce"]')).toBeTruthy();
    expect(container.textContent).toContain('Mercado Sintético');
    expect(container.textContent).toContain('Farmácia Exemplo');
    expect(container.textContent).toContain('2 de 2 compra(s)');

    await fillSearch('Farmácia');

    const text = container.textContent ?? '';
    expect(text).toContain('Farmácia Exemplo');
    expect(text).not.toContain('Mercado Sintético');
    expect(text).toContain('1 de 2 compra(s)');
  });

  it('abre os detalhes da compra por URL direta', async () => {
    await mount(['/compras/1']);

    expect(api.getPurchase).toHaveBeenCalledWith(1);
    expect(api.listPurchases).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Mercado Sintético');
    expect(container.textContent).toContain('Produto sintético');
    expect(container.textContent).toContain('R$ 30,00');
    expect(container.querySelector('a[href="/compras"]')).toBeTruthy();
    expect(container.querySelector('a[href="/importacoes/nfce"]')).toBeTruthy();
  });

  it('mostra erro de compra inexistente sem consultar a listagem', async () => {
    await mount(['/compras/invalida']);

    expect(api.getPurchase).not.toHaveBeenCalled();
    expect(api.listPurchases).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Compra não encontrada.');
  });

  it('exibe o erro da listagem e oferece tentar novamente', async () => {
    vi.mocked(api.listPurchases).mockRejectedValue(new Error('falha sintética'));

    await mount(['/compras']);

    expect(container.textContent).toContain('Não foi possível concluir a operação.');
    const retry = [...container.querySelectorAll('button')].find(
      (element) => element.textContent?.trim() === 'Tentar novamente',
    );
    expect(retry).toBeTruthy();
  });
});
