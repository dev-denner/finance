/**
 * @vitest-environment jsdom
 *
 * Regressão do loop de prévia (Addendo 4).
 *
 * O defeito: a tela gravava a chave de identidade da prévia com
 * `JSON.stringify(options)` e comparava, no efeito de sincronização, com
 * `importIdentityKey(...)`. As duas serializações nunca coincidiam (ordem das
 * chaves e `undefined` x `null`), então o efeito reagendava a prévia
 * indefinidamente e o botão Importar permanecia desabilitado.
 *
 * Este teste monta o componente de verdade (react-dom/client + act) e conta as
 * chamadas reais de `api.previewImport`. Não usa @testing-library: apenas
 * `react`, `react-dom` e `jsdom`.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImportsPage } from './ImportsPage';
import type { ImportPreview } from '../lib/types';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const previewImport = vi.fn();
const importFile = vi.fn();

vi.mock('../lib/api', () => ({
  api: {
    previewImport: (...args: unknown[]) => previewImport(...args),
    importFile: (...args: unknown[]) => importFile(...args),
    getImports: vi.fn().mockResolvedValue({ batches: [] }),
    listMappingTemplates: vi.fn().mockResolvedValue({ templates: [] }),
    saveMappingTemplate: vi.fn().mockResolvedValue({ template: {} }),
    deleteMappingTemplate: vi.fn().mockResolvedValue(undefined),
    getInstallmentRecovery: vi.fn().mockResolvedValue({ proposals: [] }),
    applyInstallmentRecovery: vi.fn().mockResolvedValue({ applied: 0 }),
  },
  errorMessage: (error: unknown) => String(error),
}));

vi.mock('../context/MetaContext', () => ({
  useMeta: () => ({
    meta: {
      categories: [{ id: 10, name: 'Supermercado', classification: 'despesa' }],
      paymentMethods: [{ id: 1, name: 'Conta Teste', classification: 'despesa' }],
    },
    refresh: vi.fn(),
  }),
}));

vi.mock('../context/ToastContext', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));

function previewResponse(overrides: Partial<ImportPreview> = {}): ImportPreview {
  return {
    filename: 'teste.csv',
    sheetName: 'Sheet1',
    headers: ['Data compra', 'Lançamento', 'Categoria', 'Valor'],
    mapping: {
      purchaseDate: 0,
      dueDate: null,
      description: 1,
      amount: 2,
      paymentMethod: null,
      installments: null,
      category: 3,
      transfer: null,
    },
    mappingErrors: [],
    mappingWarnings: [],
    appliedTemplate: null,
    totalRows: 1,
    validRows: 1,
    invalidRows: 0,
    duplicateRows: 0,
    rows: [
      {
        rowNumber: 2,
        raw: {} as never,
        values: {
          purchaseDate: '2024-02-01',
          purchaseDateSource: 'file',
          dueDate: '2024-02-01',
          dueDateSource: 'file',
          description: 'Compra A',
          amountCents: 2000,
          paymentMethod: null,
          installmentNumber: null,
          installmentTotal: null,
          installmentSource: null,
          installmentOriginal: null,
          category: 'OUTROS',
          transfer: null,
          estimatedFirstInstallmentDate: null,
          cashPurchase: false,
        },
        errors: [],
        issues: [],
        duplicate: null,
        suggestions: [],
        transferCandidate: null,
        categorySuggestion: {
          sourceCategory: 'OUTROS',
          sourceNormalized: 'outros',
          targetCategoryId: null,
          targetCategoryName: null,
          confidence: 'low',
          reason: 'sem correspondência',
          method: 'none',
          ambiguous: false,
          alternatives: [],
        },
      },
    ],
    transferCandidates: [],
    transferToleranceDays: 3,
    categorySuggestions: [
      {
        sourceCategory: 'OUTROS',
        sourceNormalized: 'outros',
        count: 1,
        targetCategoryId: null,
        targetCategoryName: null,
        confidence: 'low',
        reason: 'sem correspondência',
        method: 'none',
        ambiguous: false,
        alternatives: [],
      },
    ],
    ...overrides,
  } as ImportPreview;
}

let container: HTMLDivElement;
let root: Root;

function makeFile() {
  return new File(['Data compra;Lançamento;Categoria;Valor\n'], 'teste.csv', {
    type: 'text/csv',
  });
}

async function mountAndSelectFile(file = makeFile()) {
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

  const input = container.querySelector('input[type=file]') as HTMLInputElement;
  expect(input).toBeTruthy();
  await act(async () => {
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

/**
 * Deixa o debounce de 300 ms e as promises pendentes resolverem.
 * Avança em fatias: a resposta resolve, o React re-renderiza e o próximo
 * timer é agendado dentro da mesma janela — como acontece no navegador.
 */
