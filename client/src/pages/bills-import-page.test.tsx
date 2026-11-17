/**
 * @vitest-environment jsdom
 *
 * Tela de importação de contas por planilha, com a API mockada.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BillsImportPage } from './BillsImportPage';
import type { BillImportPreview, BillImportPreviewRow } from '../lib/types';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const apiMock = { previewBillsImport: vi.fn(), importBills: vi.fn() };
const refreshBadge = vi.fn();

vi.mock('../lib/api', () => ({
  api: new Proxy({}, { get: (_target, key: string) => (apiMock as Record<string, unknown>)[key] }),
  errorMessage: (error: unknown) => String(error),
}));
vi.mock('../context/BillsBadgeContext', () => ({ useBillsBadge: () => ({ count: 0, refresh: refreshBadge }) }));

const HEADERS = ['Despesa', 'Valor', 'Vencimento', 'Situação', 'Categoria', 'Repetição'];
const MAPPING = { description: 0, amount: 1, dueDate: 2, status: 3, category: 4, repeat: 5 };

function row(rowNumber: number, description: string, overrides: Partial<BillImportPreviewRow> = {}): BillImportPreviewRow {
  return {
    rowNumber,
    raw: {},
    values: { description, amountCents: 150000, dueDate: '2026-12-10', status: '', category: 'Moradia', recurrence: null },
    errors: [],
    duplicate: false,
    ...overrides,
  };
}

function preview(overrides: Partial<BillImportPreview> = {}): BillImportPreview {
  return {
    filename: 'contas.csv',
    sheetName: 'contas',
    headers: HEADERS,
    mapping: MAPPING,
    mappingErrors: [],
    mappingWarnings: [],
    totalRows: 4,
    validRows: 3,
    invalidRows: 1,
    duplicateRows: 1,
    rows: [
      row(2, 'Aluguel', {
        values: {
          ...row(2, 'Aluguel').values,
          recurrence: { frequency: 'monthly', interval: 1, lastBusinessDay: false, occurrenceCount: 12, label: 'Mensal, dia 10' },
        },
      }),
      row(3, 'IPVA', { errors: ['Situação: só vale para conta avulsa.'] }),
      row(4, 'Dentista', { duplicate: true }),
      row(5, 'Seguro'),
    ],
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

async function mount() {
  await act(async () => {
    root.render(
      <MemoryRouter>
        <BillsImportPage />
      </MemoryRouter>,
    );
  });
}

async function chooseFile() {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File(['Despesa;Valor'], 'contas.csv', { type: 'text/csv' });
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  return file;
}

const button = (label: string) =>
  [...container.querySelectorAll('button')].find((item) => item.textContent?.trim() === label) as HTMLButtonElement | undefined;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  apiMock.previewBillsImport.mockReset();
  apiMock.importBills.mockReset();
  refreshBadge.mockReset().mockResolvedValue(undefined);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('tela de importação de contas', () => {
  it('mostra a prévia com erro, duplicada e repetição, e importa só o que ficou marcado', async () => {
    apiMock.previewBillsImport.mockResolvedValue(preview());
    apiMock.importBills.mockResolvedValue({
      filename: 'contas.csv', totalRows: 4, importedRows: 1, rejectedRows: 1, duplicateRows: 1,
      skippedDuplicates: 1, invalidRows: 1, createdTemplates: 1, errors: [],
    });
    await mount();
    const file = await chooseFile();

    expect(apiMock.previewBillsImport).toHaveBeenCalledWith(file, undefined);
    expect(container.textContent).toContain('Mensal, dia 10 · 12x');
    expect(container.textContent).toContain('Situação: só vale para conta avulsa.');
    expect(container.textContent).toContain('Duplicada · será pulada');
    expect(container.querySelector('input[aria-label="Importar linha 3"]')).toBeNull();
    expect(button('Importar 2 contas')).toBeDefined();

    // Deixa o Seguro de fora: sobra só o Aluguel (recorrente).
    await act(async () => (container.querySelector('input[aria-label="Importar linha 5"]') as HTMLInputElement).click());
    expect(container.textContent).toContain('1 vira recorrência');
    await act(async () => button('Importar 1 conta')!.click());

    expect(apiMock.importBills).toHaveBeenCalledWith(file, { mapping: MAPPING, skipDuplicates: true, rejectedRows: [5] });
    expect(refreshBadge).toHaveBeenCalled();
    expect(container.textContent).toContain('1 conta importada');
    expect(container.textContent).toContain('1 recorrência criada · 1 duplicada pulada · 1 linha deixada de fora · 1 linha com erro');
  });

  it('trocar o mapeamento refaz a prévia; sem coluna obrigatória não importa', async () => {
    apiMock.previewBillsImport.mockResolvedValueOnce(preview());
    apiMock.previewBillsImport.mockResolvedValueOnce(
      preview({ mapping: { ...MAPPING, amount: null }, mappingErrors: ['Mapeie a coluna obrigatória Valor.'] }),
    );
    await mount();
    const file = await chooseFile();

    const amount = container.querySelector('select[aria-label="Coluna de Valor"]') as HTMLSelectElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(amount, '');
      amount.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(apiMock.previewBillsImport).toHaveBeenLastCalledWith(file, { ...MAPPING, amount: null });
    expect(container.textContent).toContain('Mapeie a coluna obrigatória Valor.');
    expect(button('Importar 2 contas')?.disabled).toBe(true);
  });
});
