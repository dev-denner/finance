import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  AlertTriangle,
  CalendarDays,
  CalendarRange,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Scale,
  Tags,
  TrendingUp,
  Wallet,
} from 'lucide-react';
import { Button } from '../components/ui/Button';
import { Modal } from '../components/ui/Modal';
import { EmptyState, PageHeader } from '../components/ui/Page';
import { useMeta } from '../context/MetaContext';
import { api, errorMessage } from '../lib/api';
import {
  categoryColorHex,
  formatBRL,
  formatCents,
  formatDateBR,
  formatInstallments,
  MONTHS_LONG,
  MONTHS_SHORT,
} from '../lib/format';
import type {
  AccountCashFlowResult,
  ConsolidationResponse,
  ConsolidationRow,
  DateField,
  Transaction,
  TransactionKind,
} from '../lib/types';

type ConsolidationKind = Exclude<TransactionKind, 'all'>;

const KIND_LABELS: Record<ConsolidationKind, { singular: string; plural: string; note: string }> = {
  expenses: {
    singular: 'Despesa',
    plural: 'Despesas',
    note: 'Despesas exibidas como valores positivos. Transferências internas e pagamentos de fatura não são incluídos.',
  },
  income: {
    singular: 'Receita',
    plural: 'Receitas',
    note: 'Receitas exibidas com valores positivos. Transferências não são incluídas.',
  },
  transfers: {
    singular: 'Transferência',
    plural: 'Transferências',
    note: 'Transferências isoladas de despesas e receitas. Valores exibidos em módulo.',
  },
};

interface SelectedCell {
  category: ConsolidationRow;
  month: number;
}

function Stat({
  label,
  value,
  detail,
  icon: Icon,
}: {
  label: string;
  value: string;
  detail: string;
  icon: typeof Scale;
}) {
  return (
    <div className="card flex items-start gap-3 px-4 py-3.5">
      <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-ink-100 text-ink-500 dark:bg-ink-800 dark:text-ink-300">
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-400">{label}</p>
        <p className="num truncate text-[17px] font-semibold tracking-tight text-ink-900 dark:text-white">
          {value}
        </p>
        <p className="truncate text-[11px] text-ink-400">{detail}</p>
      </div>
    </div>
  );
}

