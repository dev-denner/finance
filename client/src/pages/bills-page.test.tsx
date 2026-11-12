/**
 * @vitest-environment jsdom
 *
 * Tela de contas a pagar (Módulo 1, PR4). Monta a página de verdade com
 * react-dom/client + act, com a API mockada, e confere o que é enviado ao
 * servidor em cada fluxo. Sem @testing-library, no mesmo padrão de
 * imports-page.test.tsx.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BillsPage } from './BillsPage';
import { todayISO } from '../lib/format';
import type { Bill, BillAgenda, BillListResponse, BillTemplate } from '../lib/types';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const apiMock = {
  getBills: vi.fn(),
  getBillAgenda: vi.fn(),
  listBillTemplates: vi.fn(),
  getBillTemplate: vi.fn(),
  payBill: vi.fn(),
  unpayBill: vi.fn(),
  skipBill: vi.fn(),
  unskipBill: vi.fn(),
  scheduleBill: vi.fn(),
  createBill: vi.fn(),
  updateBill: vi.fn(),
  deleteBill: vi.fn(),
  createBillTemplate: vi.fn(),
  updateBillTemplate: vi.fn(),
  deleteBillTemplate: vi.fn(),
  previewBillTemplate: vi.fn(),
};
const showToast = vi.fn();
const refreshBadge = vi.fn();

vi.mock('../lib/api', () => ({
  api: new Proxy({}, { get: (_target, key: string) => (apiMock as Record<string, unknown>)[key] }),
  errorMessage: (error: unknown) => String(error),
}));
vi.mock('../context/MetaContext', () => ({
  useMeta: () => ({
    meta: {
      categories: [{ id: 3, name: 'Moradia', color: null }],
      paymentMethods: [
        { id: 1, name: 'Conta Corrente' },
        { id: 2, name: 'Nubank' },
      ],
    },
  }),
}));
vi.mock('../context/ToastContext', () => ({ useToast: () => ({ showToast }) }));
vi.mock('../context/BillsBadgeContext', () => ({ useBillsBadge: () => ({ count: 0, refresh: refreshBadge }) }));

const TODAY = todayISO();

function bill(overrides: Partial<Bill> = {}): Bill {
  return {
    id: 1,
    templateId: null,
    sequence: null,
    description: 'Condomínio',
    amountCents: 78200,
    dueDate: TODAY,
    state: 'open',
    displayStatus: 'due_today',
    scheduledFor: null,
    paidAt: null,
    paidCents: null,
    migratedPayment: false,
    categoryId: 3,
    categoryName: 'Moradia',
    paymentMethodId: null,
    paymentMethodName: null,
    notes: null,
    payments: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function summary(): BillListResponse['summary'] {
  return {
    totalCents: 78200,
    openCents: 78200,
    paidCents: 0,
    overdueCents: 0,
    statusCounts: { overdue: 0, due_today: 1, scheduled: 0, upcoming: 0, paid: 0, skipped: 0 },
  };
}

const TEMPLATE: BillTemplate = {
  id: 9,
  description: 'Internet',
  amountCents: 9900,
  amountMinCents: null,
  amountMaxCents: null,
  categoryId: 3,
  categoryName: 'Moradia',
  paymentMethodId: null,
  recurrence: { frequency: 'monthly', interval: 1, dayOfMonth: 12, weekday: null, monthOfYear: null },
  recurrenceLabel: 'Mensal, dia 12',
  startDate: '2026-01-12',
  endDate: null,
  occurrenceCount: 6,
  active: true,
  notes: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

let container: HTMLDivElement;
let root: Root;

async function render(url = '/contas', bills: Bill[] = [bill()], agenda?: Partial<BillAgenda>) {
  apiMock.getBills.mockResolvedValue({ bills, summary: summary() });
  apiMock.getBillAgenda.mockResolvedValue({
    today: TODAY,
    days: 7,
    overdue: [],
    dueToday: [],
    upcoming: [],
    summary: summary(),
    ...agenda,
  });
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[url]}>
        <BillsPage />
      </MemoryRouter>,
    );
  });
}

function buttons(label: string): HTMLButtonElement[] {
  return [...document.querySelectorAll('button')].filter(
    (button) => button.textContent?.trim() === label || button.getAttribute('aria-label') === label,
  ) as HTMLButtonElement[];
}

async function click(element: Element) {
  await act(async () => {
    (element as HTMLElement).click();
  });
}

/** Altera um campo controlado do React (setter nativo + evento input/change). */
async function type(element: HTMLInputElement | HTMLSelectElement, value: string) {
  await act(async () => {
    const proto = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(element, value);
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  for (const fn of Object.values(apiMock)) fn.mockReset();
  showToast.mockReset();
  refreshBadge.mockReset().mockResolvedValue(undefined);
  apiMock.listBillTemplates.mockResolvedValue({ templates: [TEMPLATE] });
  apiMock.previewBillTemplate.mockResolvedValue({ dates: [] });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = '';
});

describe('tela de contas a pagar', () => {
  it('lê mês e filtros da URL (AC17) e mostra a agenda independente do mês', async () => {
    await render('/contas?year=2026&month=2&state=open&q=condo', [bill({ dueDate: '2026-02-10', displayStatus: 'overdue' })], {
      overdue: [bill({ id: 5, description: 'IPTU atrasado', dueDate: '2026-01-05', displayStatus: 'overdue' })],
    });

    expect(apiMock.getBills).toHaveBeenCalledWith(2026, 2, { state: 'open', q: 'condo', categoryId: undefined });
    expect(document.body.textContent).toContain('Fevereiro de 2026');
    expect(document.body.textContent).toContain('IPTU atrasado');
    expect((document.querySelector('input[placeholder="Buscar"]') as HTMLInputElement).value).toBe('condo');
    expect((document.querySelector('select') as HTMLSelectElement).value).toBe('open');
  });

  it('pagar sem conta padrão só marca como paga e o aviso oferece Desfazer (AC18)', async () => {
    apiMock.payBill.mockResolvedValue({ bill: bill({ state: 'paid' }) });
    apiMock.unpayBill.mockResolvedValue({ bill: bill() });
    await render();

    await click(buttons('Pagar')[0]);
    const toggle = document.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    await click(buttons('Confirmar pagamento')[0]);

    expect(apiMock.payBill).toHaveBeenCalledWith(1, { mode: 'external', paidAt: TODAY, paidCents: 78200 });
    expect(refreshBadge).toHaveBeenCalled();
    const [message, kind, options] = showToast.mock.calls.at(-1) as [string, string, { action: { label: string; onClick: () => void }; durationMs: number }];
    expect(message).toBe('Conta marcada como paga.');
    expect(kind).toBe('success');
    expect(options.action.label).toBe('Desfazer');
    expect(options.durationMs).toBe(6000);

    await act(async () => options.action.onClick());
    expect(apiMock.unpayBill).toHaveBeenCalledWith(1);
  });

  it('com conta padrão o toggle vem ligado e cria o lançamento', async () => {
    apiMock.payBill.mockResolvedValue({ bill: bill({ state: 'paid' }) });
    await render('/contas', [bill({ paymentMethodId: 2, paymentMethodName: 'Nubank' })]);

    await click(buttons('Pagar')[0]);
    expect((document.querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(true);
    expect((document.getElementById('pay-account') as HTMLSelectElement).value).toBe('2');
    await type(document.getElementById('pay-amount') as HTMLInputElement, '790,10');
    await click(buttons('Confirmar pagamento')[0]);

    expect(apiMock.payBill).toHaveBeenCalledWith(1, { mode: 'transaction', paidAt: TODAY, paidCents: 79010, paymentMethodId: 2 });
    expect(showToast.mock.calls.at(-1)?.[0]).toBe('Conta paga e lançamento registrado.');
  });

  it('valor inválido no pagamento não chama a API', async () => {
    await render();
    await click(buttons('Pagar')[0]);
    await type(document.getElementById('pay-amount') as HTMLInputElement, '1,2,3');
    await click(buttons('Confirmar pagamento')[0]);
    expect(apiMock.payBill).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Informe um valor positivo');
  });

  it('editar ocorrência de recorrência pergunta o escopo e "esta e as futuras" divide a série (AC19)', async () => {
    apiMock.updateBillTemplate.mockResolvedValue({ template: TEMPLATE });
    const occurrence = bill({ id: 4, templateId: 9, sequence: 3, description: 'Internet', amountCents: 9900, dueDate: '2026-03-12' });
    await render('/contas?year=2026&month=3', [occurrence]);

    expect(document.body.textContent).toContain('3 de 6');
    await click(buttons('Editar Internet')[0]);
    await type(document.getElementById('bill-amount') as HTMLInputElement, '109,90');
    await click(buttons('Salvar')[0]);

    expect(document.body.textContent).toContain('Aplicar a alteração a');
    await click(buttons('Esta e as futuras')[0]);
    expect(apiMock.updateBillTemplate).toHaveBeenCalledWith(
      9,
      expect.objectContaining({ amountCents: 10990, occurrenceCount: 6, recurrence: { interval: 1 } }),
      { scope: 'future', from: '2026-03-12' },
    );
    // Só o valor mudou: a âncora da regra (dia 12) fica com o servidor.
    expect(apiMock.updateBillTemplate.mock.calls[0][1]).not.toHaveProperty('startDate');
    expect(apiMock.updateBill).not.toHaveBeenCalled();
  });

  it('"só esta" altera apenas a ocorrência e fica bloqueado quando a repetição muda', async () => {
    apiMock.updateBill.mockResolvedValue({ bill: bill() });
    const occurrence = bill({ id: 4, templateId: 9, sequence: 3, description: 'Internet', amountCents: 9900, dueDate: '2026-03-12' });
    await render('/contas?year=2026&month=3', [occurrence]);

    await click(buttons('Editar Internet')[0]);
    await type(document.getElementById('bill-interval') as HTMLInputElement, '2');
    await click(buttons('Salvar')[0]);
    expect(buttons('Só esta')[0].disabled).toBe(true);

    await click(buttons('Cancelar').at(-1) as HTMLButtonElement);
    await type(document.getElementById('bill-interval') as HTMLInputElement, '1');
    await click(buttons('Salvar')[0]);
    await click(buttons('Só esta')[0]);
    expect(apiMock.updateBill).toHaveBeenCalledWith(4, expect.objectContaining({ amountCents: 9900, dueDate: '2026-03-12' }));
  });

  it('nova conta com "Repetir" e término por quantidade cria a recorrência', async () => {
    apiMock.createBillTemplate.mockResolvedValue({ template: { ...TEMPLATE, recurrenceLabel: 'Mensal, dia 5' } });
    await render('/contas', []);

    expect(document.body.textContent).toContain('Nenhuma conta neste mês');
    await click(buttons('Nova conta')[0]);
    await type(document.getElementById('bill-description') as HTMLInputElement, 'Sofá');
    await type(document.getElementById('bill-amount') as HTMLInputElement, '500');
    await type(document.getElementById('bill-due') as HTMLInputElement, '2026-04-05');
    expect((document.getElementById('bill-category') as HTMLSelectElement).value).toBe('');
    await type(document.getElementById('bill-category') as HTMLSelectElement, '3');
    await click([...document.querySelectorAll('label')].find((label) => label.textContent?.trim() === 'Repetir')!.querySelector('input')!);
    const countRadio = [...document.querySelectorAll('input[name="bill-end"]')][2] as HTMLInputElement;
    await click(countRadio);
    await type(document.querySelector('input[aria-label="Quantidade de vezes"]') as HTMLInputElement, '6');
    await click(buttons('Salvar')[0]);

    expect(apiMock.createBillTemplate).toHaveBeenCalledWith(
      expect.objectContaining({
        description: 'Sofá',
        amountCents: 50000,
        categoryId: 3,
        startDate: '2026-04-05',
        occurrenceCount: 6,
        endDate: null,
        recurrence: { frequency: 'monthly', interval: 1, dayOfMonth: 5 },
      }),
    );
    expect(apiMock.createBill).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith('Recorrência criada: Mensal, dia 5.', 'success', undefined);
  });

  it('excluir ocorrência de recorrência oferece pular só esta', async () => {
    apiMock.deleteBill.mockResolvedValue({ removed: false, skipped: true });
    await render('/contas?year=2026&month=3', [bill({ id: 4, templateId: 9, sequence: 3, description: 'Internet' })]);
    await click(buttons('Excluir Internet')[0]);
    expect(document.body.textContent).toContain('Mensal, dia 12');
    await click(buttons('Pular só esta')[0]);
    expect(apiMock.deleteBill).toHaveBeenCalledWith(4);
    expect(apiMock.deleteBillTemplate).not.toHaveBeenCalled();
  });
});
