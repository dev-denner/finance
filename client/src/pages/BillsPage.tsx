import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  AlertTriangle,
  CalendarCheck,
  CalendarClock,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  Pencil,
  Plus,
  Repeat,
  RotateCcw,
  Search,
  SkipForward,
  Trash2,
  Undo2,
  Wallet,
} from 'lucide-react';
import { Button } from '../components/ui/Button';
import { EmptyState, PageHeader, Spinner } from '../components/ui/Page';
import { BillFormDialog, type BillFormTarget } from '../components/bills/BillFormDialog';
import { PayDialog } from '../components/bills/PayDialog';
import { DeleteBillDialog, ScheduleDialog } from '../components/bills/SmallBillDialogs';
import { StatusChip } from '../components/bills/StatusChip';
import { useBillsBadge } from '../context/BillsBadgeContext';
import { useMeta } from '../context/MetaContext';
import { useToast } from '../context/ToastContext';
import { api, errorMessage } from '../lib/api';
import {
  billsViewParams,
  monthLabel,
  parseBillsView,
  sequenceLabel,
  shiftMonth,
  type BillStateFilter,
  type BillsView,
} from '../lib/bills-view';
import { formatBRL, formatDateBR, todayISO } from '../lib/format';
import type { Bill, BillAgenda, BillListResponse, BillTemplate, PayBillInput } from '../lib/types';

type Dialog =
  | { kind: 'form'; target: BillFormTarget }
  | { kind: 'pay'; bill: Bill }
  | { kind: 'schedule'; bill: Bill }
  | { kind: 'delete'; bill: Bill };

const STATE_OPTIONS: { value: BillStateFilter; label: string }[] = [
  { value: 'all', label: 'Todas' },
  { value: 'open', label: 'Em aberto' },
  { value: 'paid', label: 'Pagas' },
  { value: 'skipped', label: 'Puladas' },
];

const UNDO_MS = 6000;
/** Linhas da agenda visíveis antes de "Mostrar todas". */
const AGENDA_PREVIEW_ROWS = 8;

function SummaryTile({
  label,
  value,
  detail,
  tone,
  icon: Icon,
}: {
  label: string;
  value: string;
  detail: string;
  tone: 'rose' | 'amber' | 'blue' | 'emerald';
  icon: typeof Wallet;
}) {
  const tones = {
    rose: 'text-rose-600 dark:text-rose-400',
    amber: 'text-amber-600 dark:text-amber-400',
    blue: 'text-blue-600 dark:text-blue-400',
    emerald: 'text-emerald-600 dark:text-emerald-400',
  };
  return (
    <div className="card px-4 py-3">
      <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-ink-500 dark:text-ink-400">
        <Icon className={`h-3.5 w-3.5 ${tones[tone]}`} aria-hidden="true" />
        {label}
      </div>
      <p className="mt-1 text-lg font-semibold tabular-nums text-ink-900 dark:text-white">{value}</p>
      <p className="text-[11px] text-ink-400">{detail}</p>
    </div>
  );
}

function plural(count: number, one: string, many: string) {
  return `${count} ${count === 1 ? one : many}`;
}

