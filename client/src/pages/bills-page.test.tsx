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
import type { Bill, BillAgenda, BillForecast, BillListResponse, BillTemplate } from '../lib/types';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const apiMock = {
  getBills: vi.fn(),
  getBillAgenda: vi.fn(),
  getBillForecast: vi.fn(),
  listBillTemplates: vi.fn(),
  getBillTemplate: vi.fn(),
  payBill: vi.fn(),
  getBill: vi.fn(),
  parseBarcode: vi.fn(),
  readBoleto: vi.fn(),
  uploadBillAttachment: vi.fn(),
  readBarcodeFromAttachment: vi.fn(),
  deleteBillAttachment: vi.fn(),
  billAttachmentUrl: vi.fn((id: number, attachmentId: number) => `/api/bills/${id}/attachments/${attachmentId}`),
  bulkPayBills: vi.fn(),
  bulkSkipBills: vi.fn(),
  payBillsGroup: vi.fn(),
  unpayBill: vi.fn(),
  undoBillPayment: vi.fn(),
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
    partialPaidCents: 0,
    migratedPayment: false,
    categoryId: 3,
    categoryName: 'Moradia',
    paymentMethodId: null,
    paymentMethodName: null,
    notes: null,
    barcode: null,
    barcodeFormatted: null,
    payments: [],
    attachments: [],
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

async function render(
  url = '/contas',
  bills: Bill[] = [bill()],
  agenda?: Partial<BillAgenda>,
  forecastMonths: BillForecast['months'] = [],
) {
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
  apiMock.getBillForecast.mockResolvedValue({ today: TODAY, months: forecastMonths });
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
    const toggle = document.querySelector('[role="dialog"] input[type="checkbox"]') as HTMLInputElement;
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
    expect((document.querySelector('[role="dialog"] input[type="checkbox"]') as HTMLInputElement).checked).toBe(true);
    expect((document.getElementById('pay-account') as HTMLSelectElement).value).toBe('2');
    await type(document.getElementById('pay-amount') as HTMLInputElement, '790,10');
    await click(buttons('Confirmar pagamento')[0]);

    expect(apiMock.payBill).toHaveBeenCalledWith(1, { mode: 'transaction', paidAt: TODAY, paidCents: 79010, paymentMethodId: 2 });
    expect(showToast.mock.calls.at(-1)?.[0]).toBe('Conta paga e lançamento registrado.');
  });

  it('pagamento parcial mantém a conta em aberto e mostra quanto falta (sem Desfazer após o primeiro)', async () => {
    const partialPayment = { id: 7, transactionId: null, amountCents: 30000, paidAt: TODAY, origin: 'manual' as const, createdTransaction: false, paymentMethodName: null, transactionDescription: null, groupSize: 1 };
    apiMock.payBill.mockResolvedValue({ bill: bill({ partialPaidCents: 30000, payments: [partialPayment] }) });
    await render('/contas', [bill({ partialPaidCents: 30000, payments: [partialPayment] })]);

    expect(document.body.textContent).toContain('Pago R$ 300,00 de R$ 782,00 · faltam R$ 482,00');
    expect(document.querySelector('[aria-label="Desfazer pagamento de Condomínio"]')).not.toBeNull();

    await click(buttons('Pagar')[0]);
    expect((document.getElementById('pay-amount') as HTMLInputElement).value).toBe('482,00');
    const partial = [...document.querySelectorAll('label')].find((label) => label.textContent?.includes('Pagamento parcial'))?.querySelector('input') as HTMLInputElement;
    await click(partial);
    await type(document.getElementById('pay-amount') as HTMLInputElement, '100,00');
    await click(buttons('Confirmar pagamento')[0]);

    expect(apiMock.payBill).toHaveBeenCalledWith(1, { mode: 'external', paidAt: TODAY, paidCents: 10000, partial: true });
    const [message, , options] = showToast.mock.calls.at(-1) as [string, string, unknown];
    expect(message).toBe('Pagamento parcial registrado; faltam R$ 482,00.');
    expect(options).toBeUndefined();
  });

  it('mostra a previsão dos próximos meses e abre o mês clicado', async () => {
    const forecastSummary = (totalCents: number, paidCents: number, overdueCents = 0) => ({
      ...summary(), totalCents, paidCents, openCents: totalCents - paidCents, overdueCents,
    });
    await render('/contas?year=2026&month=3', [bill()], undefined, [
      { year: 2026, month: 3, from: '2026-03-01', to: '2026-03-31', summary: forecastSummary(250000, 100000, 20000) },
      { year: 2026, month: 4, from: '2026-04-01', to: '2026-04-30', summary: forecastSummary(180000, 0) },
      { year: 2026, month: 5, from: '2026-05-01', to: '2026-05-31', summary: forecastSummary(0, 0) },
    ]);

    expect(apiMock.getBillForecast).toHaveBeenCalledWith(3);
    const cards = [...document.querySelectorAll('#bills-forecast-title ~ div button')] as HTMLButtonElement[];
    expect(cards.map((card) => card.textContent?.split('R$')[0])).toEqual(['Março de 2026', 'Abril de 2026', 'Maio de 2026']);
    expect(cards[0]!.getAttribute('aria-pressed')).toBe('true');
    expect(cards[0]!.textContent).toContain('Atrasado R$ 200,00');
    expect(cards[1]!.textContent).toContain('Em aberto R$ 1.800,00');

    await click(cards[1]!);
    expect(apiMock.getBills).toHaveBeenLastCalledWith(2026, 4, expect.anything());
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
        recurrence: { frequency: 'monthly', interval: 1, dayOfMonth: 5, lastBusinessDay: false },
      }),
    );
    expect(apiMock.createBill).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith('Recorrência criada: Mensal, dia 5.', 'success', undefined);
  });

  it('recorrência mensal no último dia útil manda a opção e some ao trocar a frequência', async () => {
    apiMock.createBillTemplate.mockResolvedValue({ template: { ...TEMPLATE, recurrenceLabel: 'Mensal, último dia útil' } });
    await render('/contas', []);

    await click(buttons('Nova conta')[0]);
    await type(document.getElementById('bill-description') as HTMLInputElement, 'Salário diarista');
    await type(document.getElementById('bill-amount') as HTMLInputElement, '800');
    await type(document.getElementById('bill-due') as HTMLInputElement, '2026-04-01');
    await type(document.getElementById('bill-category') as HTMLSelectElement, '3');
    await click([...document.querySelectorAll('label')].find((label) => label.textContent?.trim() === 'Repetir')!.querySelector('input')!);
    const lastBusinessDay = () =>
      [...document.querySelectorAll('label')].find((label) => label.textContent?.includes('No último dia útil do mês'))?.querySelector('input') ?? null;

    await type(document.getElementById('bill-frequency') as HTMLSelectElement, 'weekly');
    expect(lastBusinessDay()).toBeNull();
    await type(document.getElementById('bill-frequency') as HTMLSelectElement, 'monthly');
    await click(lastBusinessDay() as HTMLInputElement);
    await click(buttons('Salvar')[0]);

    expect(apiMock.createBillTemplate).toHaveBeenCalledWith(
      expect.objectContaining({
        startDate: '2026-04-01',
        recurrence: { frequency: 'monthly', interval: 1, dayOfMonth: null, lastBusinessDay: true },
      }),
    );
    expect(showToast).toHaveBeenCalledWith('Recorrência criada: Mensal, último dia útil.', 'success', undefined);
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

describe('contas — ações em massa e atalhos', () => {
  const monthBills = () => [
    bill({ id: 1, description: 'Luz', amountCents: 18000 }),
    bill({ id: 2, description: 'Água', amountCents: 9000, partialPaidCents: 4000 }),
    bill({ id: 3, description: 'Paga', state: 'paid', displayStatus: 'paid', paidAt: TODAY, paidCents: 5000 }),
  ];

  const checkbox = (label: string) => document.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement | null;

  async function press(key: string, target: EventTarget = document.body) {
    await act(async () => {
      target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    });
  }

  it('seleciona só as contas em aberto e paga todas pelo valor que falta', async () => {
    apiMock.bulkPayBills.mockResolvedValue({ updated: 2, paidCents: 23000 });
    await render('/contas', monthBills());

    expect(checkbox('Selecionar Paga')).toBeNull();
    await click(checkbox('Selecionar as contas em aberto do mês') as HTMLInputElement);
    expect(document.body.textContent).toContain('selecionadas · R$ 230,00');

    await click(buttons('Marcar como pagas')[0]);
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog.getAttribute('aria-label')).toBe('Marcar 2 contas como pagas');
    expect(dialog.textContent).toContain('R$ 50,00');
    await type(document.getElementById('bulk-paid-at') as HTMLInputElement, '2026-03-04');
    await click([...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Marcar como pagas') as HTMLButtonElement);

    expect(apiMock.bulkPayBills).toHaveBeenCalledWith([1, 2], '2026-03-04');
    expect(showToast).toHaveBeenCalledWith('2 contas marcadas como pagas (R$ 230,00).', 'success', undefined);
    expect(document.body.textContent).not.toContain('selecionadas ·');
  });

  it('boleto agrupado: pede a conta de saída e paga todas com um lançamento só', async () => {
    apiMock.payBillsGroup.mockResolvedValue({ updated: 2, paidCents: 23000, transactionId: 50 });
    await render('/contas', monthBills());

    await click(checkbox('Selecionar as contas em aberto do mês') as HTMLInputElement);
    await click(buttons('Marcar como pagas')[0]);
    const groupToggle = [...document.querySelectorAll('[role="dialog"] label')]
      .find((label) => label.textContent?.includes('Registrar um lançamento só'))
      ?.querySelector('input') as HTMLInputElement;
    await click(groupToggle);
    // Mesma categoria nas duas: não pergunta a categoria.
    expect(document.getElementById('bulk-group-category')).toBeNull();
    const confirm = () => [...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent === 'Marcar como pagas') as HTMLButtonElement;
    await click(confirm());
    expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toBe('Escolha a conta de onde saiu o pagamento.');
    expect(apiMock.payBillsGroup).not.toHaveBeenCalled();

    await type(document.getElementById('bulk-group-account') as HTMLSelectElement, '1');
    await click(confirm());
    expect(apiMock.payBillsGroup).toHaveBeenCalledWith([1, 2], { paidAt: TODAY, paymentMethodId: 1, categoryId: null, description: null });
    expect(apiMock.bulkPayBills).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith('2 contas pagas com um lançamento de R$ 230,00.', 'success', undefined);
  });

  it('pular em massa é bloqueado com conta de pagamento parcial e envia as demais', async () => {
    apiMock.bulkSkipBills.mockResolvedValue({ updated: 1 });
    await render('/contas', monthBills());

    await click(checkbox('Selecionar Luz') as HTMLInputElement);
    await click(checkbox('Selecionar Água') as HTMLInputElement);
    await click(buttons('Pular')[0]);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Água tem pagamento parcial');
    const confirm = [...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent === 'Pular') as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    await click(buttons('Cancelar')[0]);

    await click(checkbox('Selecionar Água') as HTMLInputElement);
    await click(buttons('Pular')[0]);
    await click([...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent === 'Pular') as HTMLButtonElement);
    expect(apiMock.bulkSkipBills).toHaveBeenCalledWith([1]);
    expect(showToast).toHaveBeenCalledWith('1 conta pulada.', 'success', undefined);
  });

  it('N abre nova conta; P paga a selecionada; atalhos ignoram campos de texto', async () => {
    await render('/contas', monthBills());

    await press('p');
    expect(showToast).toHaveBeenCalledWith('Marque na lista as contas a pagar.', 'info');
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    await press('n', document.querySelector('input[placeholder="Buscar"]') as HTMLInputElement);
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    await press('n');
    expect(document.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('Nova conta a pagar');
    await click(buttons('Cancelar')[0]);

    await click(checkbox('Selecionar Luz') as HTMLInputElement);
    await press('P', checkbox('Selecionar Luz') as HTMLInputElement);
    expect(document.getElementById('pay-amount')).not.toBeNull();
    // Com um diálogo aberto, N não troca o diálogo.
    await press('n');
    expect(document.getElementById('pay-amount')).not.toBeNull();
  });
});

describe('contas — calendário do mês', () => {
  it('alterna para o calendário pela URL, abre o dia e mostra só as contas dele', async () => {
    await render('/contas?year=2026&month=3&layout=calendar', [
      bill({ id: 1, description: 'Luz', dueDate: '2026-03-02', displayStatus: 'overdue', amountCents: 18000 }),
      bill({ id: 2, description: 'Água', dueDate: '2026-03-02', displayStatus: 'overdue', amountCents: 9000 }),
      bill({ id: 3, description: 'Internet', dueDate: '2026-03-12', displayStatus: 'upcoming', amountCents: 9900 }),
    ]);

    expect(document.querySelector('[aria-pressed="true"]')?.textContent).toContain('Calendário');
    expect(document.querySelector('caption')?.textContent).toBe('Calendário de Março de 2026');
    // Sem hoje no mês, abre o primeiro dia com conta em aberto.
    expect(document.getElementById('bills-day-title')?.textContent).toBe('Vencem em 02/03/2026');
    const rows = () => [...document.querySelectorAll('tbody tr')].filter((row) => row.querySelector('td.td'));
    expect(rows().map((row) => row.textContent)).toEqual([expect.stringContaining('Luz'), expect.stringContaining('Água')]);

    const day12 = document.querySelector('button[aria-label^="Dia 12:"]') as HTMLButtonElement;
    expect(day12.getAttribute('aria-label')).toBe('Dia 12: 1 conta, previsto R$ 99,00, em aberto R$ 99,00');
    await click(day12);
    expect(day12.getAttribute('aria-pressed')).toBe('true');
    expect(document.getElementById('bills-day-title')?.textContent).toBe('Vencem em 12/03/2026');
    expect(rows().map((row) => row.textContent)).toEqual([expect.stringContaining('Internet')]);

    await click(document.querySelector('button[aria-label="Dia 13: sem contas"]') as HTMLButtonElement);
    expect(document.body.textContent).toContain('Nenhuma conta vence neste dia.');

    await click(buttons('Lista')[0]);
    expect(document.querySelector('caption')).toBeNull();
    expect(rows()).toHaveLength(3);
  });
});

describe('contas — pagamentos um a um', () => {
  const payment = (id: number, amountCents: number, paidAt: string) => ({
    id, transactionId: null, amountCents, paidAt, origin: 'manual' as const, createdTransaction: false, paymentMethodName: null, transactionDescription: null, groupSize: 1,
  });

  it('pagamento de boleto agrupado abre a lista com o aviso, mesmo sendo o único', async () => {
    const grouped = { ...payment(20, 78200, '2026-03-06'), transactionId: 50, transactionDescription: 'Boleto agrupado: Condomínio, Taxa', groupSize: 2 };
    await render('/contas', [bill({ state: 'paid', displayStatus: 'paid', paidAt: '2026-03-06', paidCents: 78200, payments: [grouped] })]);
    await click(buttons('Pagamentos de Condomínio')[0]);
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog.textContent).toContain('boleto agrupado com 2 contas');
    expect(dialog.textContent).toContain('Desfazer um boleto agrupado desfaz o pagamento de todas as contas pagas por ele.');

    apiMock.undoBillPayment.mockResolvedValue({ bill: bill() });
    await click(buttons('Desfazer pagamento de R$ 782,00 em 06/03/2026')[0]);
    expect(apiMock.undoBillPayment).toHaveBeenCalledWith(1, 20);
    expect(showToast).toHaveBeenCalledWith('Boleto agrupado desfeito: 2 contas reabertas.', 'success', undefined);
  });

  it('com mais de um pagamento, o desfazer abre a lista e desfaz só o escolhido', async () => {
    const paid = bill({
      state: 'paid', displayStatus: 'paid', paidAt: '2026-03-06', paidCents: 78200,
      payments: [payment(10, 30000, '2026-03-02'), payment(11, 48200, '2026-03-06')],
    });
    apiMock.undoBillPayment.mockResolvedValue({
      bill: bill({ partialPaidCents: 30000, payments: [payment(10, 30000, '2026-03-02')] }),
    });
    await render('/contas', [paid]);

    await click(buttons('Pagamentos de Condomínio')[0]);
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog.getAttribute('aria-label')).toBe('Pagamentos da conta');
    expect(dialog.textContent).toContain('pago R$ 782,00');
    expect(dialog.textContent).toContain('Desfazer o último pagamento');

    await click(buttons('Desfazer pagamento de R$ 482,00 em 06/03/2026')[0]);
    expect(apiMock.undoBillPayment).toHaveBeenCalledWith(1, 11);
    expect(apiMock.unpayBill).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith('Pagamento desfeito; faltam R$ 482,00.', 'success', undefined);
    // Sobrou um pagamento: o diálogo fecha.
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});

describe('contas — boleto e anexos', () => {
  const LINE = '00190000090123456789012345678901234567890123456';

  it('confere a linha digitável, oferece usar valor e vencimento do boleto e salva', async () => {
    const target = bill({ amountCents: 78200, dueDate: '2026-03-10' });
    const withLine = bill({ amountCents: 80000, dueDate: '2026-03-12', barcode: LINE, barcodeFormatted: '00190.00009 …' });
    apiMock.parseBarcode.mockImplementation((value: string) =>
      Promise.resolve(
        value.replace(/\D/g, '').length === 47
          ? { valid: true, digits: LINE, kind: 'bank', amountCents: 80000, dueDate: '2026-03-12', formatted: '00190.00009 …' }
          : { valid: false, error: 'A linha digitável tem 47 dígitos (boleto) ou 48 (conta de consumo ou tributo).' },
      ),
    );
    apiMock.updateBill.mockResolvedValue({ bill: withLine });
    apiMock.getBill.mockResolvedValue({ bill: withLine });
    await render('/contas', [target]);

    await click(buttons('Boleto e anexos de Condomínio')[0]);
    const input = document.getElementById('boleto-barcode') as HTMLInputElement;
    vi.useFakeTimers();
    try {
      await type(input, '123');
      await act(async () => {
        vi.advanceTimersByTime(400);
      });
      expect(document.querySelector('[role="dialog"]')?.textContent).toContain('47 dígitos');
      await type(input, LINE);
      await act(async () => {
        vi.advanceTimersByTime(400);
      });
    } finally {
      vi.useRealTimers();
    }
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog.textContent).toContain('Boleto bancário válido · R$ 800,00 · vence 12/03/2026');

    // Editar o código esconde o resultado anterior até a nova conferência voltar.
    vi.useFakeTimers();
    try {
      await type(input, `${LINE.slice(0, 46)}9`);
      expect(dialog.textContent).not.toContain('Boleto bancário válido');
      expect(buttons('Usar R$ 800,00 e vencimento 12/03/2026')).toHaveLength(0);
      await type(input, LINE);
      await act(async () => {
        vi.advanceTimersByTime(400);
      });
    } finally {
      vi.useRealTimers();
    }

    await click(buttons('Usar R$ 800,00 e vencimento 12/03/2026')[0]);
    expect(apiMock.updateBill).toHaveBeenCalledWith(1, { barcode: LINE, amountCents: 80000, dueDate: '2026-03-12' });
    expect(apiMock.getBill).toHaveBeenCalledWith(1);
    expect(showToast).toHaveBeenCalledWith('Conta atualizada com o valor e o vencimento do boleto.', 'success');
  });

  it('anexa, lista com link para abrir e exclui; a linha mostra quantos anexos há', async () => {
    const attachment = { id: 5, filename: 'boleto.pdf', contentType: 'application/pdf', sizeBytes: 2048, createdAt: '2026-03-01T00:00:00Z' };
    const withFile = bill({ attachments: [attachment] });
    apiMock.uploadBillAttachment.mockResolvedValue({ attachment });
    apiMock.deleteBillAttachment.mockResolvedValue({ ok: true });
    apiMock.readBarcodeFromAttachment.mockResolvedValue({ found: false });
    apiMock.getBill.mockResolvedValueOnce({ bill: withFile }).mockResolvedValueOnce({ bill: bill() });
    await render('/contas', [bill()]);

    await click(buttons('Boleto e anexos de Condomínio')[0]);
    const fileInput = document.querySelector('input[aria-label="Arquivo do anexo"]') as HTMLInputElement;
    const file = new File(['%PDF-1.4'], 'boleto.pdf', { type: 'application/pdf' });
    Object.defineProperty(fileInput, 'files', { configurable: true, value: [file] });
    await act(async () => {
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(apiMock.uploadBillAttachment).toHaveBeenCalledWith(1, file);
    // PDF numa conta sem linha digitável: tenta ler sozinho; sem achar, não incomoda com aviso.
    expect(apiMock.readBarcodeFromAttachment).toHaveBeenCalledWith(1, 5);
    expect(showToast).not.toHaveBeenCalledWith(expect.stringContaining('Não achei'), 'info');
    const link = document.querySelector('[role="dialog"] a') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/api/bills/1/attachments/5');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('2 KB');

    await click(buttons('Excluir anexo boleto.pdf')[0]);
    expect(apiMock.deleteBillAttachment).toHaveBeenCalledWith(1, 5);
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Nenhum anexo');
  });

  it('"Ler" preenche a linha digitável achada no PDF para conferir e salvar', async () => {
    const attachment = { id: 6, filename: 'boleto.pdf', contentType: 'application/pdf', sizeBytes: 900, createdAt: '2026-03-01T00:00:00Z' };
    apiMock.readBarcodeFromAttachment
      .mockResolvedValueOnce({ found: false })
      .mockResolvedValueOnce({ found: true, digits: LINE, kind: 'bank', amountCents: 78200, dueDate: null, formatted: '00190.00009 01234.567890 12345.678901 2 34567890123456' });
    apiMock.parseBarcode.mockResolvedValue({ valid: true, digits: LINE, kind: 'bank', amountCents: 78200, dueDate: null, formatted: 'x' });
    await render('/contas', [bill({ attachments: [attachment] })]);
    await click(buttons('Boleto e anexos de Condomínio')[0]);

    await click(buttons('Ler linha digitável de boleto.pdf')[0]);
    expect(showToast).toHaveBeenCalledWith('Não achei uma linha digitável no texto do PDF (um boleto escaneado não tem texto).', 'info');
    await click(buttons('Ler linha digitável de boleto.pdf')[0]);
    expect((document.getElementById('boleto-barcode') as HTMLInputElement).value).toBe('00190.00009 01234.567890 12345.678901 2 34567890123456');
    expect(showToast).toHaveBeenCalledWith('Linha digitável encontrada no PDF: confira e salve.', 'success');
    expect(apiMock.updateBill).not.toHaveBeenCalled();
  });

  it('copia a linha digitável direto da linha da conta', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    await render('/contas', [bill({ barcode: LINE, barcodeFormatted: 'x' }), bill({ id: 2, description: 'Sem boleto' })]);
    expect(buttons('Copiar linha digitável de Sem boleto')).toHaveLength(0);
    await click(buttons('Copiar linha digitável de Condomínio')[0]);
    expect(writeText).toHaveBeenCalledWith(LINE);
    expect(showToast).toHaveBeenCalledWith('Linha digitável copiada.', 'success');
  });
});

describe('contas — nova conta pelo boleto', () => {
  it('lê o PDF, preenche o formulário e, ao salvar, cria a conta com a linha e anexa o boleto', async () => {
    const LINE = '3'.repeat(47);
    apiMock.readBoleto.mockResolvedValue({
      barcode: { digits: LINE, kind: 'bank', amountCents: 150000, dueDate: '2026-11-25', formatted: 'x' },
      beneficiary: 'COLEGIO SAO PAULO LTDA',
      suggestion: { description: 'Colégio São Paulo', categoryId: 3, categoryName: 'Moradia', source: 'similar_bill', basedOn: { id: 9, description: 'Colégio São Paulo', dueDate: '2026-10-05' } },
    });
    apiMock.createBill.mockResolvedValue({ bill: bill({ id: 40 }) });
    apiMock.uploadBillAttachment.mockResolvedValue({ attachment: { id: 1 } });
    await render('/contas', []);

    await click(buttons('Nova conta')[0]);
    const input = document.querySelector('input[aria-label="Boleto em PDF"]') as HTMLInputElement;
    const file = new File(['%PDF-1.4'], 'boleto-escola.pdf', { type: 'application/pdf' });
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(apiMock.readBoleto).toHaveBeenCalledWith(file);
    expect((document.getElementById('bill-description') as HTMLInputElement).value).toBe('Colégio São Paulo');
    expect((document.getElementById('bill-amount') as HTMLInputElement).value).toBe('1500,00');
    expect((document.getElementById('bill-due') as HTMLInputElement).value).toBe('2026-11-25');
    expect((document.getElementById('bill-category') as HTMLSelectElement).value).toBe('3');
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('beneficiário parecido');

    await click(buttons('Salvar')[0]);
    expect(apiMock.createBill).toHaveBeenCalledWith(expect.objectContaining({ description: 'Colégio São Paulo', amountCents: 150000, dueDate: '2026-11-25', categoryId: 3, barcode: LINE }));
    expect(apiMock.uploadBillAttachment).toHaveBeenCalledWith(40, file);
    expect(showToast).toHaveBeenCalledWith('Conta criada com o boleto anexado.', 'success', undefined);
  });
});
