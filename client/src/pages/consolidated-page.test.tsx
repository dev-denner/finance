/**
 * @vitest-environment jsdom
 *
 * Consolidado: os gráficos carregam à parte da aba escolhida.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConsolidatedPage } from './ConsolidatedPage';
import type { ConsolidationResponse } from '../lib/types';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const apiMock = { getConsolidation: vi.fn(), getAccountCashFlow: vi.fn() };

vi.mock('../lib/api', () => ({
  api: new Proxy({}, { get: (_target, key: string) => (apiMock as Record<string, unknown>)[key] }),
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));
vi.mock('../context/MetaContext', () => ({
  useMeta: () => ({ meta: { categories: [], paymentMethods: [], years: [2026], latestDueDate: '2026-11-10' } }),
}));

function consolidation(kind: ConsolidationResponse['kind'], monthTotals: number[]): ConsolidationResponse {
  const totalCents = monthTotals.reduce((sum, value) => sum + value, 0);
  return {
    year: 2026,
    dateField: 'due',
    kind,
    categories: [{ categoryId: 1, categoryName: 'Transferência', color: null, monthTotals, monthCounts: monthTotals.map(() => 1), totalCents, averageCents: 0, monthsWithData: 1 }],
    totals: { monthTotals, monthCounts: monthTotals.map(() => 1), totalCents, averageCents: 0, monthsWithData: 1 },
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  apiMock.getConsolidation.mockReset();
  apiMock.getAccountCashFlow.mockReset().mockResolvedValue({ year: 2026, dateField: 'due', rows: [], totals: { transactionCount: 0, inCents: 0, outCents: 0, netCents: 0, transferCents: 0, cardSettlementCents: 0 } });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('Consolidado — gráficos', () => {
  it('erro no gráfico mensal aparece mesmo com a aba de transferências carregada', async () => {
    apiMock.getConsolidation.mockImplementation((_year: number, _field: string, kind: string) =>
      kind === 'transfers' ? Promise.resolve(consolidation('transfers', [50_000])) : Promise.reject(new Error('falha de rede')),
    );
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={['/consolidado?year=2026&kind=transfers']}>
          <ConsolidatedPage />
        </MemoryRouter>,
      );
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'Não foi possível carregar o gráfico de entradas e saídas: falha de rede',
    );
    expect(container.querySelector('section[aria-label="Transferências por categoria em 2026"]')).toBeTruthy();
    expect(container.querySelector('section[aria-label^="Entradas e saídas"]')).toBeNull();
  });

  it('com receitas e despesas, mostra o gráfico mensal', async () => {
    apiMock.getConsolidation.mockImplementation((_year: number, _field: string, kind: string) =>
      Promise.resolve(consolidation(kind as ConsolidationResponse['kind'], kind === 'income' ? [300_000] : [-100_000])),
    );
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={['/consolidado?year=2026']}>
          <ConsolidatedPage />
        </MemoryRouter>,
      );
    });
    expect(container.querySelector('section[aria-label="Entradas e saídas por mês em 2026"]')).toBeTruthy();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});
