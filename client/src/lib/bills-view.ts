/**
 * Lógica de apresentação de contas a pagar, sem React: estado da URL, rótulos
 * de situação, conversão de valores digitados e o modelo do formulário.
 * Testada em `bills-view.test.ts`.
 */
import type {
  Bill,
  BillAgenda,
  BillFrequency,
  BillState,
  BillTemplate,
  BillTemplateInput,
} from './types';

// ---------------------------------------------------------------------------
// Datas
// ---------------------------------------------------------------------------

function toUtc(iso: string): number {
  const [year, month, day] = iso.slice(0, 10).split('-').map(Number);
  return Date.UTC(year, month - 1, day);
}

/** Dias corridos de `from` até `to` (negativo quando `to` é anterior). */
export function daysBetween(from: string, to: string): number {
  return Math.round((toUtc(to) - toUtc(from)) / 86_400_000);
}

export function shiftMonth(year: number, month: number, delta: number): { year: number; month: number } {
  const total = year * 12 + (month - 1) + delta;
  return { year: Math.floor(total / 12), month: (((total % 12) + 12) % 12) + 1 };
}

export function monthLabel(year: number, month: number): string {
  const label = new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString('pt-BR', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function shortDate(iso: string): string {
  const [, month, day] = iso.split('-');
  return `${day}/${month}`;
}

// ---------------------------------------------------------------------------
// Valores digitados
// ---------------------------------------------------------------------------

/**
 * Converte o valor digitado em centavos positivos. Aceita `1.234,56`,
 * `1234,56`, `1234.56`, `R$ 782` e `1.234`. Recusa negativo, zero e formatos
 * ambíguos (ex.: `1,2,3`) devolvendo null.
 */
export function parseCentsInput(text: string): number | null {
  const value = text.replace(/R\$/gi, '').replace(/\s/g, '');
  if (!value || value.startsWith('-')) return null;
  let whole: string;
  let fraction = '';
  if (value.includes(',')) {
    const parts = value.split(',');
    if (parts.length !== 2 || !/^\d{1,2}$/.test(parts[1])) return null;
    if (!/^(\d{1,3}(\.\d{3})*|\d+)$/.test(parts[0])) return null;
    whole = parts[0].replace(/\./g, '');
    fraction = parts[1];
  } else if (value.includes('.')) {
    if (/^\d+\.\d{1,2}$/.test(value)) {
      [whole, fraction] = value.split('.');
    } else if (/^\d{1,3}(\.\d{3})+$/.test(value)) {
      whole = value.replace(/\./g, '');
    } else {
      return null;
    }
  } else if (/^\d+$/.test(value)) {
    whole = value;
  } else {
    return null;
  }
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents) || cents <= 0) return null;
  return cents;
}

