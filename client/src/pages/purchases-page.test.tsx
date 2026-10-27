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
    updatePurchaseCategory: vi.fn(),
    getPurchaseReconciliationCandidates: vi.fn(),
    reconcilePurchase: vi.fn(),
    undoPurchaseReconciliation: vi.fn(),
    updatePurchaseItemsCategory: vi.fn(),
    createLookup: vi.fn(),
  },
}));

vi.mock('../context/MetaContext', () => ({
  useMeta: () => ({ meta: { categories: [{ id: 4, name: 'Mercado', color: '#22aa66' }] }, loading: false, error: null, refresh: vi.fn() }),
}));

vi.mock('../context/ToastContext', () => ({
  useToast: () => ({ showToast: vi.fn() }),
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
    invoiceDiscountCents: 0,
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
    invoiceDiscountCents: 0,
    paymentMethod: 'Cartão',
    importedAt: '2026-03-02T11:00:00.000Z',
    itemCount: 1,
  },
];

const detail: Purchase = {
  ...list[0],
  invoiceDiscountCents: 500,
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
    vi.mocked(api.updatePurchaseCategory).mockResolvedValue({ ...list[0], categoryId: 4, categoryName: 'Mercado', categoryColor: '#22aa66' });
    vi.mocked(api.getPurchaseReconciliationCandidates).mockResolvedValue({ toleranceDays: 7, linkedMovement: null, candidates: [], settlements: [], wallets: [], totalCents: 3000, settledCents: 0, linkedTransactionIds: [] });
    vi.mocked(api.reconcilePurchase).mockResolvedValue({ ...detail, transactionId: 77, reconciledAt: '2026-10-23T12:00:00Z', categoryId: 4 });
    vi.mocked(api.undoPurchaseReconciliation).mockResolvedValue(detail);
    vi.mocked(api.updatePurchaseItemsCategory).mockResolvedValue({ updated: 1 });
    vi.mocked(api.createLookup).mockResolvedValue({ id: 5, name: 'Eletrônicos', normalizedName: 'eletronicos', color: '#3b82f6', classification: null, usageCount: 0, createdAt: '2026-10-23T00:00:00.000Z' });
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

  it('filtra por categoria e salva a classificação local da compra', async () => {
    await mount(['/compras']);

    const categorySelect = container.querySelector('#purchase-category-1') as HTMLSelectElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set;
      setter?.call(categorySelect, '4');
      categorySelect.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();

    expect(api.updatePurchaseCategory).toHaveBeenCalledWith(1, 4);
    expect(container.textContent).toContain('Mercado');

    const filter = container.querySelector('[aria-label="Categoria das compras"]') as HTMLSelectElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set;
      setter?.call(filter, '4');
      filter.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(container.textContent).toContain('1 de 2 compra(s)');
    expect(container.textContent).toContain('Mercado Sintético');
    expect(container.textContent).not.toContain('Farmácia Exemplo');
  });

  it('abre os detalhes da compra por URL direta', async () => {
    await mount(['/compras/1']);

    expect(api.getPurchase).toHaveBeenCalledWith(1);
    expect(api.listPurchases).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Mercado Sintético');
    expect(container.textContent).toContain('Produto sintético');
    expect(container.textContent).toContain('R$ 30,00');
    expect(container.textContent).toContain('Desconto na nota');
    expect(container.textContent).toContain('R$ 5,00');
    expect(container.querySelector('a[href="/compras"]')).toBeTruthy();
    expect(container.querySelector('a[href="/importacoes/nfce"]')).toBeTruthy();
  });

  it('seleciona um item, aplica categoria e permite criar categoria rapidamente', async () => {
    await mount(['/compras/1']);

    const checkbox = container.querySelector('input[aria-label="Selecionar Produto sintético"]') as HTMLInputElement;
    await act(async () => { checkbox.click(); });
    const bulkSelect = container.querySelector('[aria-label="Categoria para os itens selecionados"]') as HTMLSelectElement;
    expect(bulkSelect).toBeTruthy();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(bulkSelect), 'value')?.set;
      setter?.call(bulkSelect, '4');
      bulkSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const apply = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Aplicar categoria')) as HTMLButtonElement;
    await act(async () => { apply.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();
    expect(api.updatePurchaseItemsCategory).toHaveBeenCalledWith(1, [10], 4);
    await act(async () => { checkbox.click(); });

    const newCategory = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Nova categoria')) as HTMLButtonElement;
    await act(async () => { newCategory.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const nameInput = document.body.querySelector('input[placeholder="Ex.: Higiene pessoal"]') as HTMLInputElement;
    expect(nameInput).toBeTruthy();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      setter?.call(nameInput, 'Eletrônicos');
      nameInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const create = [...document.body.querySelectorAll('button')].find((button) => button.textContent?.includes('Criar categoria')) as HTMLButtonElement;
    await act(async () => { create.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();
    expect(api.createLookup).toHaveBeenCalledWith('category', 'Eletrônicos', '#3b82f6');
    expect(api.updatePurchaseItemsCategory).toHaveBeenLastCalledWith(1, [10], 5);
  });

  it('revisa sugestão por data/valor, pede confirmação e pode desfazer preservando a movimentação', async () => {
    const candidate = {
      transactionId: 77,
      purchaseDate: '2026-03-01',
      dueDate: '2026-03-10',
      description: 'Compra por cartão sintética',
      amountCents: -3000,
      paymentMethodName: 'Cartão',
      categoryId: 4,
      categoryName: 'Mercado',
      categoryColor: '#22aa66',
      dayDistance: 0,
    };
    vi.mocked(api.getPurchaseReconciliationCandidates)
      .mockResolvedValueOnce({ toleranceDays: 7, linkedMovement: null, candidates: [candidate], settlements: [], wallets: [], totalCents: 3000, settledCents: 0, linkedTransactionIds: [] })
      .mockResolvedValueOnce({ toleranceDays: 7, linkedMovement: { ...candidate }, candidates: [], settlements: [{ id: 1, transactionId: 77, paymentMethodId: 2, paymentMethodName: 'Cartão', amountCents: 3000, settlementType: 'movement', effectiveDate: '2026-03-01' }], wallets: [], totalCents: 3000, settledCents: 3000, linkedTransactionIds: [77] });
    vi.mocked(api.reconcilePurchase).mockResolvedValue({
      ...detail, transactionId: 77, reconciledAt: '2026-10-23T12:00:00Z', categoryId: 4,
      items: detail.items?.map((item) => ({ ...item, categoryId: 4, categoryName: 'Mercado' })),
    });

    await mount(['/compras/1']);
    const find = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Buscar pagamentos')) as HTMLButtonElement;
    await act(async () => { find.click(); });
    await flush();
    expect(container.textContent).toContain('Compra por cartão sintética');
    expect(container.textContent).toContain('mesmo dia');

    const candidateCheckbox = container.querySelector('input[type=checkbox]') as HTMLInputElement;
    await act(async () => { candidateCheckbox.click(); });
    const review = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Revisar pagamentos')) as HTMLButtonElement;
    await act(async () => { review.click(); });
    const category = [...document.body.querySelectorAll('select')].at(-1) as HTMLSelectElement;
    await act(async () => { Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set?.call(category, '4'); category.dispatchEvent(new Event('change', { bubbles: true })); });
    const confirm = [...document.body.querySelectorAll('button')].find((button) => button.textContent?.includes('Confirmar conciliação')) as HTMLButtonElement;
    await act(async () => { confirm.click(); });
    await flush();
    expect(api.reconcilePurchase).toHaveBeenCalledWith(1, { transactionIds: [77], walletPayments: [], balanceAdjustments: [], categoryId: 4 });
    expect(container.textContent).toContain('Movimentação #77 · Cartão');

    const undo = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Desfazer conciliação')) as HTMLButtonElement;
    await act(async () => { undo.click(); });
    const confirmUndo = [...document.body.querySelectorAll('button')].filter((button) => button.textContent?.includes('Desfazer conciliação')).at(-1) as HTMLButtonElement;
    await act(async () => { confirmUndo.click(); });
    await flush();
    expect(api.undoPurchaseReconciliation).toHaveBeenCalledWith(1);
    expect(container.textContent).not.toContain('Movimentação #77 · Cartão');
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
