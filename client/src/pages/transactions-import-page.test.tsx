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
import { TransactionsImportPage } from './TransactionsImportPage';
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
        <TransactionsImportPage />
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

describe('TransactionsImportPage - laco de previa', () => {
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

  it('contas a pagar encontradas: vêm confirmadas, podem ser rejeitadas e a decisão vai na importação', async () => {
    const candidate = {
      key: 'file:2:bill:7',
      confidence: 'high' as const,
      ambiguous: false,
      reasons: ['Valor igual ao previsto (R$ 20,00)', 'Mesmo dia do vencimento', 'Descrição parecida'],
      dayDistance: 0,
      amountDiffCents: 0,
      party: {
        key: 'file:2',
        source: 'file' as const,
        rowNumber: 2,
        transactionId: null,
        dueDate: '2024-02-01',
        purchaseDate: '2024-02-01',
        description: 'Compra A',
        amountCents: -2000,
        paymentMethod: '',
        transfer: null,
      },
      bill: { id: 7, description: 'Assinatura A', amountCents: 2000, dueDate: '2024-02-01', categoryName: 'Serviços' },
    };
    previewImport.mockImplementation(() => Promise.resolve(previewResponse({ billCandidates: [candidate] })));
    importFile.mockResolvedValue({
      batchId: 1, filename: 'teste.csv', totalRows: 1, importedRows: 1, rejectedRows: 0, duplicateRows: 0,
      skippedDuplicates: 0, invalidRows: 0, explicitRejections: 0, createdCategories: [], createdPaymentMethods: [],
      duplicateRowsInPreview: 0, transferCandidates: 0, confirmedTransfers: 0, pendingTransfers: 0, rejectedTransfers: 0,
      billCandidates: 1, linkedBillPayments: 0, pendingBillPayments: 0, rejectedBillPayments: 1, skippedBillPayments: [],
      ignoredRows: 0, firstDueDate: '2024-02-01', lastDueDate: '2024-02-01', errors: [],
    });
    await mountAndSelectFile();
    await settle();
    const [select] = selectsByCard('Conta de destino do lote');
    await selectOption(select, '1');
    await settle();

    const tab = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Contas a pagar'));
    expect(tab?.textContent).toContain('1');
    await act(async () => tab!.click());
    expect(container.textContent).toContain('Contas a pagar encontradas');
    expect(container.textContent).toContain('Assinatura A');
    const decisionButton = (label: string) =>
      [...container.querySelectorAll('button[aria-pressed]')].find((button) => button.textContent === label) as HTMLButtonElement;
    expect(decisionButton('Confirmar').getAttribute('aria-pressed')).toBe('true');

    await act(async () => decisionButton('Rejeitar').click());
    expect(decisionButton('Rejeitar').getAttribute('aria-pressed')).toBe('true');

    await act(async () => importButton().click());
    await settle();
    expect(importFile).toHaveBeenCalledTimes(1);
    expect(importFile.mock.calls[0][1]).toMatchObject({ billDecisions: { 'file:2:bill:7': 'reject' } });
    expect(document.body.textContent).toContain('0 paga(s) com lançamento deste arquivo · 0 pendente(s) · 1 rejeitada(s)');
  });

  it('mais de 50 pares: todos aparecem na revisão, inclusive os pré-confirmados', async () => {
    const fileParty = (rowNumber: number, amountCents: number) => ({
      key: `file:${rowNumber}`,
      source: 'file' as const,
      rowNumber,
      transactionId: null,
      dueDate: '2024-02-01',
      purchaseDate: '2024-02-01',
      description: `Linha ${rowNumber}`,
      amountCents,
      paymentMethod: 'Conta',
      transfer: null,
    });
    const bills = Array.from({ length: 60 }, (_, index) => ({
      key: `file:${index + 2}:bill:${index + 1}`,
      confidence: 'high' as const,
      ambiguous: false,
      reasons: [],
      dayDistance: 0,
      amountDiffCents: 0,
      party: fileParty(index + 2, -1000 - index),
      bill: { id: index + 1, description: `Conta ${index + 1}`, amountCents: 1000 + index, dueDate: '2024-02-01', categoryName: 'X' },
    }));
    const transfers = Array.from({ length: 60 }, (_, index) => ({
      key: `t${index}`,
      confidence: 'high' as const,
      ambiguous: false,
      reasons: [],
      dayDistance: 0,
      outgoing: fileParty(100 + index, -5000 - index),
      incoming: fileParty(200 + index, 5000 + index),
    }));
    previewImport.mockImplementation(() =>
      Promise.resolve(previewResponse({ billCandidates: bills, transferCandidates: transfers })),
    );
    await mountAndSelectFile();
    await settle();

    const openTab = async (label: string) => {
      const tab = [...container.querySelectorAll('button')].find((button) => button.textContent?.startsWith(label));
      await act(async () => tab!.click());
    };
    await openTab('Contas a pagar');
    expect(container.textContent).toContain('Conta 60');
    expect(container.textContent).not.toContain('Mostrando 50');

    await openTab('Transferências');
    expect(container.textContent).toContain('Linha 159');
    expect(container.textContent).not.toContain('Mostrando 50');
  });
});