export function BillsPage() {
  const { meta } = useMeta();
  const { showToast } = useToast();
  const { refresh: refreshBadge } = useBillsBadge();
  const [searchParams, setSearchParams] = useSearchParams();
  const today = todayISO();
  const view = useMemo(() => parseBillsView(searchParams, today), [searchParams, today]);

  const [month, setMonth] = useState<BillListResponse | null>(null);
  const [agenda, setAgenda] = useState<BillAgenda | null>(null);
  const [templates, setTemplates] = useState<Map<number, BillTemplate>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [draftQuery, setDraftQuery] = useState(view.q);
  const [showAllAttention, setShowAllAttention] = useState(false);
  const loadRequest = useRef(0);

  const categories = meta?.categories ?? [];
  const paymentMethods = meta?.paymentMethods ?? [];

  const setView = useCallback(
    (next: Partial<BillsView>, options: { replace?: boolean } = {}) => {
      setSearchParams(billsViewParams({ ...view, ...next }, today), { replace: options.replace });
    },
    [setSearchParams, today, view],
  );

  const load = useCallback(async () => {
    const requestId = ++loadRequest.current;
    setError(null);
    try {
      const [monthResult, agendaResult, templateResult] = await Promise.all([
        api.getBills(view.year, view.month, {
          state: view.state,
          q: view.q || undefined,
          categoryId: view.categoryId ?? undefined,
        }),
        api.getBillAgenda(7),
        api.listBillTemplates(true),
      ]);
      if (requestId !== loadRequest.current) return;
      setMonth(monthResult);
      setAgenda(agendaResult);
      setTemplates(new Map(templateResult.templates.map((template) => [template.id, template])));
    } catch (err) {
      if (requestId === loadRequest.current) setError(errorMessage(err));
    } finally {
      if (requestId === loadRequest.current) setLoading(false);
    }
  }, [view]);

  useEffect(() => {
    void load();
  }, [load]);

  // Busca com atraso curto para não gravar cada tecla no histórico.
  useEffect(() => setDraftQuery(view.q), [view.q]);
  useEffect(() => {
    if (draftQuery === view.q) return;
    const timer = window.setTimeout(() => setView({ q: draftQuery }, { replace: true }), 300);
    return () => window.clearTimeout(timer);
  }, [draftQuery, setView, view.q]);

  const afterChange = useCallback(
    async (message?: string, options?: Parameters<typeof showToast>[2]) => {
      setDialog(null);
      await Promise.all([load(), refreshBadge()]);
      if (message) showToast(message, 'success', options);
    },
    [load, refreshBadge, showToast],
  );

  const run = useCallback(
    async (action: () => Promise<unknown>, message?: string) => {
      try {
        await action();
        await afterChange(message);
      } catch (err) {
        showToast(errorMessage(err), 'error');
      }
    },
    [afterChange, showToast],
  );

  const pay = async (bill: Bill, input: PayBillInput) => {
    try {
      await api.payBill(bill.id, input);
      await afterChange(
        input.mode === 'transaction' ? 'Conta paga e lançamento registrado.' : 'Conta marcada como paga.',
        {
          durationMs: UNDO_MS,
          action: {
            label: 'Desfazer',
            onClick: () => void run(() => api.unpayBill(bill.id), 'Pagamento desfeito.'),
          },
        },
      );
    } catch (err) {
      showToast(errorMessage(err), 'error');
    }
  };

  const openEdit = async (bill: Bill) => {
    let template: BillTemplate | undefined = bill.templateId !== null ? templates.get(bill.templateId) : undefined;
    if (bill.templateId !== null && !template) {
      try {
        template = (await api.getBillTemplate(bill.templateId)).template;
      } catch (err) {
        showToast(errorMessage(err), 'error');
        return;
      }
    }
    setDialog({ kind: 'form', target: { kind: 'edit', bill, template } });
  };

  const attentionGroups = agenda
    ? [
        { key: 'overdue', label: 'Atrasadas', items: agenda.overdue },
        { key: 'today', label: 'Vencem hoje', items: agenda.dueToday },
        { key: 'upcoming', label: 'Próximos 7 dias', items: agenda.upcoming },
      ].filter((group) => group.items.length > 0)
    : [];
  const attentionTotal = attentionGroups.reduce((sum, group) => sum + group.items.length, 0);
  let attentionBudget = showAllAttention ? Number.POSITIVE_INFINITY : AGENDA_PREVIEW_ROWS;
  const visibleGroups = attentionGroups
    .map((group) => {
      const items = group.items.slice(0, Math.max(0, attentionBudget));
      attentionBudget -= items.length;
      return { ...group, hidden: group.items.length - items.length, items };
    })
    .filter((group) => group.items.length > 0);
  const summary = month?.summary;
  const isCurrentMonth = view.year === Number(today.slice(0, 4)) && view.month === Number(today.slice(5, 7));
  const filtered = view.state !== 'all' || view.q !== '' || view.categoryId !== null;

  const rowActions = (bill: Bill) => (
    <div className="flex items-center justify-end gap-0.5">
      {bill.state === 'open' && (
        <Button size="sm" variant="primary" className="mr-1" onClick={() => setDialog({ kind: 'pay', bill })}>
          Pagar
        </Button>
      )}
      {bill.state === 'paid' && (
        <button
          type="button"
          className="icon-btn"
          title="Desfazer pagamento"
          aria-label={`Desfazer pagamento de ${bill.description}`}
          onClick={() => void run(() => api.unpayBill(bill.id), 'Pagamento desfeito.')}
        >
          <Undo2 className="h-4 w-4" />
        </button>
      )}
      {bill.state === 'open' && (
        <button
          type="button"
          className="icon-btn"
          title="Agendar pagamento"
          aria-label={`Agendar ${bill.description}`}
          onClick={() => setDialog({ kind: 'schedule', bill })}
        >
          <CalendarClock className="h-4 w-4" />
        </button>
      )}
      {bill.state === 'skipped' ? (
        <button
          type="button"
          className="icon-btn"
          title="Voltar a abrir"
          aria-label={`Voltar a abrir ${bill.description}`}
          onClick={() => void run(() => api.unskipBill(bill.id), 'Conta reaberta.')}
        >
          <RotateCcw className="h-4 w-4" />
        </button>
      ) : (
        bill.state === 'open' && (
          <button
            type="button"
            className="icon-btn"
            title="Pular este mês"
            aria-label={`Pular ${bill.description}`}
            onClick={() => void run(() => api.skipBill(bill.id), 'Conta pulada.')}
          >
            <SkipForward className="h-4 w-4" />
          </button>
        )
      )}
      <button
        type="button"
        className="icon-btn"
        title="Editar"
        aria-label={`Editar ${bill.description}`}
        onClick={() => void openEdit(bill)}
      >
        <Pencil className="h-4 w-4" />
      </button>
      <button
        type="button"
        className="icon-btn hover:text-rose-600"
        title="Excluir"
        aria-label={`Excluir ${bill.description}`}
        onClick={() => setDialog({ kind: 'delete', bill })}
      >
        <Trash2 className="h-4 w-4" />
      </button>
    </div>
  );

  const describe = (bill: Bill) => {
    const template = bill.templateId !== null ? templates.get(bill.templateId) : undefined;
    const sequence = sequenceLabel(bill, template);
    return (
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="truncate font-medium text-ink-900 dark:text-white">{bill.description}</span>
          {bill.templateId !== null && (
            <span
              className="inline-flex shrink-0 items-center gap-0.5 text-[11px] text-ink-400"
              title={template?.recurrenceLabel ?? 'Recorrente'}
            >
              <Repeat className="h-3 w-3" aria-label="Recorrente" />
              {sequence}
            </span>
          )}
        </div>
        {(bill.notes || bill.payments.length > 0 || bill.migratedPayment) && (
          <p className="truncate text-[11px] text-ink-400">
            {bill.payments.length > 0
              ? `Lançamento em ${bill.payments[0].paymentMethodName ?? 'Movimentações'}`
              : bill.migratedPayment
                ? 'Paga antes da atualização (sem lançamento)'
                : bill.notes}
          </p>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Contas a pagar"
        subtitle="Agenda do que vence, do que já foi agendado no banco e do que foi pago."
        actions={
          <Button variant="primary" onClick={() => setDialog({ kind: 'form', target: { kind: 'create' } })}>
            <Plus className="h-4 w-4" />
            Nova conta
          </Button>
        }
      />

      {error && (
        <div className="flex items-center gap-2 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-[13px] text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/30 dark:text-rose-300">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      {/* Agenda: sempre relativa a hoje, independente do mês exibido. */}
      {agenda && (
        <section aria-labelledby="bills-agenda-title" className="card overflow-hidden">
          <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-ink-200 px-4 py-3 dark:border-ink-800">
            <h2 id="bills-agenda-title" className="text-sm font-semibold text-ink-900 dark:text-white">
              Atrasadas e próximos 7 dias
            </h2>
            <p className="text-[12px] text-ink-500 dark:text-ink-400">
              {agenda.summary.overdueCents > 0 && (
                <span className="font-medium text-rose-600 dark:text-rose-400">
                  {formatBRL(agenda.summary.overdueCents)} atrasado ·{' '}
                </span>
              )}
              {formatBRL(agenda.summary.openCents)} em aberto
            </p>
          </div>
          {attentionTotal === 0 ? (
            <p className="flex items-center gap-2 px-4 py-4 text-[13px] text-ink-500 dark:text-ink-400">
              <CircleCheck className="h-4 w-4 text-emerald-500" aria-hidden="true" />
              Nada atrasado nem vencendo nos próximos 7 dias.
            </p>
          ) : (
            <>
              {visibleGroups.map((group) => (
                <div key={group.key}>
                  <h3 className="border-b border-ink-100 bg-ink-50/70 px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-500 dark:border-ink-800/70 dark:bg-ink-950/30 dark:text-ink-400">
                    {group.label} · {attentionGroups.find((item) => item.key === group.key)?.items.length}
                  </h3>
                  <ul className="divide-y divide-ink-100 dark:divide-ink-800/70">
                    {group.items.map((bill) => (
                      <li key={bill.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2">
                        <span className="w-[150px] shrink-0">
                          <StatusChip bill={bill} today={today} />
                        </span>
                        <span className="min-w-0 flex-1">{describe(bill)}</span>
                        <span className="text-[12px] tabular-nums text-ink-500 dark:text-ink-400">{formatDateBR(bill.dueDate)}</span>
                        <span className="w-[110px] text-right text-[13px] font-medium tabular-nums">{formatBRL(bill.amountCents)}</span>
                        <Button size="sm" variant="primary" onClick={() => setDialog({ kind: 'pay', bill })}>
                          Pagar
                        </Button>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
              {attentionTotal > AGENDA_PREVIEW_ROWS && (
                <div className="border-t border-ink-100 px-4 py-2 text-center dark:border-ink-800/70">
                  <Button variant="ghost" size="sm" onClick={() => setShowAllAttention((value) => !value)}>
                    {showAllAttention ? 'Mostrar menos' : `Mostrar todas as ${attentionTotal}`}
                  </Button>
                </div>
              )}
            </>
          )}
        </section>
      )}

      <section aria-labelledby="bills-month-title" className="space-y-3">
        <div className="card flex flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-1.5">
            <Button
              variant="secondary"
              size="sm"
              aria-label="Mês anterior"
              onClick={() => setView(shiftMonth(view.year, view.month, -1))}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <h2 id="bills-month-title" className="min-w-[160px] text-center text-sm font-semibold text-ink-900 dark:text-white">
              {monthLabel(view.year, view.month)}
            </h2>
            <Button
              variant="secondary"
              size="sm"
              aria-label="Próximo mês"
              onClick={() => setView(shiftMonth(view.year, view.month, 1))}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
            {!isCurrentMonth && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setView({ year: Number(today.slice(0, 4)), month: Number(today.slice(5, 7)) })}
              >
                Mês atual
              </Button>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="relative">
              <span className="sr-only">Buscar conta</span>
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-400" />
              <input
                className="input h-8 w-48 pl-8 text-[13px]"
                placeholder="Buscar"
                value={draftQuery}
                onChange={(e) => setDraftQuery(e.target.value)}
              />
            </label>
            <label>
              <span className="sr-only">Situação</span>
              <select
                className="select h-8 w-36 text-[13px]"
                value={view.state}
                onChange={(e) => setView({ state: e.target.value as BillStateFilter })}
              >
                {STATE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="sr-only">Categoria</span>
              <select
                className="select h-8 w-44 text-[13px]"
                value={view.categoryId ?? ''}
                onChange={(e) => setView({ categoryId: e.target.value ? Number(e.target.value) : null })}
              >
                <option value="">Todas as categorias</option>
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>

        {summary && (
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <SummaryTile
              label="Em aberto"
              value={formatBRL(summary.openCents)}
              detail={plural(
                summary.statusCounts.overdue + summary.statusCounts.due_today + summary.statusCounts.scheduled + summary.statusCounts.upcoming,
                'conta',
                'contas',
              )}
              tone="amber"
              icon={Wallet}
            />
            <SummaryTile
              label="Atrasado"
              value={formatBRL(summary.overdueCents)}
              detail={plural(summary.statusCounts.overdue, 'conta', 'contas')}
              tone="rose"
              icon={AlertTriangle}
            />
            <SummaryTile
              label="Agendado"
              value={plural(summary.statusCounts.scheduled, 'conta', 'contas')}
              detail="débito marcado no banco"
              tone="blue"
              icon={CalendarCheck}
            />
            <SummaryTile
              label="Pago"
              value={formatBRL(summary.paidCents)}
              detail={plural(summary.statusCounts.paid, 'conta', 'contas')}
              tone="emerald"
              icon={CircleCheck}
            />
          </div>
        )}

        <div className="card overflow-hidden">
          {loading ? (
            <Spinner />
          ) : !month || month.bills.length === 0 ? (
            <EmptyState
              icon={CalendarClock}
              title={filtered ? 'Nenhuma conta com esses filtros' : 'Nenhuma conta neste mês'}
              description={
                filtered
                  ? 'Ajuste a busca, a situação ou a categoria.'
                  : 'Cadastre uma conta avulsa ou uma recorrência; as próximas ocorrências aparecem sozinhas.'
              }
              action={
                !filtered && (
                  <Button variant="primary" onClick={() => setDialog({ kind: 'form', target: { kind: 'create' } })}>
                    <Plus className="h-4 w-4" />
                    Nova conta
                  </Button>
                )
              }
            />
          ) : (
            <div className="table-shell">
              <table className="w-full min-w-[760px] border-collapse">
                <thead className="sticky top-0 z-10">
                  <tr>
                    <th className="th w-[110px]">Vencimento</th>
                    <th className="th">Descrição</th>
                    <th className="th">Categoria</th>
                    <th className="th text-right">Valor</th>
                    <th className="th">Situação</th>
                    <th className="th w-[220px] text-right">
                      <span className="sr-only">Ações</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {month.bills.map((bill) => (
                    <tr
                      key={bill.id}
                      className={`transition hover:bg-ink-50/70 dark:hover:bg-ink-800/30 ${
                        bill.state === 'skipped' ? 'opacity-60' : ''
                      }`}
                    >
                      <td className="td whitespace-nowrap tabular-nums">{formatDateBR(bill.dueDate)}</td>
                      <td className="td max-w-[320px]">{describe(bill)}</td>
                      <td className="td text-[12px] text-ink-500 dark:text-ink-400">{bill.categoryName}</td>
                      <td className="td whitespace-nowrap text-right font-medium tabular-nums">
                        {formatBRL(bill.amountCents)}
                        {bill.state === 'paid' && bill.paidCents !== null && bill.paidCents !== bill.amountCents && (
                          <span className="block text-[11px] font-normal text-ink-400">pago {formatBRL(bill.paidCents)}</span>
                        )}
                      </td>
                      <td className="td">
                        <StatusChip bill={bill} today={today} />
                      </td>
                      <td className="td">{rowActions(bill)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      {dialog?.kind === 'form' && (
        <BillFormDialog
          target={dialog.target}
          today={today}
          categories={categories}
          paymentMethods={paymentMethods}
          onClose={() => setDialog(null)}
          onSaved={(message) => void afterChange(message)}
        />
      )}
      {dialog?.kind === 'pay' && (
        <PayDialog
          bill={dialog.bill}
          today={today}
          paymentMethods={paymentMethods}
          onClose={() => setDialog(null)}
          onConfirm={(input) => pay(dialog.bill, input)}
        />
      )}
      {dialog?.kind === 'schedule' && (
        <ScheduleDialog
          bill={dialog.bill}
          today={today}
          onClose={() => setDialog(null)}
          onConfirm={(scheduledFor) =>
            run(
              () => api.scheduleBill(dialog.bill.id, scheduledFor),
              scheduledFor ? `Agendada para ${formatDateBR(scheduledFor)}.` : 'Agendamento removido.',
            )
          }
        />
      )}
      {dialog?.kind === 'delete' && (
        <DeleteBillDialog
          bill={dialog.bill}
          recurrenceLabel={dialog.bill.templateId !== null ? templates.get(dialog.bill.templateId)?.recurrenceLabel ?? null : null}
          onClose={() => setDialog(null)}
          onDeleteBill={() =>
            run(
              () => api.deleteBill(dialog.bill.id),
              dialog.bill.templateId !== null ? 'Ocorrência pulada.' : 'Conta excluída.',
            )
          }
          onDeleteTemplate={() =>
            run(() => api.deleteBillTemplate(dialog.bill.templateId as number), 'Recorrência excluída.')
          }
        />
      )}
    </div>
  );
}
