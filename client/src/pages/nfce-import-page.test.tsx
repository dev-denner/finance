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
    previewNfcePdf: vi.fn(),
    importNfcePdf: vi.fn(),
  },
}));

const purchase: Purchase = {
  supplierName: 'Mercado Sintético',
  supplierCnpj: '12345678000195',
  invoiceNumber: '555',
  series: '2',
  issuedAt: '2026-03-02T10:20:30-03:00',
  totalCents: 4500,
  invoiceDiscountCents: 500,
  paymentMethod: 'Pix',
  items: [
    {
      description: 'Produto sintético',
      quantity: '1',
      unit: 'UN',
      unitPriceCents: 5000,
      discountCents: null,
      totalCents: 5000,
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
    vi.mocked(api.previewPurchase).mockResolvedValue({ state: 'RJ', purchase, alreadyImported: false, existingPurchaseId: null });
    vi.mocked(api.importPurchase).mockResolvedValue({ id: 42, duplicate: false });
    vi.mocked(api.previewNfcePdf).mockResolvedValue({ state: "RJ", purchase, alreadyImported: false, existingPurchaseId: null });
    vi.mocked(api.importNfcePdf).mockResolvedValue({ id: 42, duplicate: false });
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
    expect(container.textContent).toContain('SEFAZ-RJ');
    expect(container.textContent).toContain('Mercado Sintético');
    expect(container.textContent).toContain('Desconto na nota:');
    expect(container.textContent).toContain('R$ 5,00');
    expect(container.textContent).toContain('Total a pagar:');
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

  it('pré-visualiza e importa PDF usando o arquivo conferido', async () => {
    await mount();
    const file = new File(["pdf sintético"], "nota-sintetica.pdf", { type: "application/pdf" });
    const input = container.querySelector("input[type=file]") as HTMLInputElement;
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
    const forms = container.querySelectorAll("form");
    await act(async () => { forms[1]!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    await flush();
    expect(api.previewNfcePdf).toHaveBeenCalledWith(file);
    expect(container.textContent).toContain("Prévia da compra");
    await act(async () => { buttonByText("Importar compra").click(); });
    await flush();
    expect(api.importNfcePdf).toHaveBeenCalledWith(file);
    expect(container.textContent).toContain("Compra importada com sucesso.");
  });

  it('mostra a compra existente sem prévia fiscal ou nova consulta ao portal', async () => {
    vi.mocked(api.previewPurchase).mockResolvedValue({ state: 'SP', purchase: null, alreadyImported: true, existingPurchaseId: 73 });

    await mount();
    await submitUrl();

    expect(container.textContent).toContain('Esta NFC-e já foi importada. A consulta ao portal foi evitada.');
    expect(container.textContent).not.toContain('Prévia da compra');
    expect(container.querySelector('a[href="/compras/73"]')).toBeTruthy();
    expect(api.importPurchase).not.toHaveBeenCalled();
  });
});
