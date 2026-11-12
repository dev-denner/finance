import { describe, expect, it } from 'vitest';
import {
  badgeCount,
  billFormFrom,
  billsViewParams,
  centsToInput,
  daysBetween,
  emptyBillForm,
  monthLabel,
  parseBillsView,
  parseCentsInput,
  recurrenceFrom,
  sequenceLabel,
  shiftMonth,
  statusInfo,
  templateInputFrom,
  validateBillForm,
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
    });
    expect(parseBillsView(new URLSearchParams('year=2025&month=13&state=xx&categoryId=-1'), TODAY)).toEqual({
      year: 2026,
      month: 3,
      state: 'all',
      q: '',
      categoryId: null,
    });
  });

  it('grava só o que difere do padrão e é ida e volta', () => {
    expect(billsViewParams({ year: 2026, month: 3, state: 'all', q: ' ', categoryId: null }, TODAY)).toEqual({});
    const view = { year: 2025, month: 11, state: 'open' as const, q: 'condo', categoryId: 2 };
    const params = billsViewParams(view, TODAY);
    expect(params).toEqual({ year: '2025', month: '11', state: 'open', q: 'condo', categoryId: '2' });
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
    expect(recurrenceFrom({ dueDate: '2026-01-31', frequency: 'monthly', interval: '1' })).toEqual({ frequency: 'monthly', interval: 1, dayOfMonth: 31 });
    expect(recurrenceFrom({ dueDate: '2026-04-05', frequency: 'yearly', interval: '1' })).toEqual({ frequency: 'yearly', interval: 1, dayOfMonth: 5, monthOfYear: 4 });
    expect(recurrenceFrom({ dueDate: '2026-04-05', frequency: 'weekly', interval: '2' })).toEqual({ frequency: 'weekly', interval: 2, weekday: null });
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
