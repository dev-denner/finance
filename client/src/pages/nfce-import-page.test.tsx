/**
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NfceImportPage } from './NfceImportPage';
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
    previewPurchase: vi.fn(),
    importPurchase: vi.fn(),
  },
}));

const purchase: Purchase = {
  supplierName: 'Mercado Sintético',
  supplierCnpj: '12345678000195',
  invoiceNumber: '555',
  series: '2',
  issuedAt: '2026-03-02T10:20:30-03:00',
  totalCents: 4500,
  paymentMethod: 'Pix',
  items: [
    {
      description: 'Produto sintético',
      quantity: '1',
      unit: 'UN',
      unitPriceCents: 4500,
      discountCents: null,
      totalCents: 4500,
    },
  ],
};

const URL_QR =
  'https://consultadfe.fazenda.rj.gov.br/consultaNFCe/QRCode?p=12345678901234567890123456789012345678901234%7C3%7C1';

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
    root.render(
      <MemoryRouter>
        <NfceImportPage />
      </MemoryRouter>,
    );
  });
}

async function submitUrl(url = URL_QR) {
  const input = container.querySelector('input[type=url]') as HTMLInputElement;
  expect(input).toBeTruthy();
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )?.set;
    setter?.call(input, url);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const form = container.querySelector('form') as HTMLFormElement;
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await flush();
}

function buttonByText(text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')].find(
    (element) => element.textContent?.trim() === text,
  );
  expect(button).toBeTruthy();
  return button as HTMLButtonElement;
}

describe('NfceImportPage', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    vi.mocked(api.previewPurchase).mockResolvedValue({ purchase, alreadyImported: false });
    vi.mocked(api.importPurchase).mockResolvedValue({ id: 42, duplicate: false });
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    container?.remove();
    vi.clearAllMocks();
  });

  it('faz a previa e importa a NFC-e confirmada, oferecendo o link da compra', async () => {
    await mount();
    await submitUrl();

    expect(api.previewPurchase).toHaveBeenCalledWith(URL_QR);
    expect(container.textContent).toContain('Prévia da compra');
    expect(container.textContent).toContain('Mercado Sintético');
    expect(container.textContent).toContain('R$ 45,00');

    await act(async () => {
      buttonByText('Importar compra').click();
    });
    await flush();

    expect(api.importPurchase).toHaveBeenCalledWith(URL_QR);
    expect(container.textContent).toContain('Compra importada com sucesso');
    expect(container.querySelector('a[href="/compras/42"]')).toBeTruthy();
    expect(container.textContent).not.toContain('Prévia da compra');
  });

  it('bloqueia a importacao quando a NFC-e ja esta cadastrada', async () => {
    vi.mocked(api.previewPurchase).mockResolvedValue({ purchase, alreadyImported: true });

    await mount();
    await submitUrl();

    const button = buttonByText('Já importada');
    expect(button.disabled).toBe(true);
    expect(container.textContent).toContain('A chave de acesso já consta nas compras salvas.');
    expect(api.importPurchase).not.toHaveBeenCalled();
  });
});
