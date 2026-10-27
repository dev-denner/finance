/**
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NfceBatchImport } from './NfceBatchImport';
import { api } from '../lib/api';
import type {
  NfceBatchImportResult,
  NfceBatchInspection,
  NfceBatchPreview,
  NfceBatchRow,
} from '../lib/types';

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
    inspectNfceBatch: vi.fn(),
    previewNfceBatch: vi.fn(),
    importNfceBatch: vi.fn(),
  },
}));

const inspection: NfceBatchInspection = {
  headers: ['url', 'observacao'],
  columns: [
    { index: 0, label: 'url', validCount: 2, totalCount: 2 },
    { index: 1, label: 'observacao', validCount: 0, totalCount: 2 },
  ],
  suggestedColumn: 0,
  dataLines: 2,
  blankLines: 0,
  tooLongLines: 0,
  limits: { fileBytes: 1048576, lines: 200, queries: 50, lineChars: 2048 },
};

const rows: NfceBatchRow[] = [
  {
    line: 2,
    state: 'RJ',
    status: 'valid',
    message: null,
    supplierName: 'Mercado Sintético',
    supplierCnpj: '12345678000195',
    invoiceNumber: '1001',
    series: '1',
    issuedAt: '2026-03-02T10:20:30-03:00',
    totalCents: 4500,
    invoiceDiscountCents: 500,
    itemCount: 3,
  },
  {
    line: 3,
    state: null,
    status: 'already-imported',
    message: 'Esta NFC-e já existe nas compras.',
    supplierName: null,
    supplierCnpj: null,
    invoiceNumber: null,
    series: null,
    issuedAt: null,
    totalCents: null,
    invoiceDiscountCents: null,
    itemCount: null,
  },
  {
    line: 4,
    state: null,
    status: 'invalid',
    message: 'URL de QR Code inválida ou fora do padrão de uma SEFAZ suportada.',
    supplierName: null,
    supplierCnpj: null,
    invoiceNumber: null,
    series: null,
    issuedAt: null,
    totalCents: null,
    invoiceDiscountCents: null,
    itemCount: null,
  },
  {
    line: 5,
    state: 'SP',
    status: 'error',
    message: 'Não foi possível consultar esta nota.',
    supplierName: null,
    supplierCnpj: null,
    invoiceNumber: null,
    series: null,
    issuedAt: null,
    totalCents: null,
    invoiceDiscountCents: null,
    itemCount: null,
  },
];

const preview: NfceBatchPreview = {
  inspection,
  rows,
  summary: {
    total: 4,
    valid: 1,
    invalid: 1,
    blank: 0,
    duplicateFile: 0,
    alreadyImported: 1,
    error: 1,
    notQueried: 0,
  },
};

const importResult: NfceBatchImportResult = {
  rows: [
    { line: 2, status: 'imported', message: null, purchaseId: 77 },
    { line: 3, status: 'duplicate', message: 'Esta NFC-e já existe nas compras.', purchaseId: 55 },
    { line: 5, status: 'error', message: 'Não foi possível consultar esta nota.', purchaseId: null },
  ],
  summary: { total: 3, imported: 1, duplicate: 1, error: 1, notQueried: 0 },
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
    root.render(
      <MemoryRouter>
        <NfceBatchImport />
      </MemoryRouter>,
    );
  });
}

function buttonByText(text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')].find(
    (element) => element.textContent?.trim() === text,
  );
  expect(button).toBeTruthy();
  return button as HTMLButtonElement;
}

async function uploadFile(file: File) {
  const input = container.querySelector('input[type=file]') as HTMLInputElement;
  expect(input).toBeTruthy();
  await act(async () => {
    Object.defineProperty(input, 'files', {
      value: { 0: file, length: 1, item: (index: number) => (index === 0 ? file : null) },
      configurable: true,
    });
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await flush();
}

async function clickButton(text: string) {
  await act(async () => {
    buttonByText(text).click();
  });
  await flush();
}

function checkboxFor(line: number): HTMLInputElement {
  const checkbox = container.querySelector(
    `input[aria-label="Selecionar linha ${line}"]`,
  ) as HTMLInputElement | null;
  expect(checkbox).toBeTruthy();
  return checkbox as HTMLInputElement;
}

const file = new File(['conteúdo sintético'], 'lote-nfce.csv', { type: 'text/csv' });

describe('NfceBatchImport', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    vi.mocked(api.inspectNfceBatch).mockResolvedValue({ inspection });
    vi.mocked(api.previewNfceBatch).mockResolvedValue(preview);
    vi.mocked(api.importNfceBatch).mockResolvedValue(importResult);
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    container?.remove();
    vi.clearAllMocks();
  });

  it('inspeciona o arquivo, mostra a prévia e importa só as linhas selecionadas', async () => {
    await mount();
    expect(container.textContent).toContain('Importar várias NFC-e (CSV ou TXT)');

    await uploadFile(file);
    expect(api.inspectNfceBatch).toHaveBeenCalledWith(file);
    expect(container.textContent).toContain('Cabeçalho detectado: url · observacao');
    expect(container.textContent).toContain('2 linha(s)');

    await clickButton('Conferir prévias');
    expect(api.previewNfceBatch).toHaveBeenCalledWith(file, 0);
    expect(container.textContent).toContain('Mercado Sintético');
    expect(container.textContent).toContain('Nº 1001 · Série 1');
    expect(container.textContent).toContain('R$ 45,00');
    expect(container.textContent).toContain('Pronta');
    expect(container.textContent).toContain('Já existe');
    expect(container.textContent).toContain('URL inválida');
    expect(container.textContent).toContain('Falha na consulta');

    await clickButton('Importar 1 selecionada(s)');
    expect(api.importNfceBatch).toHaveBeenCalledWith(file, 0, [2]);
    expect(container.textContent).toContain('Resumo da importação');
    expect(container.textContent).toContain('1 importada(s)');
    expect(container.textContent).toContain('1 com erro');
    expect(container.querySelector('a[href="/compras/77"]')).toBeTruthy();
  });

  it('mantém desmarcadas as linhas já existentes, inválidas e vazias', async () => {
    await mount();
    await uploadFile(file);
    await clickButton('Conferir prévias');

    expect(checkboxFor(2).checked).toBe(true);
    expect(checkboxFor(2).disabled).toBe(false);
    expect(checkboxFor(3).disabled).toBe(true);
    expect(checkboxFor(4).disabled).toBe(true);
    // Linha com falha na consulta pode ser tentada de novo.
    expect(checkboxFor(5).disabled).toBe(false);
    expect(checkboxFor(5).checked).toBe(false);
    expect(container.textContent).toContain('Importar 1 selecionada(s)');

    await act(async () => {
      checkboxFor(5).click();
    });
    await flush();
    expect(container.textContent).toContain('Importar 2 selecionada(s)');

    await clickButton('Importar 2 selecionada(s)');
    expect(api.importNfceBatch).toHaveBeenCalledWith(file, 0, [2, 5]);
  });

  it('troca de coluna e reinicia a prévia sem exibir URL ou chave de acesso', async () => {
    await mount();
    await uploadFile(file);
    await clickButton('Conferir prévias');
    expect(container.textContent).not.toContain('consultadfe');
    expect(container.textContent).not.toContain('p=');
    expect(container.textContent).not.toContain(
      '12345678901234567890123456789012345678901234',
    );

    const select = container.querySelector('select') as HTMLSelectElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLSelectElement.prototype,
        'value',
      )?.set;
      setter?.call(select, '1');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();

    expect(container.textContent).not.toContain('Pronta');
    await clickButton('Conferir prévias');
    expect(api.previewNfceBatch).toHaveBeenLastCalledWith(file, 1);
  });
});