function DetailsModal({
  year,
  dateField,
  kind,
  cell,
  onClose,
}: {
  year: number;
  dateField: DateField;
  kind: ConsolidationKind;
  cell: SelectedCell;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const [rows, setRows] = useState<Transaction[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    api
      .getConsolidationDetails(year, cell.month, cell.category.categoryId, dateField, kind)
      .then((response) => {
        if (!active) return;
        setRows(response.rows);
        setTotal(response.total);
      })
      .catch((err) => {
        if (!active) return;
        setError(errorMessage(err));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [year, dateField, kind, cell]);

  const openInTransactions = () => {
    const params = new URLSearchParams({
      year: String(year),
      month: String(cell.month),
      dateField,
      categoryId: String(cell.category.categoryId),
      kind,
      pageSize: '25',
    });
    navigate(`/lancamentos?${params.toString()}`);
    onClose();
  };

  const displayedTotal = rows.reduce(
    (sum, row) => sum + (kind === 'income' ? row.amountCents : Math.abs(row.amountCents)),
    0,
  );

  return (
    <Modal
      title={`${cell.category.categoryName} · ${MONTHS_LONG[cell.month - 1]} de ${year}`}
      description={`${cell.category.monthCounts[cell.month - 1]} lançamento(s) em ${
        KIND_LABELS[kind].plural.toLowerCase()
      }${dateField === 'due' ? ' por vencimento' : ' por data da compra'}.`}
      onClose={onClose}
      size="xl"
      footer={
        <>
          <Button onClick={onClose}>Fechar</Button>
          <Button variant="primary" onClick={openInTransactions}>
            Abrir em movimentações
          </Button>
        </>
      }
    >
      {loading ? (
        <div className="flex items-center justify-center gap-2 py-12 text-[13px] text-ink-400">
          <Loader2 className="h-4 w-4 animate-spin" />
          Carregando lançamentos...
        </div>
      ) : error ? (
        <div className="flex items-center gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-3 text-[13px] text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/30 dark:text-rose-300">
          <AlertTriangle className="h-4 w-4" />
          {error}
        </div>
      ) : (
        <div>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-[12px] text-ink-500 dark:text-ink-400">
            <span>{total} lançamento(s) correspondente(s)</span>
            <span className="num font-semibold text-ink-800 dark:text-ink-100">
              Total: {formatBRL(displayedTotal)}
            </span>
          </div>
          <div className="max-h-[55vh] overflow-auto rounded-lg border border-ink-200 dark:border-ink-800">
            <table className="w-full min-w-[720px]">
              <thead className="sticky top-0">
                <tr>
                  <th className="th">Compra</th>
                  <th className="th">Compra em</th>
                  <th className="th">Vencimento</th>
                  <th className="th">Pagamento</th>
                  <th className="th text-right">Valor</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className="hover:bg-ink-50/70 dark:hover:bg-ink-800/30">
                    <td className="td">
                      <p className="font-medium text-ink-800 dark:text-ink-100">
                        {row.description}
                      </p>
                      <p className="text-[11px] text-ink-400">
                        {formatInstallments(row.installmentNumber, row.installmentTotal)} ·{' '}
                        {row.categoryName}
                      </p>
                    </td>
                    <td className="td whitespace-nowrap text-ink-500 dark:text-ink-400">
                      {formatDateBR(row.purchaseDate)}
                    </td>
                    <td className="td whitespace-nowrap text-ink-500 dark:text-ink-400">
                      {formatDateBR(row.dueDate)}
                    </td>
                    <td className="td text-ink-600 dark:text-ink-300">
                      {row.paymentMethodName}
                    </td>
                    <td
                      className={`td num whitespace-nowrap text-right font-medium ${
                        row.amountCents < 0
                          ? 'text-rose-600 dark:text-rose-400'
                          : 'text-emerald-600 dark:text-emerald-400'
                      }`}
                    >
                      {formatBRL(row.amountCents)}
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-4 py-10 text-center text-[13px] text-ink-400">
                      Nenhum lançamento encontrado.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {total > rows.length && (
            <p className="mt-2 text-[11px] text-ink-400">
              Exibindo os primeiros {rows.length} de {total}. Use “Abrir em movimentações” para ver
              todos com paginação.
            </p>
          )}
          <p className="mt-3 text-[11px] text-ink-400">
            Os valores acima seguem o sinal armazenado no banco. No relatório, despesas aparecem
            como positivas.
          </p>
        </div>
      )}
    </Modal>
  );
}

export function ConsolidatedPage() {
  const { meta } = useMeta();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [data, setData] = useState<ConsolidationResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedCell, setSelectedCell] = useState<SelectedCell | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [cashFlow, setCashFlow] = useState<AccountCashFlowResult | null>(null);
  const [cashFlowLoading, setCashFlowLoading] = useState(true);
  const [cashFlowError, setCashFlowError] = useState<string | null>(null);

  const latestYear = Number(meta?.latestDueDate?.slice(0, 4)) || new Date().getFullYear();
  const yearParam = Number(searchParams.get('year'));
  const year =
    Number.isInteger(yearParam) && yearParam >= 1900 && yearParam <= 2200
      ? yearParam
      : meta
        ? latestYear
        : new Date().getFullYear();
  const dateField: DateField =
    searchParams.get('dateField') === 'purchase' ? 'purchase' : 'due';
  const rawKind = searchParams.get('kind');
  const kind: ConsolidationKind =
    rawKind === 'income' || rawKind === 'transfers' ? rawKind : 'expenses';

  const update = useCallback(
    (updates: Record<string, string | number | null>) => {
      setSearchParams(
        (previous) => {
          const next = new URLSearchParams(previous);
          for (const [key, value] of Object.entries(updates)) {
            if (value === null || value === '') next.delete(key);
            else next.set(key, String(value));
          }
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    api
      .getConsolidation(year, dateField, kind)
      .then((response) => {
        if (!active) return;
        setData(response);
      })
      .catch((err) => {
        if (!active) return;
        setError(errorMessage(err));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [year, dateField, kind, refreshKey]);

  useEffect(() => {
    let active = true;
    setCashFlowLoading(true);
    setCashFlowError(null);
    api
      .getAccountCashFlow(year, dateField)
      .then((response) => {
        if (active) setCashFlow(response);
      })
      .catch((err) => {
        if (active) setCashFlowError(errorMessage(err));
      })
      .finally(() => {
        if (active) setCashFlowLoading(false);
      });
    return () => {
      active = false;
    };
  }, [year, dateField, refreshKey]);

  const yearOptions = useMemo(() => {
    const values = new Set<number>(meta?.years ?? []);
    values.add(year);
    values.add(new Date().getFullYear());
    return [...values].sort((a, b) => b - a);
  }, [meta, year]);

  const categories = data?.categories ?? [];
  const totals = data?.totals;
  const kindInfo = KIND_LABELS[kind];

  const changeYear = (nextYear: number) => {
    if (nextYear < 1900 || nextYear > 2200) return;
    update({ year: nextYear });
  };

  return (
    <div>
      <PageHeader
        title="Consolidado"
        subtitle="Visão anual por categoria, com totais e médias calculados diretamente dos lançamentos."
        actions={
          <Button variant="secondary" onClick={() => setRefreshKey((key) => key + 1)}>
            <TrendingUp className="h-3.5 w-3.5" />
            Atualizar
          </Button>
        }
      />

      <div className="card p-3.5">
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="inline-flex items-center gap-1 rounded-lg border border-ink-200 bg-white px-1 py-0.5 dark:border-ink-700 dark:bg-ink-900">
            <button
              type="button"
              className="icon-btn h-7 w-7"
              onClick={() => changeYear(year - 1)}
              aria-label="Ano anterior"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <select
              className="select h-8 w-[100px] border-0 bg-transparent px-1 text-sm font-semibold shadow-none focus:ring-0 dark:bg-transparent"
              value={year}
              onChange={(event) => changeYear(Number(event.target.value))}
              aria-label="Ano do consolidado"
            >
              {yearOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="icon-btn h-7 w-7"
              onClick={() => changeYear(year + 1)}
              aria-label="Próximo ano"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>

          <div className="inline-flex rounded-lg border border-ink-200 bg-ink-50 p-0.5 dark:border-ink-700 dark:bg-ink-950/50">
            {(['due', 'purchase'] as DateField[]).map((field) => (
              <button
                key={field}
                type="button"
                onClick={() => update({ dateField: field === 'due' ? null : field })}
                className={`rounded-md px-2.5 py-1.5 text-[12px] font-medium transition ${
                  dateField === field
                    ? 'bg-white text-ink-900 shadow-sm dark:bg-ink-800 dark:text-white'
                    : 'text-ink-500 hover:text-ink-800 dark:text-ink-400 dark:hover:text-white'
                }`}
              >
                {field === 'due' ? 'Vencimento' : 'Data da compra'}
              </button>
            ))}
          </div>

          <div className="ml-auto inline-flex rounded-lg border border-ink-200 bg-ink-50 p-0.5 dark:border-ink-700 dark:bg-ink-950/50">
            {(Object.keys(KIND_LABELS) as ConsolidationKind[]).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => update({ kind: option === 'expenses' ? null : option })}
                className={`rounded-md px-3 py-1.5 text-[12px] font-medium transition ${
                  kind === option
                    ? 'bg-white text-ink-900 shadow-sm dark:bg-ink-800 dark:text-white'
                    : 'text-ink-500 hover:text-ink-800 dark:text-ink-400 dark:hover:text-white'
                }`}
              >
                {KIND_LABELS[option].plural}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          label={`Total de ${kindInfo.plural.toLowerCase()}`}
          value={formatBRL(totals?.totalCents ?? 0, { absolute: true })}
          detail={`Ano de ${year}`}
          icon={Scale}
        />
        <Stat
          label="Média mensal"
          value={formatBRL(totals?.averageCents ?? 0, { absolute: true })}
          detail={
            totals?.monthsWithData
              ? `${totals.monthsWithData} mês(es) com movimento`
              : 'Sem meses com movimento'
          }
          icon={TrendingUp}
        />
        <Stat
          label="Meses com movimento"
          value={String(totals?.monthsWithData ?? 0)}
          detail="Meses considerados na média"
          icon={CalendarDays}
        />
        <Stat
          label="Categorias"
          value={String(categories.length)}
          detail={`Com ${kindInfo.plural.toLowerCase()} no ano`}
          icon={Tags}
        />
      </div>

      <div className="card mt-4 overflow-hidden">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-ink-200 px-4 py-3.5 dark:border-ink-800">
          <div>
            <h2 className="flex items-center gap-2 text-sm font-semibold text-ink-900 dark:text-white">
              <Wallet className="h-4 w-4 text-blue-500" />
              Fluxo de caixa por conta · {year}
            </h2>
            <p className="mt-0.5 text-[11px] text-ink-400">
              Entradas e saídas efetivas por forma de pagamento. Inclui transferências entre contas
              e pagamentos de fatura, que permanecem visíveis como saída de caixa sem entrar como
              nova despesa no resultado.
            </p>
          </div>
          <span className="text-[11px] text-ink-400">
            {cashFlow?.totals.transactionCount ?? 0} lançamento(s)
          </span>
        </div>

        {cashFlowError && (
          <div className="flex items-center gap-2 border-b border-rose-200 bg-rose-50 px-4 py-2.5 text-[12px] text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/30 dark:text-rose-300">
            <AlertTriangle className="h-4 w-4" />
            {cashFlowError}
          </div>
        )}

        {cashFlowLoading && !cashFlow ? (
          <div className="flex items-center justify-center gap-2 py-10 text-[12px] text-ink-400">
            <Loader2 className="h-4 w-4 animate-spin" />
            Calculando fluxo de caixa...
          </div>
        ) : !cashFlow || cashFlow.rows.length === 0 ? (
          <p className="px-4 py-8 text-center text-[12px] text-ink-400">
            Nenhuma conta com movimento em {year}.
          </p>
        ) : (
          <div className="table-shell max-h-[360px]">
            <table className="w-full min-w-[860px]">
              <thead className="sticky top-0">
                <tr>
                  <th className="th">Conta / forma de pagamento</th>
                  <th className="th text-right">Lanç.</th>
                  <th className="th text-right">Entradas</th>
                  <th className="th text-right">Saídas</th>
                  <th className="th text-right">Transferências</th>
                  <th className="th text-right">Fatura</th>
                  <th className="th text-right">Saldo de caixa</th>
                </tr>
              </thead>
              <tbody>
                {cashFlow.rows.map((row) => (
                  <tr key={row.paymentMethodId} className="hover:bg-ink-50/70 dark:hover:bg-ink-800/30">
                    <td className="td font-medium text-ink-800 dark:text-ink-100">
                      {row.paymentMethodName}
                    </td>
                    <td className="td num text-right text-ink-500 dark:text-ink-400">
                      {row.transactionCount}
                    </td>
                    <td className="td num text-right font-medium text-emerald-600 dark:text-emerald-400">
                      {formatBRL(row.inCents)}
                    </td>
                    <td className="td num text-right font-medium text-rose-600 dark:text-rose-400">
                      {formatBRL(row.outCents)}
                    </td>
                    <td className="td num text-right text-violet-600 dark:text-violet-400">
                      {formatBRL(row.transferCents)}
                    </td>
                    <td className="td num text-right text-amber-600 dark:text-amber-400">
                      {formatBRL(row.cardSettlementCents)}
                    </td>
                    <td
                      className={`td num text-right font-semibold ${
                        row.netCents < 0
                          ? 'text-rose-600 dark:text-rose-400'
                          : 'text-emerald-600 dark:text-emerald-400'
                      }`}
                    >
                      {formatBRL(row.netCents)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-ink-200 bg-ink-100/80 dark:border-ink-700 dark:bg-ink-800/80">
                  <td className="td font-semibold text-ink-800 dark:text-ink-100">Total</td>
                  <td className="td num text-right font-semibold">{cashFlow.totals.transactionCount}</td>
                  <td className="td num text-right font-semibold text-emerald-700 dark:text-emerald-300">
                    {formatBRL(cashFlow.totals.inCents)}
                  </td>
                  <td className="td num text-right font-semibold text-rose-700 dark:text-rose-300">
                    {formatBRL(cashFlow.totals.outCents)}
                  </td>
                  <td className="td num text-right font-semibold text-violet-700 dark:text-violet-300">
                    {formatBRL(cashFlow.totals.transferCents)}
                  </td>
                  <td className="td num text-right font-semibold text-amber-700 dark:text-amber-300">
                    {formatBRL(cashFlow.totals.cardSettlementCents)}
                  </td>
                  <td className="td num text-right font-bold text-ink-900 dark:text-white">
                    {formatBRL(cashFlow.totals.netCents)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
        <div className="border-t border-ink-200 px-4 py-2.5 text-[10px] leading-relaxed text-ink-400 dark:border-ink-800">
          As colunas Transferências e Fatura são informativas: esses valores já estão incluídos
          nas saídas da conta. O resultado financeiro (receitas menos despesas) aparece nas abas
          acima e não é afetado por transferências internas nem pelo pagamento da fatura. Para
          ativar esse tratamento, classifique as categorias correspondentes em Cadastros.
        </div>
      </div>

      <div className="card mt-4 overflow-hidden">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-ink-200 px-4 py-3.5 dark:border-ink-800">
          <div>
            <h2 className="flex items-center gap-2 text-sm font-semibold text-ink-900 dark:text-white">
              <CalendarRange className="h-4 w-4 text-ink-400" />
              {kindInfo.plural} por categoria · {year}
            </h2>
            <p className="mt-0.5 text-[11px] text-ink-400">{kindInfo.note}</p>
          </div>
          <p className="text-[11px] text-ink-400">
            Clique em uma célula para ver os lançamentos
          </p>
        </div>

        {error && (
          <div className="flex items-center gap-2 border-b border-rose-200 bg-rose-50 px-4 py-2.5 text-[12px] text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/30 dark:text-rose-300">
            <AlertTriangle className="h-4 w-4" />
            {error}
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center gap-2 py-16 text-[13px] text-ink-400">
            <Loader2 className="h-4 w-4 animate-spin" />
            Calculando consolidado...
          </div>
        ) : categories.length === 0 ? (
          <EmptyState
            icon={CalendarRange}
            title="Nenhum valor para este ano"
            description={`Não há ${kindInfo.plural.toLowerCase()} ${
              dateField === 'due' ? 'com vencimento' : 'com compra'
            } em ${year}. Importe uma planilha ou altere o ano e a visão.`}
            action={
              <Button
                variant="primary"
                onClick={() => navigate('/importacoes')}
              >
                Ir para importações
              </Button>
            }
          />
        ) : (
          <div className="table-shell max-h-[calc(100vh-26rem)] min-h-[260px]">
            <table className="w-full min-w-[1080px] border-collapse">
              <thead className="sticky top-0 z-20">
                <tr>
                  <th className="th sticky left-0 z-30 min-w-[170px] shadow-[1px_0_0_0_rgba(0,0,0,0.05)]">
                    Categoria
                  </th>
                  <th className="th min-w-[92px] px-2 text-right">Total</th>
                  <th className="th min-w-[90px] px-2 text-right">Média</th>
                  {MONTHS_SHORT.map((monthName, index) => (
                    <th key={monthName} className="th min-w-[62px] px-2 text-right">
                      <span className="block">{monthName}</span>
                      <span className="block text-[9px] font-normal normal-case tracking-normal text-ink-300 dark:text-ink-500">
                        {String(index + 1).padStart(2, '0')}/{year}
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {categories.map((category) => {
                  const color = categoryColorHex(category.categoryId, category.color);
                  return (
                  <tr
                    key={category.categoryId}
                    className="group transition hover:bg-ink-50/70 dark:hover:bg-ink-800/30"
                  >
                    <td
                      className="td sticky left-0 z-10 border-l-4 bg-white/95 pl-2.5 backdrop-blur group-hover:bg-ink-50 dark:bg-ink-900/95 dark:group-hover:bg-ink-800/70"
                      style={{ borderLeftColor: color }}
                    >
                      <div className="flex items-center gap-2">
                        <span
                          className="h-2 w-2 shrink-0 rounded-full"
                          style={{ backgroundColor: color }}
                        />
                        <span
                          className="max-w-[170px] truncate font-medium text-ink-800 dark:text-ink-100"
                          title={category.categoryName}
                        >
                          {category.categoryName}
                        </span>
                      </div>
                      <p className="mt-0.5 pl-4 text-[10px] text-ink-400">
                        {category.monthsWithData} mês(es) com movimento
                      </p>
                    </td>
                    <td className="td num px-2 text-right font-semibold text-ink-900 dark:text-white">
                      {formatCents(category.totalCents)}
                    </td>
                    <td
                      className="td num px-2 text-right font-medium text-ink-600 dark:text-ink-300"
                      title={`Total dividido por ${category.monthsWithData} mês(es) com lançamentos`}
                    >
                      {formatCents(category.averageCents)}
                    </td>
                    {MONTHS_SHORT.map((monthName, index) => {
                      const value = category.monthTotals[index];
                      const count = category.monthCounts[index];
                      const clickable = count > 0;
                      return (
                        <td key={`${category.categoryId}-${monthName}`} className="td p-1 text-right">
                          <button
                            type="button"
                            disabled={!clickable}
                            onClick={() => setSelectedCell({ category, month: index + 1 })}
                            title={
                              clickable
                                ? `${count} lançamento(s) em ${MONTHS_LONG[index]} · clique para detalhar`
                                : 'Sem lançamentos neste mês'
                            }
                            className={`num flex h-7 w-full items-center justify-end rounded px-1.5 text-[12px] transition ${
                              clickable
                                ? value === 0
                                  ? 'font-semibold text-ink-700 hover:bg-blue-50 hover:text-blue-700 dark:text-ink-200 dark:hover:bg-blue-950/40 dark:hover:text-blue-300'
                                  : 'font-medium text-ink-800 hover:bg-blue-50 hover:text-blue-700 dark:text-ink-100 dark:hover:bg-blue-950/40 dark:hover:text-blue-300'
                                : 'cursor-default text-ink-300 dark:text-ink-600'
                            }`}
                          >
                            {formatCents(value)}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                  );
                })}
              </tbody>
              <tfoot className="sticky bottom-0 z-20">
                <tr className="border-t-2 border-ink-200 bg-ink-100/95 backdrop-blur dark:border-ink-700 dark:bg-ink-800/95">
                  <td className="sticky left-0 z-30 border-t border-ink-200 bg-ink-100 px-3 py-3 text-[12px] font-bold uppercase tracking-wide text-ink-700 dark:border-ink-700 dark:bg-ink-800 dark:text-ink-100">
                    Total
                  </td>
                  <td className="num px-2 py-3 text-right text-[13px] font-bold text-ink-900 dark:text-white">
                    {formatCents(totals?.totalCents ?? 0)}
                  </td>
                  <td className="num px-2 py-3 text-right text-[13px] font-bold text-ink-900 dark:text-white">
                    {formatCents(totals?.averageCents ?? 0)}
                  </td>
                  {MONTHS_SHORT.map((monthName, index) => (
                    <td
                      key={`total-${monthName}`}
                      className={`num px-2 py-3 text-right text-[12px] font-semibold ${
                        (totals?.monthCounts[index] ?? 0) > 0
                          ? 'text-ink-900 dark:text-white'
                          : 'text-ink-400 dark:text-ink-500'
                      }`}
                    >
                      {formatCents(totals?.monthTotals[index] ?? 0)}
                    </td>
                  ))}
                </tr>
              </tfoot>
            </table>
          </div>
        )}

        <div className="border-t border-ink-200 px-4 py-2.5 text-[11px] leading-relaxed text-ink-400 dark:border-ink-800">
          A média considera apenas os meses que possuem lançamentos na categoria, mesmo quando o
          saldo líquido do mês é zero. Meses sem lançamentos aparecem como 0,00.
        </div>
      </div>

      {selectedCell && (
        <DetailsModal
          year={year}
          dateField={dateField}
          kind={kind}
          cell={selectedCell}
          onClose={() => setSelectedCell(null)}
        />
      )}
    </div>
  );
}