/** Centavos no formato de edição (`1234,56`, sem separador de milhar). */
export function centsToInput(cents: number): string {
  return `${Math.floor(cents / 100)},${String(cents % 100).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Situação exibida
// ---------------------------------------------------------------------------

export type StatusTone = 'danger' | 'warning' | 'info' | 'neutral' | 'success' | 'muted';

export interface StatusInfo {
  label: string;
  tone: StatusTone;
}

export function statusInfo(
  bill: Pick<Bill, 'displayStatus' | 'dueDate' | 'scheduledFor' | 'paidAt'>,
  today: string,
): StatusInfo {
  switch (bill.displayStatus) {
    case 'overdue': {
      const days = daysBetween(bill.dueDate, today);
      return { label: days === 1 ? 'Atrasada há 1 dia' : `Atrasada há ${days} dias`, tone: 'danger' };
    }
    case 'due_today':
      return { label: 'Vence hoje', tone: 'warning' };
    case 'scheduled':
      return { label: bill.scheduledFor ? `Agendada ${shortDate(bill.scheduledFor)}` : 'Agendada', tone: 'info' };
    case 'upcoming': {
      const days = daysBetween(today, bill.dueDate);
      return { label: days === 1 ? 'Vence amanhã' : `Em ${days} dias`, tone: 'neutral' };
    }
    case 'paid':
      return { label: bill.paidAt ? `Paga ${shortDate(bill.paidAt)}` : 'Paga', tone: 'success' };
    case 'skipped':
      return { label: 'Pulada', tone: 'muted' };
    default:
      return { label: '—', tone: 'neutral' };
  }
}

/** "3 de 6" para recorrência com quantidade; "nº 3" sem fim definido; null para avulsa. */
export function sequenceLabel(
  bill: Pick<Bill, 'templateId' | 'sequence'>,
  template: Pick<BillTemplate, 'occurrenceCount'> | undefined,
): string | null {
  if (bill.templateId === null || bill.sequence === null) return null;
  if (template?.occurrenceCount) return `${bill.sequence} de ${template.occurrenceCount}`;
  return null;
}

export function badgeCount(agenda: Pick<BillAgenda, 'overdue' | 'dueToday'> | null): number {
  if (!agenda) return 0;
  return agenda.overdue.length + agenda.dueToday.length;
}

// ---------------------------------------------------------------------------
// Estado na URL
// ---------------------------------------------------------------------------

export type BillStateFilter = 'all' | BillState;

export interface BillsView {
  year: number;
  month: number;
  state: BillStateFilter;
  q: string;
  categoryId: number | null;
}

const STATE_FILTERS: readonly BillStateFilter[] = ['all', 'open', 'paid', 'skipped'];

function positiveInt(value: string | null): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return parsed > 0 ? parsed : null;
}

export function parseBillsView(params: URLSearchParams, today: string): BillsView {
  const year = positiveInt(params.get('year'));
  const month = positiveInt(params.get('month'));
  const validMonth = month !== null && month <= 12;
  const validYear = year !== null && year >= 1900 && year <= 2200;
  const state = params.get('state');
  return {
    year: validYear && validMonth ? year : Number(today.slice(0, 4)),
    month: validYear && validMonth ? month : Number(today.slice(5, 7)),
    state: STATE_FILTERS.includes(state as BillStateFilter) ? (state as BillStateFilter) : 'all',
    q: (params.get('q') ?? '').slice(0, 200),
    categoryId: positiveInt(params.get('categoryId')),
  };
}

/** Só grava na URL o que difere do padrão (mês corrente, todas, sem busca). */
export function billsViewParams(view: BillsView, today: string): Record<string, string> {
  const params: Record<string, string> = {};
  const isCurrentMonth =
    view.year === Number(today.slice(0, 4)) && view.month === Number(today.slice(5, 7));
  if (!isCurrentMonth) {
    params.year = String(view.year);
    params.month = String(view.month);
  }
  if (view.state !== 'all') params.state = view.state;
  if (view.q.trim()) params.q = view.q.trim();
  if (view.categoryId !== null) params.categoryId = String(view.categoryId);
  return params;
}

// ---------------------------------------------------------------------------
// Formulário
// ---------------------------------------------------------------------------

export type EndMode = 'never' | 'date' | 'count';

export interface BillForm {
  description: string;
  amount: string;
  /** Vencimento da conta avulsa ou primeira data da recorrência. */
  dueDate: string;
  categoryId: number | null;
  paymentMethodId: number | null;
  notes: string;
  repeat: boolean;
  frequency: BillFrequency;
  interval: string;
  endMode: EndMode;
  endDate: string;
  occurrenceCount: string;
}

export type BillFormErrors = Partial<Record<keyof BillForm, string>>;

export function emptyBillForm(today: string, categoryId: number | null): BillForm {
  return {
    description: '',
    amount: '',
    dueDate: today,
    categoryId,
    paymentMethodId: null,
    notes: '',
    repeat: false,
    frequency: 'monthly',
    interval: '1',
    endMode: 'never',
    endDate: '',
    occurrenceCount: '',
  };
}

export function billFormFrom(bill: Bill, template?: BillTemplate): BillForm {
  return {
    description: bill.description,
    amount: centsToInput(bill.amountCents),
    dueDate: bill.dueDate,
    categoryId: bill.categoryId,
    paymentMethodId: bill.paymentMethodId,
    notes: bill.notes ?? '',
    repeat: Boolean(template),
    frequency: template?.recurrence.frequency ?? 'monthly',
    interval: String(template?.recurrence.interval ?? 1),
    endMode: template?.occurrenceCount ? 'count' : template?.endDate ? 'date' : 'never',
    endDate: template?.endDate ?? '',
    occurrenceCount: template?.occurrenceCount ? String(template.occurrenceCount) : '',
  };
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export function validateBillForm(form: BillForm): BillFormErrors {
  const errors: BillFormErrors = {};
  if (!form.description.trim()) errors.description = 'Informe a descrição.';
  else if (form.description.trim().length > 200) errors.description = 'Máximo de 200 caracteres.';
  if (parseCentsInput(form.amount) === null) errors.amount = 'Informe um valor positivo, como 1.234,56.';
  if (!ISO.test(form.dueDate)) errors.dueDate = 'Informe a data.';
  if (form.categoryId === null) errors.categoryId = 'Selecione a categoria.';
  if (form.notes.length > 1000) errors.notes = 'Máximo de 1000 caracteres.';
  if (form.repeat) {
    const interval = Number(form.interval);
    if (!Number.isInteger(interval) || interval < 1 || interval > 120) {
      errors.interval = 'Use um número de 1 a 120.';
    }
    if (form.endMode === 'date') {
      if (!ISO.test(form.endDate)) errors.endDate = 'Informe a data final.';
      else if (form.endDate < form.dueDate) errors.endDate = 'A data final deve ser depois da primeira.';
    }
    if (form.endMode === 'count') {
      const count = Number(form.occurrenceCount);
      if (!Number.isInteger(count) || count < 1 || count > 600) {
        errors.occurrenceCount = 'Use um número de 1 a 600.';
      }
    }
  }
  return errors;
}

/** Campos comuns a conta avulsa e ocorrência (para `createBill`/`updateBill`). */
export function billInputFrom(form: BillForm) {
  return {
    description: form.description.trim(),
    amountCents: parseCentsInput(form.amount) as number,
    dueDate: form.dueDate,
    categoryId: form.categoryId as number,
    paymentMethodId: form.paymentMethodId,
    notes: form.notes.trim() || null,
  };
}

/**
 * Recorrência derivada da primeira data: o dia do mês (e o mês, se anual) vêm
 * dela, e o dia da semana fica com o servidor. Dia 31 recua para o fim dos
 * meses curtos sem perder o dia nos meses longos.
 */
export function recurrenceFrom(form: Pick<BillForm, 'dueDate' | 'frequency' | 'interval'>): BillTemplateInput['recurrence'] {
  const day = Number(form.dueDate.slice(8, 10));
  const month = Number(form.dueDate.slice(5, 7));
  const interval = Number(form.interval) || 1;
  if (form.frequency === 'weekly') return { frequency: 'weekly', interval, weekday: null };
  if (form.frequency === 'yearly') return { frequency: 'yearly', interval, dayOfMonth: day, monthOfYear: month };
  return { frequency: 'monthly', interval, dayOfMonth: day };
}

export function templateInputFrom(form: BillForm): BillTemplateInput {
  const base = billInputFrom(form);
  return {
    description: base.description,
    amountCents: base.amountCents,
    categoryId: base.categoryId,
    paymentMethodId: base.paymentMethodId,
    notes: base.notes,
    recurrence: recurrenceFrom(form),
    startDate: form.dueDate,
    endDate: form.endMode === 'date' ? form.endDate : null,
    occurrenceCount: form.endMode === 'count' ? Number(form.occurrenceCount) : null,
  };
}

export const FREQUENCY_LABELS: Record<BillFrequency, { singular: string; plural: string; adjective: string }> = {
  monthly: { singular: 'mês', plural: 'meses', adjective: 'Mensal' },
  weekly: { singular: 'semana', plural: 'semanas', adjective: 'Semanal' },
  yearly: { singular: 'ano', plural: 'anos', adjective: 'Anual' },
};