async function settle(ms = 500) {
  const slice = 100;
  for (let elapsed = 0; elapsed < ms; elapsed += slice) {
    await act(async () => {
      vi.advanceTimersByTime(slice);
      await Promise.resolve();
      await Promise.resolve();
    });
  }
}

function selectsByCard(text: string): HTMLSelectElement[] {
  return [...container.querySelectorAll('select')].filter((element) =>
    element.closest('.card')?.textContent?.includes(text),
  ) as HTMLSelectElement[];
}

async function selectOption(select: HTMLSelectElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLSelectElement.prototype,
      'value',
    )?.set;
    setter?.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

function importButton(): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')].find((element) =>
    /^Importar /.test(element.textContent ?? ''),
  );
  expect(button).toBeTruthy();
  return button as HTMLButtonElement;
}

describe('ImportsPage - laco de previa', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    previewImport.mockReset();
    importFile.mockReset();
    // Resposta nova a cada chamada: o servidor devolve um objeto distinto por
    // requisição, e é isso que faz o estado (e o efeito) reprocessarem. Um
    // mock com o mesmo objeto hides a re-render e esconderia o laço.
    previewImport.mockImplementation(() => Promise.resolve(previewResponse()));
    importFile.mockResolvedValue({ importedRows: 1, rejectedRows: 0, explicitRejections: 0 });
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    container?.remove();
    vi.useRealTimers();
  });

  it('a previa estabiliza: uma requisicao inicial e nenhuma repeticao', async () => {
    await mountAndSelectFile();
    await settle();

    const afterFirst = previewImport.mock.calls.length;
    expect(afterFirst).toBeGreaterThan(0);

    // Aguarda sem nenhuma interacao: nada novo pode ser disparado.
    await settle(5000);
    expect(previewImport.mock.calls.length).toBe(afterFirst);
  });

  it('o laco nao repete a requisicao indefinidamente', async () => {
    await mountAndSelectFile();
    await settle(10_000);
    // Com o defeito, a contagem crescia a cada ciclo de efeito (uma previa
    // por rodada de timers).
    expect(previewImport.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it('trocar a conta de destino produz exatamente uma nova previa', async () => {
    await mountAndSelectFile();
    await settle();
    const before = previewImport.mock.calls.length;

    const [select] = selectsByCard('Conta de destino do lote');
    expect(select).toBeTruthy();
    await selectOption(select, '1');
    await settle();

    expect(previewImport.mock.calls.length).toBe(before + 1);
    await settle(5000);
    expect(previewImport.mock.calls.length).toBe(before + 1);
  });

  it('trocar a decisao de categoria produz exatamente uma nova previa', async () => {
    await mountAndSelectFile();
    await settle();
    const before = previewImport.mock.calls.length;

    const [select] = selectsByCard('Sugest');
    expect(select).toBeTruthy();
    await selectOption(select, 'cat:10');
    await settle();

    expect(previewImport.mock.calls.length).toBe(before + 1);
    await settle(5000);
    expect(previewImport.mock.calls.length).toBe(before + 1);
  });

  it('uma resposta antiga nao sobrescreve uma mais recente', async () => {
    const deferred: { resolve?: (value: ImportPreview) => void }[] = [];
    previewImport.mockImplementation(
      () =>
        new Promise<ImportPreview>((resolve) => {
          deferred.push({ resolve });
        }),
    );

    await mountAndSelectFile();
    await settle(400);
    expect(deferred.length).toBeGreaterThanOrEqual(1);

    // Resolve as respostas na ordem inversa: a ultima recebida e a mais antiga.
    const pending = [...deferred];
    for (let i = pending.length - 1; i >= 0; i -= 1) {
      pending[i].resolve?.(previewResponse());
      await settle(400);
    }
    await settle(2000);

    // A tela continua consistente e nao fica em estado de carregamento eterno.
    expect(importButton()).toBeTruthy();
  });

  it('o botao Importar habilita quando a previa esta sincronizada', async () => {
    await mountAndSelectFile();
    await settle();

    // A linha esta sem conta: a conta de destino e obrigatoria.
    const [select] = selectsByCard('Conta de destino do lote');
    expect(select).toBeTruthy();
    expect(importButton().disabled).toBe(true);

    await selectOption(select, '1');
    await settle();

    expect(importButton().disabled).toBe(false);
  });
});
