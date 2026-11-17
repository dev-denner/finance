import { describe, expect, it } from 'vitest';
import {
  calendarWeeks,
  defaultCalendarDay,
  billsShortcut,
  bulkSelection,
  badgeCount,
  billFormFrom,
  billsViewParams,
  centsToInput,
  daysBetween,
  emptyBillForm,
  futureEditPlan,
  monthLabel,
  nextDayIso,
  parseBillsView,
  parseCentsInput,
  recurrenceFrom,
  sequenceLabel,
  shiftMonth,
  statusInfo,
  templateInputFrom,
  validateBillForm,
  billNote,
  forecastCards,
  remainingCents,
} from './bills-view';
import type { Bill, BillTemplate } from './types';

const TODAY = '2026-03-10';

function bill(overrides: Partial<Bill> = {}): Bill {
  return {
    id: 1,
    templateId: null,
    sequence: null,
    description: 'Condomínio',
    amountCents: 78200,
    dueDate: '2026-03-15',
    state: 'open',
    displayStatus: 'upcoming',
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
    payments: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function template(overrides: Partial<BillTemplate> = {}): BillTemplate {
  return {
    id: 7,
    description: 'Sofá',
    amountCents: 50000,
    amountMinCents: null,
    amountMaxCents: null,
    categoryId: 3,
    categoryName: 'Casa',
    paymentMethodId: 2,
    recurrence: { frequency: 'monthly', interval: 1, dayOfMonth: 15, weekday: null, monthOfYear: null },
    recurrenceLabel: 'Mensal, dia 15',
    startDate: '2026-01-15',
    endDate: null,
    occurrenceCount: 6,
    active: true,
    notes: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('datas', () => {
  it('conta dias corridos e navega entre meses', () => {
    expect(daysBetween('2026-02-27', '2026-03-02')).toBe(3);
    expect(daysBetween('2026-03-10', '2026-03-01')).toBe(-9);
    expect(shiftMonth(2026, 1, -1)).toEqual({ year: 2025, month: 12 });
    expect(shiftMonth(2026, 12, 1)).toEqual({ year: 2027, month: 1 });
    expect(monthLabel(2026, 3)).toMatch(/^Março de 2026$/i);
  });
});

describe('parseCentsInput', () => {
  it('aceita formatos brasileiros e ponto decimal simples', () => {
    expect(parseCentsInput('1.234,56')).toBe(123456);
    expect(parseCentsInput('R$ 782,00')).toBe(78200);
    expect(parseCentsInput('782')).toBe(78200);
    expect(parseCentsInput('782,5')).toBe(78250);
    expect(parseCentsInput('1234.56')).toBe(123456);
    expect(parseCentsInput('1.234')).toBe(123400);
  });

  it('recusa vazio, zero, negativo e ambíguo', () => {
    for (const text of ['', '0', '0,00', '-10', '1,2,3', '12,345', '1.23.4', 'abc', '1.2345']) {
      expect(parseCentsInput(text)).toBeNull();
    }
  });

  it('centsToInput é o inverso para edição', () => {
    expect(centsToInput(123456)).toBe('1234,56');
    expect(parseCentsInput(centsToInput(905))).toBe(905);
  });
});

describe('statusInfo', () => {
  it('rótulo e tom por situação', () => {
    expect(statusInfo(bill({ displayStatus: 'overdue', dueDate: '2026-03-09' }), TODAY)).toEqual({ label: 'Atrasada há 1 dia', tone: 'danger' });
    expect(statusInfo(bill({ displayStatus: 'overdue', dueDate: '2026-03-01' }), TODAY).label).toBe('Atrasada há 9 dias');
    expect(statusInfo(bill({ displayStatus: 'due_today' }), TODAY).tone).toBe('warning');
    expect(statusInfo(bill({ displayStatus: 'scheduled', scheduledFor: '2026-03-14' }), TODAY).label).toBe('Agendada 14/03');
    expect(statusInfo(bill({ displayStatus: 'upcoming', dueDate: '2026-03-11' }), TODAY).label).toBe('Vence amanhã');
    expect(statusInfo(bill({ displayStatus: 'upcoming', dueDate: '2026-03-15' }), TODAY).label).toBe('Em 5 dias');
    expect(statusInfo(bill({ displayStatus: 'paid', paidAt: '2026-03-08' }), TODAY)).toEqual({ label: 'Paga 08/03', tone: 'success' });
    expect(statusInfo(bill({ displayStatus: 'skipped' }), TODAY).tone).toBe('muted');
  });

  it('"N de T" só com quantidade definida; contagem do menu', () => {
    expect(sequenceLabel(bill({ templateId: 7, sequence: 3 }), template())).toBe('3 de 6');
    expect(sequenceLabel(bill({ templateId: 7, sequence: 3 }), template({ occurrenceCount: null }))).toBeNull();
    expect(sequenceLabel(bill(), undefined)).toBeNull();
    expect(badgeCount({ overdue: [bill()], dueToday: [bill(), bill()] })).toBe(3);
    expect(badgeCount(null)).toBe(0);
  });
});

describe('estado na URL (AC17)', () => {
  it('lê parâmetros válidos e cai no mês corrente quando inválidos', () => {
    expect(parseBillsView(new URLSearchParams('year=2025&month=12&state=paid&q=luz&categoryId=4'), TODAY)).toEqual({
      year: 2025,
      month: 12,
      state: 'paid',
      q: 'luz',
      categoryId: 4,
      layout: 'list',
    });
    expect(parseBillsView(new URLSearchParams('year=2025&month=13&state=xx&categoryId=-1'), TODAY)).toEqual({
      year: 2026,
      month: 3,
      state: 'all',
      q: '',
      categoryId: null,
      layout: 'list',
    });
  });

  it('grava só o que difere do padrão e é ida e volta', () => {
    expect(billsViewParams({ year: 2026, month: 3, state: 'all', q: ' ', categoryId: null, layout: 'list' }, TODAY)).toEqual({});
    const view = { year: 2025, month: 11, state: 'open' as const, q: 'condo', categoryId: 2, layout: 'calendar' as const };
    const params = billsViewParams(view, TODAY);
    expect(params).toEqual({ year: '2025', month: '11', state: 'open', q: 'condo', categoryId: '2', layout: 'calendar' });
    expect(parseBillsView(new URLSearchParams(params), TODAY)).toEqual(view);
  });
});

describe('formulário', () => {
  it('valida campos obrigatórios e término da recorrência', () => {
    const empty = emptyBillForm(TODAY, null);
    expect(Object.keys(validateBillForm(empty)).sort()).toEqual(['amount', 'categoryId', 'description']);

    const repeating = {
      ...emptyBillForm(TODAY, 3),
      description: 'Sofá',
      amount: '500',
      repeat: true,
      interval: '0',
      endMode: 'count' as const,
      occurrenceCount: '0',
    };
    expect(validateBillForm(repeating)).toEqual({
      interval: 'Use um número de 1 a 120.',
      occurrenceCount: 'Use um número de 1 a 600.',
    });
    expect(validateBillForm({ ...repeating, interval: '1', endMode: 'date', endDate: '2026-01-01' }).endDate).toMatch(/depois/);
  });

  it('recorrência deriva o dia (e o mês, se anual) da primeira data', () => {
    expect(recurrenceFrom({ dueDate: '2026-01-31', frequency: 'monthly', interval: '1' })).toEqual({ frequency: 'monthly', interval: 1, dayOfMonth: 31, lastBusinessDay: false });
    expect(recurrenceFrom({ dueDate: '2026-04-05', frequency: 'yearly', interval: '1' })).toEqual({ frequency: 'yearly', interval: 1, dayOfMonth: 5, monthOfYear: 4, lastBusinessDay: false });
    expect(recurrenceFrom({ dueDate: '2026-04-05', frequency: 'weekly', interval: '2' })).toEqual({ frequency: 'weekly', interval: 2, weekday: null, lastBusinessDay: false });
    // Último dia útil: o dia sai da regra, não da data; ignorado fora do mensal.
    expect(recurrenceFrom({ dueDate: '2026-01-10', frequency: 'monthly', interval: '1', lastBusinessDay: true })).toEqual({ frequency: 'monthly', interval: 1, dayOfMonth: null, lastBusinessDay: true });
    expect(recurrenceFrom({ dueDate: '2026-01-10', frequency: 'weekly', interval: '1', lastBusinessDay: true })).toMatchObject({ frequency: 'weekly', lastBusinessDay: false });
  });

  it('monta o payload da recorrência conforme o término escolhido', () => {
    const form = { ...emptyBillForm(TODAY, 3), description: ' Sofá ', amount: '1.000,00', dueDate: '2026-03-15', repeat: true, endMode: 'count' as const, occurrenceCount: '6' };
    expect(templateInputFrom(form)).toMatchObject({
      description: 'Sofá',
      amountCents: 100000,
      startDate: '2026-03-15',
      occurrenceCount: 6,
      endDate: null,
      recurrence: { frequency: 'monthly', dayOfMonth: 15 },
    });
    expect(templateInputFrom({ ...form, endMode: 'never' })).toMatchObject({ occurrenceCount: null, endDate: null });
  });

  it('carrega o formulário de uma ocorrência e da sua recorrência', () => {
    const form = billFormFrom(bill({ templateId: 7, sequence: 3, notes: 'x', paymentMethodId: 2 }), template());
    expect(form).toMatchObject({ amount: '782,00', repeat: true, endMode: 'count', occurrenceCount: '6', paymentMethodId: 2, notes: 'x' });
    expect(billFormFrom(bill()).repeat).toBe(false);
  });
});

describe('futureEditPlan ("esta e as futuras")', () => {
  const day31 = template({
    description: 'Aluguel',
    amountCents: 150000,
    recurrence: { frequency: 'monthly', interval: 1, dayOfMonth: 31, weekday: null, monthOfYear: null },
    startDate: '2026-01-31',
    occurrenceCount: null,
  });
  const february = bill({ templateId: 7, sequence: 2, description: 'Aluguel', amountCents: 150000, dueDate: '2026-02-28' });

  it('só o valor mudou: mantém a âncora do dia 31 e não manda data inicial', () => {
    const form = { ...billFormFrom(february, day31), amount: '1.600,00' };
    const plan = futureEditPlan(form, february, day31);
    expect(plan.from).toBe('2026-02-28');
    expect(plan.update.recurrence).toEqual({ interval: 1 });
    expect(plan.update).not.toHaveProperty('startDate');
    expect(plan.update.amountCents).toBe(160000);
    expect(plan.preview).toMatchObject({ startDate: '2026-02-28', recurrence: { frequency: 'monthly', dayOfMonth: 31 } });
  });

  it('ocorrência paga ou pulada: a regra nova começa no dia seguinte', () => {
    const paid = { ...february, state: 'paid' as const, paidAt: '2026-02-20', paidCents: 150000, displayStatus: 'paid' as const };
    expect(futureEditPlan(billFormFrom(paid, day31), paid, day31).from).toBe('2026-03-01');
    const skipped = { ...february, state: 'skipped' as const, displayStatus: 'skipped' as const };
    expect(futureEditPlan(billFormFrom(skipped, day31), skipped, day31).from).toBe('2026-03-01');
    const linkedButOpen = { ...february, payments: [{ id: 1, transactionId: 9, amountCents: 1, paidAt: '2026-02-20', origin: 'manual' as const, createdTransaction: true, paymentMethodName: null, transactionDescription: 'x' }] };
    expect(futureEditPlan(billFormFrom(linkedButOpen, day31), linkedButOpen, day31).from).toBe('2026-03-01');
  });

  it('data alterada: re-ancora a série na data nova e corta na menor das duas', () => {
    const later = { ...billFormFrom(february, day31), dueDate: '2026-03-05' };
    const plan = futureEditPlan(later, february, day31);
    expect(plan.from).toBe('2026-02-28');
    expect(plan.update).toMatchObject({ startDate: '2026-03-05', recurrence: { frequency: 'monthly', interval: 1, dayOfMonth: 5 } });
    const earlier = { ...billFormFrom(february, day31), dueDate: '2026-02-20' };
    expect(futureEditPlan(earlier, february, day31).from).toBe('2026-02-20');
  });

  it('frequência alterada sem mudar a data: deriva a regra nova da data exibida', () => {
    const weekly = { ...billFormFrom(february, day31), frequency: 'weekly' as const };
    expect(futureEditPlan(weekly, february, day31).update.recurrence).toEqual({ frequency: 'weekly', interval: 1, weekday: null, lastBusinessDay: false });
    // Ligar "último dia útil" também muda a regra: a âncora não é mantida.
    const lastBusiness = { ...billFormFrom(february, day31), lastBusinessDay: true };
    expect(futureEditPlan(lastBusiness, february, day31).update.recurrence).toEqual({ frequency: 'monthly', interval: 1, dayOfMonth: null, lastBusinessDay: true });
  });

  it('nextDayIso vira mês e ano', () => {
    expect(nextDayIso('2026-02-28')).toBe('2026-03-01');
    expect(nextDayIso('2026-12-31')).toBe('2027-01-01');
  });
});

describe('pagamento parcial', () => {
  const brl = (cents: number) => `R$ ${(cents / 100).toFixed(2).replace('.', ',')}`;
  const payment = (transactionId: number | null, paymentMethodName: string | null = null) => ({
    id: 1, transactionId, amountCents: 100, paidAt: TODAY, origin: 'manual' as const,
    createdTransaction: transactionId !== null, paymentMethodName, transactionDescription: null,
  });

  it('o restante desconta os parciais e nunca fica negativo', () => {
    expect(remainingCents(bill({ partialPaidCents: 20000 }))).toBe(58200);
    expect(remainingCents(bill({ partialPaidCents: 90000 }))).toBe(0);
  });

  it('a nota da linha prioriza o progresso parcial, depois o lançamento, a migração e a observação', () => {
    expect(billNote(bill({ partialPaidCents: 20000, payments: [payment(null)] }), brl)).toBe('Pago R$ 200,00 de R$ 782,00 · faltam R$ 582,00');
    expect(billNote(bill({ state: 'paid', payments: [payment(null), payment(9, 'Nubank')] }), brl)).toBe('Lançamento em Nubank');
    expect(billNote(bill({ state: 'paid', payments: [payment(null)], notes: 'pago no caixa' }), brl)).toBe('pago no caixa');
    expect(billNote(bill({ state: 'paid', migratedPayment: true }), brl)).toBe('Paga antes da atualização (sem lançamento)');
    expect(billNote(bill(), brl)).toBeNull();
  });
});

describe('previsão mensal', () => {
  const summary = (totalCents: number, paidCents: number) => ({
    totalCents, paidCents, openCents: totalCents - paidCents, overdueCents: 0,
    statusCounts: { overdue: 0, due_today: 0, scheduled: 0, upcoming: 0, paid: 0, skipped: 0 },
  });

  it('monta um cartão por mês com a fração paga e marca o mês aberto', () => {
    const cards = forecastCards({
      today: TODAY,
      months: [
        { year: 2026, month: 3, from: '2026-03-01', to: '2026-03-31', summary: summary(40000, 10000) },
        { year: 2026, month: 4, from: '2026-04-01', to: '2026-04-30', summary: summary(0, 0) },
      ],
    }, { year: 2026, month: 4 });
    expect(cards.map((card) => [card.label, card.paidShare, card.selected])).toEqual([
      ['Março de 2026', 0.25, false],
      ['Abril de 2026', 0, true],
    ]);
    expect(forecastCards(null, { year: 2026, month: 3 })).toEqual([]);
  });
});


describe('ações em massa e atalhos', () => {
  it('a seleção ignora contas fora da lista ou que deixaram de estar em aberto e soma o que falta', () => {
    const bills = [
      bill({ id: 1, amountCents: 1000 }),
      bill({ id: 2, amountCents: 5000, partialPaidCents: 2000 }),
      bill({ id: 3, state: 'paid' }),
    ];
    const selection = bulkSelection(bills, new Set([1, 2, 3, 99]));
    expect(selection.bills.map((item) => item.id)).toEqual([1, 2]);
    expect(selection.remainingCents).toBe(4000);
    expect(selection.partial.map((item) => item.id)).toEqual([2]);
  });

  it('N e P são atalhos só fora de campos e sem modificadores', () => {
    const base = { ctrlKey: false, metaKey: false, altKey: false, target: null };
    expect(billsShortcut({ ...base, key: 'n' })).toBe('new');
    expect(billsShortcut({ ...base, key: 'P' })).toBe('pay');
    expect(billsShortcut({ ...base, key: 'x' })).toBeNull();
    expect(billsShortcut({ ...base, key: 'n', ctrlKey: true })).toBeNull();
    expect(billsShortcut({ ...base, key: 'n', target: { tagName: 'INPUT' } as unknown as EventTarget })).toBeNull();
    expect(billsShortcut({ ...base, key: 'p', target: { tagName: 'DIV', isContentEditable: true } as unknown as EventTarget })).toBeNull();
    expect(billsShortcut({ ...base, key: 'p', target: { tagName: 'BUTTON' } as unknown as EventTarget })).toBe('pay');
    expect(billsShortcut({ ...base, key: 'p', target: { tagName: 'INPUT', type: 'checkbox' } as unknown as EventTarget })).toBe('pay');
    expect(billsShortcut({ ...base, key: 'p', target: { tagName: 'INPUT', type: 'date' } as unknown as EventTarget })).toBeNull();
  });
});

describe('calendário do mês', () => {
  it('monta semanas de domingo a sábado com as contas pelo vencimento', () => {
    // Março de 2026 começa num domingo e tem 31 dias: 5 semanas.
    const weeks = calendarWeeks(
      2026,
      3,
      [
        bill({ id: 1, dueDate: '2026-03-02', displayStatus: 'overdue', amountCents: 1000 }),
        bill({ id: 2, dueDate: '2026-03-02', state: 'paid', displayStatus: 'paid', amountCents: 500 }),
        bill({ id: 3, dueDate: '2026-03-05', state: 'skipped', displayStatus: 'skipped', amountCents: 700 }),
        bill({ id: 4, dueDate: '2026-03-10', displayStatus: 'upcoming', amountCents: 3000, partialPaidCents: 1000 }),
      ],
      '2026-03-04',
    );
    expect(weeks).toHaveLength(5);
    expect(weeks.every((week) => week.length === 7)).toBe(true);
    expect(weeks[0][0]?.date).toBe('2026-03-01');
    expect(weeks[4].map((cell) => cell?.day ?? null)).toEqual([29, 30, 31, null, null, null, null]);

    const second = weeks[0][1];
    expect(second).toMatchObject({ day: 2, totalCents: 1500, openCents: 1000, tone: 'danger', isToday: false });
    expect(second?.bills.map((item) => item.id)).toEqual([1, 2]);
    expect(weeks[0][4]).toMatchObject({ day: 5, totalCents: 0, openCents: 0, tone: 'muted' });
    expect(weeks[1][2]).toMatchObject({ day: 10, totalCents: 3000, openCents: 2000, tone: 'neutral' });
    expect(weeks[0][3]).toMatchObject({ day: 4, isToday: true, bills: [], tone: null });
  });

  it('começa com folga no início quando o mês não abre no domingo e escolhe o dia inicial', () => {
    // Fevereiro de 2027 começa numa segunda e tem 28 dias.
    const weeks = calendarWeeks(2027, 2, [bill({ id: 1, dueDate: '2027-02-15', displayStatus: 'upcoming' })], '2026-03-04');
    expect(weeks[0][0]).toBeNull();
    expect(weeks[0][1]?.date).toBe('2027-02-01');
    expect(weeks.flat().filter(Boolean)).toHaveLength(28);
    expect(defaultCalendarDay(weeks)).toBe('2027-02-15');
    expect(defaultCalendarDay(calendarWeeks(2027, 2, [], '2026-03-04'))).toBe('2027-02-01');
    expect(defaultCalendarDay(calendarWeeks(2026, 3, [bill({ dueDate: '2026-03-20' })], '2026-03-04'))).toBe('2026-03-04');
  });
});
