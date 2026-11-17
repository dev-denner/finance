/**
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { monthlyFlow } from '../../lib/charts';
import type { ConsolidationResponse } from '../../lib/types';
import { CategoryBars } from './CategoryBars';
import { ChartCard } from './ChartCard';
import { MonthlyFlowChart } from './MonthlyFlowChart';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const totals = (monthTotals: number[]): Pick<ConsolidationResponse, 'totals'> => ({
  totals: { monthTotals, monthCounts: [], totalCents: 0, averageCents: 0, monthsWithData: 0 },
});

describe('gráficos', () => {
  it('fluxo mensal: 24 colunas, linha do saldo e valores do mês ao focar', async () => {
    const rows = monthlyFlow(totals([300_000, 120_000]), totals([-100_000, -150_000]));
    await act(async () => root.render(<MonthlyFlowChart rows={rows} year={2026} />));
    const svg = container.querySelector('svg') as SVGSVGElement;
    expect(svg.getAttribute('aria-label')).toBe('Entradas, saídas e saldo por mês em 2026');
    // Colunas com valor desenhadas; meses zerados não desenham nada.
    expect([...svg.querySelectorAll('path')].filter((path) => path.getAttribute('d')).length).toBe(4);
    expect(svg.querySelectorAll('polyline')).toHaveLength(1);

    const february = svg.querySelectorAll('rect[tabindex="0"]')[1];
    expect(february.getAttribute('aria-label')).toBe('Fevereiro: entradas R$ 1.200,00, saídas R$ 1.500,00, saldo -R$ 300,00');
    await act(async () => {
      february.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    });
    const tooltip = container.querySelector('[role="status"]') as HTMLElement;
    expect(tooltip.textContent).toContain('Fevereiro de 2026');
    expect(tooltip.textContent).toContain('-R$ 300,00Saldo do mês');
  });

  it('cartão alterna entre gráfico e tabela; legenda só com mais de uma série', async () => {
    await act(async () =>
      root.render(
        <ChartCard title="Teste" legend={[{ label: 'Única', color: 'red', shape: 'box' }]} table={<p>tabela</p>}>
          <p>grafico</p>
        </ChartCard>,
      ),
    );
    expect(container.textContent).toContain('grafico');
    expect(container.textContent).not.toContain('Única');
    await act(async () => (container.querySelector('button') as HTMLButtonElement).click());
    expect(container.textContent).toContain('tabela');
    expect(container.querySelector('button')?.getAttribute('aria-pressed')).toBe('true');
  });

  it('barras por categoria: valor na ponta, participação ao focar e "Outras" em cinza', async () => {
    const items = [
      { key: '1', label: 'Moradia', cents: 150_000, share: 0.75, categoryId: 1 },
      { key: 'other', label: 'Outras (3)', cents: 50_000, share: 0.25, categoryId: null },
    ];
    await act(async () => root.render(<CategoryBars items={items} />));
    expect(container.textContent).toContain('R$ 1.500,00');
    const rows = container.querySelectorAll('[aria-label]');
    expect(rows[0].getAttribute('aria-label')).toBe('Moradia: R$ 1.500,00, 75% do total');
    await act(async () => {
      rows[1].dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    });
    expect(container.textContent).toContain('· 25%');
    const bars = container.querySelectorAll('span[aria-hidden="true"]') as NodeListOf<HTMLSpanElement>;
    expect(bars[1].style.background).toBe('var(--chart-other)');
  });
});
