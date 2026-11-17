/**
 * Lógica de apresentação de contas a pagar, sem React: estado da URL, rótulos
 * de situação, conversão de valores digitados e o modelo do formulário.
 * Testada em `bills-view.test.ts`.
 */
import type {
  Bill,
  BillAgenda,
  BillForecast,
  BillFrequency,
  BillState,
  BillTemplate,
  BillTemplateInput,
  BillTemplateUpdate,
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

export function nextDayIso(iso: string): string {
  return new Date(toUtc(iso) + 86_400_000).toISOString().slice(0, 10);
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
  /** Lista (padrão) ou calendário do mês. */
  layout: BillsLayout;
}

export type BillsLayout = 'list' | 'calendar';

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
    layout: params.get('layout') === 'calendar' ? 'calendar' : 'list',
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
  if (view.layout === 'calendar') params.layout = 'calendar';
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
  /** Só mensal: vence no último dia útil do mês em vez do dia da primeira data. */
  lastBusinessDay: boolean;
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
    lastBusinessDay: false,
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
    lastBusinessDay: template?.recurrence.lastBusinessDay === true,
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
 * meses curtos sem perder o dia nos meses longos. Com "último dia útil", o
 * servidor calcula o dia de cada mês.
 */
export function recurrenceFrom(
  form: Pick<BillForm, 'dueDate' | 'frequency' | 'interval'> & Partial<Pick<BillForm, 'lastBusinessDay'>>,
): BillTemplateInput['recurrence'] {
  const day = Number(form.dueDate.slice(8, 10));
  const month = Number(form.dueDate.slice(5, 7));
  const interval = Number(form.interval) || 1;
  if (form.frequency === 'weekly') return { frequency: 'weekly', interval, weekday: null, lastBusinessDay: false };
  if (form.frequency === 'yearly') {
    return { frequency: 'yearly', interval, dayOfMonth: day, monthOfYear: month, lastBusinessDay: false };
  }
  if (form.lastBusinessDay) return { frequency: 'monthly', interval, dayOfMonth: null, lastBusinessDay: true };
  return { frequency: 'monthly', interval, dayOfMonth: day, lastBusinessDay: false };
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

// ---------------------------------------------------------------------------
// Edição "esta e as futuras" de uma ocorrência recorrente
// ---------------------------------------------------------------------------

export interface FutureEditPlan {
  /** A partir de quando a regra nova vale (`?from=` do PUT). */
  from: string;
  /** Corpo do PUT com `scope=future`. */
  update: BillTemplateUpdate;
  /** Mesma regra no formato de criação, para a prévia de datas. */
  preview: BillTemplateInput;
}

/**
 * Traduz o formulário de uma ocorrência em uma divisão da série.
 *
 * - Sem mudar a data nem a frequência, a regra mantém a âncora original
 *   (dia 31 continua 31, mesmo editando pela ocorrência de 28/02): só o
 *   intervalo vai na atualização e o servidor preserva o resto.
 * - Ocorrência paga ou pulada continua no histórico; a regra nova começa no
 *   dia seguinte para não recriar a mesma data como conta aberta.
 * - Mudando a data, a série é re-ancorada na data nova.
 */
export function futureEditPlan(form: BillForm, bill: Bill, template: BillTemplate): FutureEditPlan {
  const base = templateInputFrom({ ...form, repeat: true });
  const dateChanged = form.dueDate !== bill.dueDate;
  const retained = bill.state !== 'open' || bill.payments.length > 0;
  const from = dateChanged
    ? form.dueDate < bill.dueDate
      ? form.dueDate
      : bill.dueDate
    : retained
      ? nextDayIso(bill.dueDate)
      : bill.dueDate;
  const keepAnchor =
    !dateChanged &&
    form.frequency === template.recurrence.frequency &&
    (form.frequency === 'monthly' && form.lastBusinessDay) === (template.recurrence.lastBusinessDay === true);
  const interval = Number(form.interval) || 1;
  const fullRecurrence: BillTemplateInput['recurrence'] = keepAnchor
    ? {
        frequency: template.recurrence.frequency,
        interval,
        dayOfMonth: template.recurrence.dayOfMonth,
        weekday: template.recurrence.weekday,
        monthOfYear: template.recurrence.monthOfYear,
        lastBusinessDay: template.recurrence.lastBusinessDay === true,
      }
    : recurrenceFrom(form);

  return {
    from,
    update: {
      description: base.description,
      amountCents: base.amountCents,
      categoryId: base.categoryId,
      paymentMethodId: base.paymentMethodId,
      notes: base.notes,
      recurrence: keepAnchor ? { interval } : fullRecurrence,
      ...(dateChanged ? { startDate: form.dueDate } : {}),
      endDate: base.endDate,
      occurrenceCount: base.occurrenceCount,
    },
    preview: { ...base, recurrence: fullRecurrence, startDate: dateChanged ? form.dueDate : from },
  };
}

// ---------------------------------------------------------------------------
// Pagamentos
// ---------------------------------------------------------------------------

/** Quanto falta pagar: o valor previsto menos os pagamentos parciais. */
export function remainingCents(bill: Pick<Bill, 'amountCents' | 'partialPaidCents'>): number {
  return Math.max(0, bill.amountCents - bill.partialPaidCents);
}

/**
 * Linha de apoio sob a descrição da conta: progresso do pagamento parcial,
 * conta de onde saiu o lançamento, pagamento migrado ou observação.
 */
export function billNote(
  bill: Pick<Bill, 'state' | 'amountCents' | 'partialPaidCents' | 'payments' | 'migratedPayment' | 'notes'>,
  formatMoney: (cents: number) => string,
): string | null {
  if (bill.state === 'open' && bill.partialPaidCents > 0) {
    return `Pago ${formatMoney(bill.partialPaidCents)} de ${formatMoney(bill.amountCents)} · faltam ${formatMoney(remainingCents(bill))}`;
  }
  const linked = bill.payments.find((payment) => payment.transactionId !== null);
  if (linked) return `Lançamento em ${linked.paymentMethodName ?? 'Movimentações'}`;
  if (bill.migratedPayment) return 'Paga antes da atualização (sem lançamento)';
  return bill.notes;
}

// ---------------------------------------------------------------------------
// Previsão
// ---------------------------------------------------------------------------

export interface ForecastCard {
  year: number;
  month: number;
  label: string;
  totalCents: number;
  openCents: number;
  paidCents: number;
  overdueCents: number;
  /** Fração já paga do previsto, de 0 a 1 (0 quando não há contas no mês). */
  paidShare: number;
  /** Mês aberto na lista abaixo. */
  selected: boolean;
}

/** Cartões da previsão mensal, marcando o mês que está aberto na lista. */
export function forecastCards(forecast: BillForecast | null, view: Pick<BillsView, 'year' | 'month'>): ForecastCard[] {
  return (forecast?.months ?? []).map(({ year, month, summary }) => ({
    year,
    month,
    label: monthLabel(year, month),
    totalCents: summary.totalCents,
    openCents: summary.openCents,
    paidCents: summary.paidCents,
    overdueCents: summary.overdueCents,
    paidShare: summary.totalCents > 0 ? Math.min(1, summary.paidCents / summary.totalCents) : 0,
    selected: year === view.year && month === view.month,
  }));
}


/** Ações em massa só valem para contas em aberto. */
export function isBulkSelectable(bill: Pick<Bill, 'state'>): boolean {
  return bill.state === 'open';
}

export interface BulkSelection {
  bills: Bill[];
  /** Soma do que falta pagar nas selecionadas. */
  remainingCents: number;
  /** Selecionadas com pagamento parcial: não podem ser puladas. */
  partial: Bill[];
}

/** Contas selecionadas que continuam na lista e em aberto, na ordem da lista. */
export function bulkSelection(bills: readonly Bill[], selectedIds: ReadonlySet<number>): BulkSelection {
  const selected = bills.filter((bill) => selectedIds.has(bill.id) && isBulkSelectable(bill));
  return {
    bills: selected,
    remainingCents: selected.reduce((sum, bill) => sum + remainingCents(bill), 0),
    partial: selected.filter((bill) => bill.partialPaidCents > 0),
  };
}

/** Atalho de teclado da tela de contas, ou null quando a tecla não é atalho. */
export type BillsShortcut = 'new' | 'pay';

export function billsShortcut(event: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  target: EventTarget | null;
}): BillsShortcut | null {
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  if (isTypingTarget(event.target)) return null;
  const key = event.key.toLowerCase();
  if (key === 'n') return 'new';
  if (key === 'p') return 'pay';
  return null;
}

/** Campos de input que não recebem texto: com o foco neles (ex.: a caixa recém-marcada), o atalho vale. */
const NON_TEXT_INPUTS = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'color', 'range', 'image']);

function isTypingTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as { tagName?: unknown }).tagName !== 'string') return false;
  const element = target as HTMLElement & { type?: unknown };
  const tag = element.tagName.toLowerCase();
  if (tag === 'input') return !NON_TEXT_INPUTS.has(String(element.type ?? 'text').toLowerCase());
  return tag === 'textarea' || tag === 'select' || element.isContentEditable === true;
}

// ---------------------------------------------------------------------------
// Calendário do mês
// ---------------------------------------------------------------------------

export const WEEKDAYS_SHORT = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'] as const;

export interface CalendarDay {
  date: string;
  day: number;
  /** Contas que vencem no dia, na ordem da lista. */
  bills: Bill[];
  /** Previsto do dia, sem as puladas. */
  totalCents: number;
  /** O que ainda falta pagar no dia (descontados os parciais). */
  openCents: number;
  /** Tom mais urgente entre as contas do dia, para o marcador da célula. */
  tone: StatusTone | null;
  isToday: boolean;
}

/** Semana de domingo a sábado; null nas casas fora do mês. */
export type CalendarWeek = (CalendarDay | null)[];

const TONE_PRIORITY: readonly StatusTone[] = ['danger', 'warning', 'info', 'neutral', 'success', 'muted'];

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** Grade do mês com as contas pelo vencimento. */
export function calendarWeeks(year: number, month: number, bills: readonly Bill[], today: string): CalendarWeek[] {
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const firstWeekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const byDate = new Map<string, Bill[]>();
  for (const bill of bills) {
    const list = byDate.get(bill.dueDate);
    if (list) list.push(bill);
    else byDate.set(bill.dueDate, [bill]);
  }

  const cells: (CalendarDay | null)[] = Array.from({ length: firstWeekday }, () => null);
  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = `${year}-${pad2(month)}-${pad2(day)}`;
    const dayBills = byDate.get(date) ?? [];
    const counted = dayBills.filter((bill) => bill.state !== 'skipped');
    const tones = dayBills.map((bill) => statusInfo(bill, today).tone);
    cells.push({
      date,
      day,
      bills: dayBills,
      totalCents: counted.reduce((sum, bill) => sum + bill.amountCents, 0),
      openCents: counted.filter((bill) => bill.state === 'open').reduce((sum, bill) => sum + remainingCents(bill), 0),
      tone: TONE_PRIORITY.find((tone) => tones.includes(tone)) ?? null,
      isToday: date === today,
    });
  }
  while (cells.length % 7 !== 0) cells.push(null);

  const weeks: CalendarWeek[] = [];
  for (let index = 0; index < cells.length; index += 7) weeks.push(cells.slice(index, index + 7));
  return weeks;
}

/**
 * Dia aberto ao entrar no calendário: hoje, se for do mês exibido; senão o
 * primeiro dia com conta em aberto, o primeiro com qualquer conta ou o dia 1.
 */
export function defaultCalendarDay(weeks: readonly CalendarWeek[]): string | null {
  const days = weeks.flat().filter((cell): cell is CalendarDay => cell !== null);
  if (days.length === 0) return null;
  return (
    days.find((cell) => cell.isToday)?.date ??
    days.find((cell) => cell.bills.some((bill) => bill.state === 'open'))?.date ??
    days.find((cell) => cell.bills.length > 0)?.date ??
    days[0].date
  );
}
