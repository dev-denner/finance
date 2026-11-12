/**
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

vi.mock('./components/Layout', async () => {
  const { Outlet } = await import('react-router-dom');
  return { Layout: () => <Outlet /> };
});

vi.mock('./pages/ImportsPage', () => ({ ImportsPage: () => <div>rota-importacoes</div> }));
vi.mock('./pages/TransactionsImportPage', () => ({
  TransactionsImportPage: () => <div>rota-importar-movimentacoes</div>,
}));
vi.mock('./pages/NfceImportPage', () => ({
  NfceImportPage: () => <div>rota-importar-nfce</div>,
}));
vi.mock('./pages/PurchasesPage', async () => {
  const { useParams } = await import('react-router-dom');
  return {
    PurchasesPage: () => <div>rota-compras:{useParams().id ?? 'lista'}</div>,
  };
});
vi.mock('./pages/TransactionsPage', () => ({
  TransactionsPage: () => <div>rota-movimentacoes</div>,
}));
vi.mock('./pages/BillsPage', () => ({ BillsPage: () => <div>rota-contas</div> }));
vi.mock('./pages/ConsolidatedPage', () => ({
  ConsolidatedPage: () => <div>rota-consolidado</div>,
}));
vi.mock('./pages/ReconciliationPage', () => ({
  ReconciliationPage: () => <div>rota-conciliacao</div>,
}));
vi.mock('./pages/LookupsPage', () => ({ LookupsPage: () => <div>rota-cadastros</div> }));

let container: HTMLDivElement;
let root: Root;

async function mount(path: string) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>,
    );
  });
}

describe('App - rotas da reorganizacao', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    container?.remove();
  });

  it.each([
    ['/importacoes', 'rota-importacoes'],
    ['/importacoes/movimentacoes', 'rota-importar-movimentacoes'],
    ['/importacoes/nfce', 'rota-importar-nfce'],
    ['/compras', 'rota-compras:lista'],
    ['/compras/12', 'rota-compras:12'],
    ['/lancamentos', 'rota-movimentacoes'],
    ['/movimentacoes', 'rota-movimentacoes'],
  ])('renderiza %s', async (path, expected) => {
    await mount(path);
    expect(container.textContent).toContain(expected);
  });
});
