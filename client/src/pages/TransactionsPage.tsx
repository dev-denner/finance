import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowDown,
  ArrowDownLeft,
  ArrowRightLeft,
  ArrowUp,
  ArrowUpRight,
  ArrowUpDown,
  Check,
  CreditCard,
  FileUp,
  Link2,
  Loader2,
  Pencil,
  Plus,
  ReceiptText,
  RotateCcw,
  Scale,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { Button } from '../components/ui/Button';
import { Field } from '../components/ui/Field';
import { Modal } from '../components/ui/Modal';
import { EmptyState, PageHeader } from '../components/ui/Page';
import { TransferModal } from '../components/TransferModal';
import { useMeta } from '../context/MetaContext';
import { useSelection } from '../context/SelectionContext';
import { useToast } from '../context/ToastContext';
import { api, errorMessage, ApiError } from '../lib/api';
import {
  categoryColorHex,
  centsToPlain,
  formatBRL,
  formatDateBR,
  formatInstallments,
  isoToParts,
  MONTHS_LONG,
  todayISO,
} from '../lib/format';
import type {
  DateField,
  Lookup,
  Transaction,
  TransactionFilters,
  TransactionKind,
  TransactionListResponse,
  TransactionSummary,
} from '../lib/types';

const SORT_FIELDS = [
  'dueDate',
  'purchaseDate',
  'amount',
  'description',
  'categoryName',
  'paymentMethodName',
  'createdAt',
] as const;

/** Campos textuais que iniciam em ordem alfabética crescente. */
const ASC_FIRST_FIELDS = new Set<(typeof SORT_FIELDS)[number]>([
  'categoryName',
  'paymentMethodName',
]);
const KIND_OPTIONS: { value: TransactionKind; label: string }[] = [
  { value: 'all', label: 'Todos os tipos' },
  { value: 'expenses', label: 'Despesas' },
  { value: 'income', label: 'Receitas' },
  { value: 'transfers', label: 'Transferências' },
];

function toInt(value: string | null): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

type BulkConfirm =
  | { type: 'category'; targetId: number }
  | { type: 'payment'; targetId: number }
  | { type: 'delete' };

interface EditDraft {
  purchaseDate: string;
  dueDate: string;
  description: string;
  amount: string;
  paymentMethodId: number;
  categoryId: number;
  installmentNumber: string;
  installmentTotal: string;
  transfer: string;
}

function draftFrom(transaction: Transaction): EditDraft {
  return {
    purchaseDate: transaction.purchaseDate,
    dueDate: transaction.dueDate,
    description: transaction.description,
    amount: centsToPlain(transaction.amountCents),
    paymentMethodId: transaction.paymentMethodId,
    categoryId: transaction.categoryId,
    installmentNumber: transaction.installmentNumber?.toString() ?? '',
    installmentTotal: transaction.installmentTotal?.toString() ?? '',
    transfer: transaction.transfer ?? '',
  };
}

function SummaryCard({
  label,
  value,
  detail,
  tone,
  icon: Icon,
}: {
  label: string;
  value: string;
  detail: string;
  tone: 'rose' | 'emerald' | 'blue' | 'neutral';
  icon: typeof Scale;
}) {
  const tones = {
    rose: 'text-rose-600 bg-rose-50 dark:text-rose-400 dark:bg-rose-950/40',
    emerald: 'text-emerald-600 bg-emerald-50 dark:text-emerald-400 dark:bg-emerald-950/40',
    blue: 'text-blue-600 bg-blue-50 dark:text-blue-400 dark:bg-blue-950/40',
    neutral: 'text-ink-600 bg-ink-100 dark:text-ink-300 dark:bg-ink-800',
  };

  return (
    <div className="card flex items-center gap-3.5 px-4 py-3.5">
      <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${tones[tone]}`}>
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

function SortHeader({
  label,
  field,
  current,
  dir,
  onClick,
  align = 'left',
}: {
  label: string;
  field: (typeof SORT_FIELDS)[number];
  current: string;
  dir: 'asc' | 'desc';
  onClick: (field: (typeof SORT_FIELDS)[number]) => void;
  align?: 'left' | 'right';
}) {
  const active = current === field;
  const Icon = active ? (dir === 'asc' ? ArrowUp : ArrowDown) : ArrowUpDown;
  return (
    <th
      className={`th ${align === 'right' ? 'text-right' : ''}`}
      aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button
        type="button"
        onClick={() => onClick(field)}
        className={`inline-flex items-center gap-1 transition hover:text-ink-800 dark:hover:text-ink-100 ${
          align === 'right' ? 'flex-row-reverse' : ''
        } ${active ? 'text-ink-800 dark:text-ink-100' : ''}`}
      >
        {label}
        <Icon className={`h-3 w-3 ${active ? 'opacity-90' : 'opacity-35'}`} />
      </button>
    </th>
  );
}

function AddTransactionModal({
  categories,
  payments,
  onClose,
  onSaved,
}: {
  categories: Lookup[];
  payments: Lookup[];
  onClose: () => void;
  onSaved: (transaction: Transaction) => void;
}) {
  const { showToast } = useToast();
  const today = todayISO();
  const [form, setForm] = useState({
    purchaseDate: today,
    dueDate: today,
    description: '',
    amount: '',
    categoryId: categories[0]?.id ?? 0,
    paymentMethodId: payments[0]?.id ?? 0,
    installmentNumber: '',
    installmentTotal: '',
    transfer: '',
  });
  const [saving, setSaving] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const update = (field: string, value: string | number) => {
    setForm((current) => ({ ...current, [field]: value }));
    setFieldErrors((current) => ({ ...current, [field]: '' }));
  };

  const submit = async () => {
    setFieldErrors({});
    setSaving(true);
    try {
      const created = await api.createTransaction({
        purchaseDate: form.purchaseDate,
        dueDate: form.dueDate,
        description: form.description,
        amount: form.amount,
        categoryId: Number(form.categoryId) || undefined,
        paymentMethodId: Number(form.paymentMethodId) || undefined,
        installmentNumber: form.installmentNumber ? Number(form.installmentNumber) : null,
        installmentTotal: form.installmentTotal ? Number(form.installmentTotal) : null,
        transfer: form.transfer || null,
      });
      showToast('Lançamento criado com sucesso.');
      onSaved(created);
    } catch (error) {
      if (error instanceof ApiError && error.issues?.length) {
        const errors: Record<string, string> = {};
        for (const issue of error.issues) {
          if (issue.path) errors[issue.path] = issue.message;
        }
        setFieldErrors(errors);
        showToast(errorMessage(error), 'error');
      } else {
        showToast(errorMessage(error), 'error');
      }
    } finally {
      setSaving(false);
    }
  };

  const canSubmit =
    categories.length > 0 &&
    payments.length > 0 &&
    form.description.trim().length > 0 &&
    form.amount.trim().length > 0;

  return (
    <Modal
      title="Novo lançamento"
      description="Use valores negativos para despesas e positivos para receitas."
      onClose={onClose}
      size="lg"
      footer={
        <>
          <Button onClick={onClose} disabled={saving}>
            Cancelar
          </Button>
          <Button variant="primary" onClick={submit} loading={saving} disabled={!canSubmit}>
            Criar lançamento
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Data da compra" required error={fieldErrors.purchaseDate}>
          <input
            type="date"
            className="input"
            value={form.purchaseDate}
            onChange={(event) => update('purchaseDate', event.target.value)}
          />
        </Field>
        <Field label="Vencimento" required error={fieldErrors.dueDate}>
          <input
            type="date"
            className="input"
            value={form.dueDate}
            onChange={(event) => update('dueDate', event.target.value)}
          />
        </Field>
        <Field label="Descrição" required className="sm:col-span-2" error={fieldErrors.description}>
          <input
            className="input"
            value={form.description}
            placeholder="Ex.: Supermercado, aluguel, salário"
            onChange={(event) => update('description', event.target.value)}
            autoFocus
          />
        </Field>
        <Field
          label="Valor"
          required
          hint="Aceita -500,00, R$ 1.250,50 ou -R$ 500.00"
          error={fieldErrors.amount}
        >
          <input
            className="input num"
            value={form.amount}
            placeholder="-R$ 0,00"
            onChange={(event) => update('amount', event.target.value)}
          />
        </Field>
        <Field label="Parcelas" hint="Ex.: 1/12. Deixe em branco se não houver.">
          <div className="flex gap-2">
            <input
              className="input num"
              inputMode="numeric"
              placeholder="Parcela"
              value={form.installmentNumber}
              onChange={(event) => update('installmentNumber', event.target.value)}
            />
            <input
              className="input num"
              inputMode="numeric"
              placeholder="Total"
              value={form.installmentTotal}
              onChange={(event) => update('installmentTotal', event.target.value)}
            />
          </div>
        </Field>
        <Field label="Categoria" required error={fieldErrors.categoryId}>
          <select
            className="select"
            value={form.categoryId}
            onChange={(event) => update('categoryId', Number(event.target.value))}
            disabled={categories.length === 0}
          >
            {categories.length === 0 && <option value={0}>Cadastre uma categoria</option>}
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Pagamento" required error={fieldErrors.paymentMethodId}>
          <select
            className="select"
            value={form.paymentMethodId}
            onChange={(event) => update('paymentMethodId', Number(event.target.value))}
            disabled={payments.length === 0}
          >
            {payments.length === 0 && <option value={0}>Cadastre uma forma de pagamento</option>}
            {payments.map((payment) => (
              <option key={payment.id} value={payment.id}>
                {payment.name}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Transferência"
          className="sm:col-span-2"
          hint="Preencha apenas se o lançamento for uma transferência."
          error={fieldErrors.transfer}
        >
          <input
            className="input"
            value={form.transfer}
            placeholder="Ex.: Transferência para poupança"
            onChange={(event) => update('transfer', event.target.value)}
          />
        </Field>
      </div>
      {(categories.length === 0 || payments.length === 0) && (
        <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
          Cadastre ao menos uma categoria e uma forma de pagamento em Cadastros antes de criar um
          lançamento manual.
        </p>
      )}
    </Modal>
  );
}

export function TransactionsPage() {
  const { meta, loading: metaLoading, refresh: refreshMeta } = useMeta();
  const { showToast } = useToast();
  const navigate = useNavigate();
  const {
    selectedIds,
    selectedCount,
    toggle,
    setMany,
    remove,
    clear,
  } = useSelection();
  const [searchParams, setSearchParams] = useSearchParams();

  const [result, setResult] = useState<TransactionListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetching, setFetching] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const [draftSearch, setDraftSearch] = useState(searchParams.get('search') ?? '');
  const [editing, setEditing] = useState<{ id: number; draft: EditDraft } | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);
  const [savingRowId, setSavingRowId] = useState<number | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Transaction | null>(null);
  const [bulkConfirm, setBulkConfirm] = useState<BulkConfirm | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [transferTarget, setTransferTarget] = useState<Transaction | null>(null);
  const headerCheckbox = useRef<HTMLInputElement>(null);

  const dateField: DateField =
    searchParams.get('dateField') === 'purchase' ? 'purchase' : 'due';
  const latestReference =
    dateField === 'purchase' ? meta?.latestPurchaseDate : meta?.latestDueDate;
  const fallback = isoToParts(latestReference) ?? {
    year: new Date().getFullYear(),
    month: new Date().getMonth() + 1,
  };

  const year = toInt(searchParams.get('year')) ?? fallback.year;
  const month = searchParams.has('month')
    ? searchParams.get('month') === 'all'
      ? undefined
      : toInt(searchParams.get('month'))
    : searchParams.has('year')
      ? undefined
      : fallback.month;
  const categoryId = toInt(searchParams.get('categoryId'));
  const paymentMethodId = toInt(searchParams.get('paymentMethodId'));
  const search = searchParams.get('search') ?? '';
  const rawKind = searchParams.get('kind');
  const kind: TransactionKind =
    rawKind === 'expenses' || rawKind === 'income' || rawKind === 'transfers' ? rawKind : 'all';
  const rawSort = searchParams.get('sortBy');
  const sortBy = (SORT_FIELDS as readonly string[]).includes(rawSort ?? '')
    ? (rawSort as (typeof SORT_FIELDS)[number])
    : 'dueDate';
  const sortDir = searchParams.get('sortDir') === 'asc' ? 'asc' : 'desc';
  const page = toInt(searchParams.get('page')) ?? 1;
  const pageSize = toInt(searchParams.get('pageSize')) ?? 25;

  const filters: TransactionFilters = useMemo(
    () => ({
      year,
      month,
      dateField,
      categoryId,
      paymentMethodId,
      search: search || undefined,
      kind,
      sortBy,
      sortDir,
      page,
      pageSize,
    }),
    [
      year,
      month,
      dateField,
      categoryId,
      paymentMethodId,
      search,
      kind,
      sortBy,
      sortDir,
      page,
      pageSize,
    ],
  );

  const updateParams = useCallback(
    (
      updates: Record<string, string | number | null | undefined>,
      options: { keepPage?: boolean } = {},
    ) => {
      setSearchParams(
        (previous) => {
          const next = new URLSearchParams(previous);
          for (const [key, value] of Object.entries(updates)) {
            if (value === null || value === undefined || value === '') next.delete(key);
            else next.set(key, String(value));
          }
          if (!options.keepPage) next.delete('page');
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  useEffect(() => {
    if (metaLoading) return;
    if (searchParams.has('year') || searchParams.has('month')) return;
    const parts = isoToParts(latestReference) ?? {
      year: new Date().getFullYear(),
      month: new Date().getMonth() + 1,
    };
    updateParams({ year: parts.year, month: parts.month }, { keepPage: true });
  }, [metaLoading, searchParams, latestReference, updateParams]);

  useEffect(() => {
    setDraftSearch(search);
  }, [search]);

  useEffect(() => {
    if (draftSearch === search) return;
    const timer = window.setTimeout(() => {
      updateParams({ search: draftSearch || null });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [draftSearch, search, updateParams]);

  useEffect(() => {
    if (metaLoading) return;
    let active = true;
    setFetching(true);
    setListError(null);
    api
      .listTransactions(filters)
      .then((data) => {
        if (!active) return;
        setResult(data);
      })
      .catch((error) => {
        if (!active) return;
        setListError(errorMessage(error));
      })
      .finally(() => {
        if (!active) return;
        setLoading(false);
        setFetching(false);
      });
    return () => {
      active = false;
    };
  }, [filters, refreshKey, metaLoading]);

  useEffect(() => {
    setEditing(null);
  }, [year, month, dateField, categoryId, paymentMethodId, search, kind, page, pageSize]);

  const reload = useCallback(() => setRefreshKey((key) => key + 1), []);
  const rows = result?.rows ?? [];
  const summary: TransactionSummary = result?.summary ?? {
    count: 0,
    netCents: 0,
    expenseCents: 0,
    incomeCents: 0,
    resultNetCents: 0,
    cashFlowCents: 0,
    transferCents: 0,
    cardSettlementCents: 0,
  };

  const pageIds = rows.map((row) => row.id);
  const allPageSelected = pageIds.length > 0 && pageIds.every((id) => selectedIds.has(id));
  const somePageSelected = pageIds.some((id) => selectedIds.has(id));
  const selectedOutsidePage = selectedCount - pageIds.filter((id) => selectedIds.has(id)).length;

  useEffect(() => {
    if (headerCheckbox.current) {
      headerCheckbox.current.indeterminate = somePageSelected && !allPageSelected;
    }
  }, [somePageSelected, allPageSelected]);

  const yearOptions = useMemo(() => {
    const values = new Set<number>(meta?.years ?? []);
    values.add(year);
    values.add(new Date().getFullYear());
    return [...values].sort((a, b) => b - a);
  }, [meta, year]);

  const categoryColorMap = useMemo(() => {
    const map = new Map<number, string | null>();
    for (const category of meta?.categories ?? []) map.set(category.id, category.color);
    return map;
  }, [meta]);

  const hasActiveFilters =
    Boolean(search) ||
    categoryId !== undefined ||
    paymentMethodId !== undefined ||
    kind !== 'all' ||
    month !== fallback.month ||
    year !== fallback.year;

  const handleSort = (field: (typeof SORT_FIELDS)[number]) => {
    const nextDir =
      sortBy === field
        ? sortDir === 'asc'
          ? 'desc'
          : 'asc'
        : ASC_FIRST_FIELDS.has(field)
          ? 'asc'
          : 'desc';
    updateParams({ sortBy: field, sortDir: nextDir });
  };

  const clearFilters = () => {
    setDraftSearch('');
    setSearchParams(new URLSearchParams(), { replace: true });
  };

  const toggleRow = (transaction: Transaction) => {
    toggle(transaction.id);
  };

  const togglePage = () => {
    setMany(pageIds, !allPageSelected);
  };

  const startEdit = (transaction: Transaction) => {
    setEditing({ id: transaction.id, draft: draftFrom(transaction) });
  };

  const updateDraft = (field: keyof EditDraft, value: string | number) => {
    setEditing((current) =>
      current ? { ...current, draft: { ...current.draft, [field]: value } } : current,
    );
  };

  const saveEdit = async () => {
    if (!editing) return;
    setSavingEdit(true);
    setSavingRowId(editing.id);
    try {
      await api.updateTransaction(editing.id, {
        purchaseDate: editing.draft.purchaseDate,
        dueDate: editing.draft.dueDate,
        description: editing.draft.description,
        amount: editing.draft.amount,
        categoryId: Number(editing.draft.categoryId),
        paymentMethodId: Number(editing.draft.paymentMethodId),
        installmentNumber: editing.draft.installmentNumber
          ? Number(editing.draft.installmentNumber)
          : null,
        installmentTotal: editing.draft.installmentTotal
          ? Number(editing.draft.installmentTotal)
          : null,
        transfer: editing.draft.transfer || null,
      });
      showToast('Lançamento atualizado.');
      setEditing(null);
      reload();
      void refreshMeta();
    } catch (error) {
      showToast(errorMessage(error), 'error');
    } finally {
      setSavingEdit(false);
      setSavingRowId(null);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setSavingRowId(deleteTarget.id);
    try {
      await api.deleteTransaction(deleteTarget.id);
      showToast('Lançamento excluído.');
      remove([deleteTarget.id]);
      setDeleteTarget(null);
      reload();
      void refreshMeta();
    } catch (error) {
      showToast(errorMessage(error), 'error');
    } finally {
      setSavingRowId(null);
    }
  };

  const executeBulk = async () => {
    if (!bulkConfirm || selectedCount === 0) return;
    setBulkBusy(true);
    const ids = [...selectedIds];
    try {
      if (bulkConfirm.type === 'delete') {
        const response = await api.bulkDelete(ids);
        showToast(`${response.deleted} lançamento(s) excluído(s).`);
      } else if (bulkConfirm.type === 'category') {
        const response = await api.bulkUpdate(ids, { categoryId: bulkConfirm.targetId });
        showToast(`${response.updated} lançamento(s) atualizado(s).`);
      } else {
        const response = await api.bulkUpdate(ids, { paymentMethodId: bulkConfirm.targetId });
        showToast(`${response.updated} lançamento(s) atualizado(s).`);
      }
      clear();
      setBulkConfirm(null);
      reload();
      void refreshMeta();
    } catch (error) {
      showToast(errorMessage(error), 'error');
    } finally {
      setBulkBusy(false);
    }
  };

  const bulkLookupName = useMemo(() => {
    if (!bulkConfirm || bulkConfirm.type === 'delete') return '';
    const list =
      bulkConfirm.type === 'category' ? meta?.categories : meta?.paymentMethods;
    return list?.find((item) => item.id === bulkConfirm.targetId)?.name ?? 'registro selecionado';
  }, [bulkConfirm, meta]);

  const handleCreated = (created: Transaction) => {
    setAddOpen(false);
    const parts = isoToParts(created.dueDate);
    updateParams({
      year: parts?.year,
      month: parts?.month,
      dateField: 'due',
      search: null,
      categoryId: null,
      paymentMethodId: null,
      kind: null,
    });
    reload();
    void refreshMeta();
  };

  const updateReference = (field: DateField) => {
    updateParams({ dateField: field === 'due' ? null : field });
  };

  const changeYear = (event: ChangeEvent<HTMLSelectElement>) => {
    updateParams({ year: Number(event.target.value), month: month ?? 'all' });
  };

  const changeMonth = (event: ChangeEvent<HTMLSelectElement>) => {
    const value = event.target.value;
    updateParams({ month: value === 'all' ? 'all' : Number(value) });
  };

  return (
    <div>
      <PageHeader
        title="Lançamentos"
        subtitle="Gerencie as despesas, receitas e transferências do seu fluxo financeiro."
        actions={
          <>
            <Button variant="secondary" onClick={() => navigate('/conciliacao')}>
              <ArrowRightLeft className="h-3.5 w-3.5" />
              Conciliar transferências
            </Button>
            <Button variant="secondary" onClick={reload} disabled={fetching}>
              <RotateCcw className={`h-3.5 w-3.5 ${fetching ? 'animate-spin' : ''}`} />
              Atualizar
            </Button>
            <Button variant="primary" onClick={() => setAddOpen(true)}>
              <Plus className="h-4 w-4" />
              Novo lançamento
            </Button>
          </>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <SummaryCard
          label="Saídas"
          value={formatBRL(summary.expenseCents, { absolute: true })}
          detail="Despesas do resultado"
          tone="rose"
          icon={ArrowDownLeft}
        />
        <SummaryCard
          label="Entradas"
          value={formatBRL(summary.incomeCents)}
          detail="Receitas do resultado"
          tone="emerald"
          icon={ArrowUpRight}
        />
        <SummaryCard
          label="Resultado"
          value={formatBRL(summary.resultNetCents)}
          detail="Receitas menos despesas"
          tone="blue"
          icon={Scale}
        />
        <SummaryCard
          label="Movimento de caixa"
          value={formatBRL(summary.cashFlowCents)}
          detail="Inclui fatura e transferências"
          tone="neutral"
          icon={ArrowRightLeft}
        />
        <SummaryCard
          label="Lançamentos"
          value={String(summary.count)}
          detail="Registros no filtro atual"
          tone="neutral"
          icon={ReceiptText}
        />
      </div>

      <div className="card mt-4 p-3.5">
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="inline-flex rounded-lg border border-ink-200 bg-ink-50 p-0.5 dark:border-ink-700 dark:bg-ink-950/50">
            {(['due', 'purchase'] as DateField[]).map((field) => (
              <button
                key={field}
                type="button"
                onClick={() => updateReference(field)}
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

          <div className="relative min-w-[200px] flex-1 sm:max-w-xs">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400" />
            <input
              className="input pl-8"
              placeholder="Pesquisar descrição..."
              value={draftSearch}
              onChange={(event) => setDraftSearch(event.target.value)}
              aria-label="Pesquisar por descrição"
            />
          </div>

          <select
            className="select w-auto min-w-[92px]"
            value={year}
            onChange={changeYear}
            aria-label="Ano"
          >
            {yearOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>

          <select
            className="select w-auto min-w-[118px]"
            value={month ?? 'all'}
            onChange={changeMonth}
            aria-label="Mês"
          >
            <option value="all">Todos os meses</option>
            {MONTHS_LONG.map((name, index) => (
              <option key={name} value={index + 1}>
                {name}
              </option>
            ))}
          </select>

          <select
            className="select w-auto min-w-[150px]"
            value={categoryId ?? ''}
            onChange={(event) =>
              updateParams({ categoryId: event.target.value ? Number(event.target.value) : null })
            }
            aria-label="Categoria"
          >
            <option value="">Todas as categorias</option>
            {meta?.categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>

          <select
            className="select w-auto min-w-[150px]"
            value={paymentMethodId ?? ''}
            onChange={(event) =>
              updateParams({
                paymentMethodId: event.target.value ? Number(event.target.value) : null,
              })
            }
            aria-label="Pagamento"
          >
            <option value="">Todos os pagamentos</option>
            {meta?.paymentMethods.map((payment) => (
              <option key={payment.id} value={payment.id}>
                {payment.name}
              </option>
            ))}
          </select>

          <select
            className="select w-auto min-w-[145px]"
            value={kind}
            onChange={(event) =>
              updateParams({ kind: event.target.value === 'all' ? null : event.target.value })
            }
            aria-label="Tipo"
          >
            {KIND_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>

          {hasActiveFilters && (
            <Button variant="ghost" size="sm" onClick={clearFilters}>
              <RotateCcw className="h-3.5 w-3.5" />
              Limpar
            </Button>
          )}
        </div>
      </div>

      <div className="card mt-4 overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-ink-200 px-4 py-3 dark:border-ink-800">
          <div>
            <h2 className="text-sm font-semibold text-ink-900 dark:text-white">
              {month ? `${MONTHS_LONG[month - 1]} de ${year}` : `Ano de ${year}`}
            </h2>
            <p className="text-[11px] text-ink-400">
              {result ? `${result.total} lançamento(s)` : 'Carregando...'}
              {kind !== 'all' ? ` · ${KIND_OPTIONS.find((item) => item.value === kind)?.label}` : ''}
            </p>
          </div>
          <div className="flex items-center gap-2 text-[11px] text-ink-400">
            {fetching && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {search && <span>Busca: “{search}”</span>}
          </div>
        </div>

        {selectedCount > 0 && (
          <div className="flex flex-wrap items-center gap-2.5 border-b border-blue-200 bg-blue-50/80 px-4 py-2.5 dark:border-blue-900/50 dark:bg-blue-950/30">
            <div className="mr-1 flex items-center gap-2 text-[12px]">
              <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-blue-600 px-1 text-[10px] font-semibold text-white">
                {selectedCount}
              </span>
              <span className="font-medium text-blue-900 dark:text-blue-200">
                selecionado(s)
              </span>
              {selectedOutsidePage > 0 && (
                <span className="text-blue-700/80 dark:text-blue-300/80">
                  · {selectedOutsidePage} fora desta página
                </span>
              )}
            </div>

            <select
              className="select h-8 w-auto min-w-[168px] border-blue-200 bg-white text-[12px] dark:border-blue-900"
              value=""
              onChange={(event) => {
                const targetId = Number(event.target.value);
                if (targetId) setBulkConfirm({ type: 'category', targetId });
              }}
              aria-label="Alterar categoria dos selecionados"
            >
              <option value="">Alterar categoria...</option>
              {meta?.categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>

            <select
              className="select h-8 w-auto min-w-[180px] border-blue-200 bg-white text-[12px] dark:border-blue-900"
              value=""
              onChange={(event) => {
                const targetId = Number(event.target.value);
                if (targetId) setBulkConfirm({ type: 'payment', targetId });
              }}
              aria-label="Alterar pagamento dos selecionados"
            >
              <option value="">Alterar pagamento...</option>
              {meta?.paymentMethods.map((payment) => (
                <option key={payment.id} value={payment.id}>
                  {payment.name}
                </option>
              ))}
            </select>

            <Button
              variant="danger-soft"
              size="sm"
              onClick={() => setBulkConfirm({ type: 'delete' })}
            >
              <Trash2 className="h-3.5 w-3.5" />
              Excluir
            </Button>

            <button
              type="button"
              onClick={clear}
              className="ml-auto text-[12px] font-medium text-blue-700 underline-offset-2 hover:underline dark:text-blue-300"
            >
              Limpar seleção
            </button>
          </div>
        )}

        {listError && (
          <div className="flex flex-wrap items-center gap-2 border-b border-rose-200 bg-rose-50 px-4 py-2.5 text-[12px] text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/30 dark:text-rose-300">
            <AlertTriangle className="h-4 w-4" />
            {listError}
            <Button size="sm" variant="ghost" onClick={reload} className="ml-auto">
              Tentar novamente
            </Button>
          </div>
        )}

        <div className="table-shell max-h-[calc(100vh-24rem)] min-h-[300px]">
          <table className="w-full min-w-[1120px] border-collapse">
            <thead className="sticky top-0 z-10">
              <tr>
                <th className="th w-10 pr-1">
                  <input
                    ref={headerCheckbox}
                    type="checkbox"
                    checked={allPageSelected}
                    onChange={togglePage}
                    className="h-4 w-4 cursor-pointer rounded border-ink-300 accent-blue-600"
                    aria-label="Selecionar lançamentos desta página"
                  />
                </th>
                <SortHeader
                  label="Data Compra"
                  field="purchaseDate"
                  current={sortBy}
                  dir={sortDir}
                  onClick={handleSort}
                />
                <SortHeader
                  label="Vencimento"
                  field="dueDate"
                  current={sortBy}
                  dir={sortDir}
                  onClick={handleSort}
                />
                <SortHeader
                  label="Compra"
                  field="description"
                  current={sortBy}
                  dir={sortDir}
                  onClick={handleSort}
                />
                <SortHeader
                  label="Valor"
                  field="amount"
                  current={sortBy}
                  dir={sortDir}
                  onClick={handleSort}
                  align="right"
                />
                <SortHeader
                  label="Pagamento"
                  field="paymentMethodName"
                  current={sortBy}
                  dir={sortDir}
                  onClick={handleSort}
                />
                <th className="th">Parcelas</th>
                <SortHeader
                  label="Categorias"
                  field="categoryName"
                  current={sortBy}
                  dir={sortDir}
                  onClick={handleSort}
                />
                <th className="th">Transf</th>
                <th className="th w-[110px] text-right">Ações</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr>
                  <td colSpan={10} className="px-4 py-16 text-center">
                    <div className="inline-flex items-center gap-2 text-[13px] text-ink-400">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Carregando lançamentos...
                    </div>
                  </td>
                </tr>
              )}

              {!loading &&
                rows.map((transaction) => {
                  const isEditing = editing?.id === transaction.id;
                  const selected = selectedIds.has(transaction.id);
                  return (
                    <tr
                      key={transaction.id}
                      className={`group transition ${
                        selected
                          ? 'bg-blue-50/60 dark:bg-blue-950/20'
                          : 'hover:bg-ink-50/70 dark:hover:bg-ink-800/30'
                      }`}
                    >
                      <td className="td pr-1">
                        <input
                          type="checkbox"
                          checked={selected}
                          onChange={() => toggleRow(transaction)}
                          className="h-4 w-4 cursor-pointer rounded border-ink-300 accent-blue-600"
                          aria-label={`Selecionar ${transaction.description}`}
                        />
                      </td>

                      {isEditing && editing ? (
                        <>
                          <td className="td">
                            <input
                              type="date"
                              className="input h-8 w-[126px] px-2 text-[12px]"
                              value={editing.draft.purchaseDate}
                              onChange={(event) => updateDraft('purchaseDate', event.target.value)}
                            />
                          </td>
                          <td className="td">
                            <input
                              type="date"
                              className="input h-8 w-[126px] px-2 text-[12px]"
                              value={editing.draft.dueDate}
                              onChange={(event) => updateDraft('dueDate', event.target.value)}
                            />
                          </td>
                          <td className="td">
                            <input
                              className="input h-8 min-w-[190px] px-2 text-[12px]"
                              value={editing.draft.description}
                              onChange={(event) => updateDraft('description', event.target.value)}
                            />
                          </td>
                          <td className="td text-right">
                            <input
                              className="input num h-8 w-[116px] px-2 text-right text-[12px]"
                              value={editing.draft.amount}
                              onChange={(event) => updateDraft('amount', event.target.value)}
                              aria-label="Valor"
                            />
                          </td>
                          <td className="td">
                            <select
                              className="select h-8 min-w-[128px] px-2 text-[12px]"
                              value={editing.draft.paymentMethodId}
                              onChange={(event) =>
                                updateDraft('paymentMethodId', Number(event.target.value))
                              }
                            >
                              {meta?.paymentMethods.map((payment) => (
                                <option key={payment.id} value={payment.id}>
                                  {payment.name}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td className="td">
                            <div className="flex items-center gap-1">
                              <input
                                className="input num h-8 w-12 px-1.5 text-center text-[12px]"
                                inputMode="numeric"
                                value={editing.draft.installmentNumber}
                                onChange={(event) =>
                                  updateDraft('installmentNumber', event.target.value)
                                }
                                aria-label="Parcela"
                              />
                              <span className="text-ink-400">/</span>
                              <input
                                className="input num h-8 w-12 px-1.5 text-center text-[12px]"
                                inputMode="numeric"
                                value={editing.draft.installmentTotal}
                                onChange={(event) =>
                                  updateDraft('installmentTotal', event.target.value)
                                }
                                aria-label="Total de parcelas"
                              />
                            </div>
                          </td>
                          <td className="td">
                            <select
                              className="select h-8 min-w-[130px] px-2 text-[12px]"
                              value={editing.draft.categoryId}
                              onChange={(event) =>
                                updateDraft('categoryId', Number(event.target.value))
                              }
                            >
                              {meta?.categories.map((category) => (
                                <option key={category.id} value={category.id}>
                                  {category.name}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td className="td">
                            <input
                              className="input h-8 w-[110px] px-2 text-[12px]"
                              value={editing.draft.transfer}
                              onChange={(event) => updateDraft('transfer', event.target.value)}
                              placeholder="—"
                            />
                          </td>
                          <td className="td">
                            <div className="flex justify-end gap-0.5">
                              <button
                                type="button"
                                className="icon-btn text-emerald-600 hover:bg-emerald-50 hover:text-emerald-700 dark:hover:bg-emerald-950/40"
                                onClick={saveEdit}
                                disabled={savingEdit}
                                aria-label="Salvar alterações"
                              >
                                {savingEdit ? (
                                  <Loader2 className="h-4 w-4 animate-spin" />
                                ) : (
                                  <Check className="h-4 w-4" />
                                )}
                              </button>
                              <button
                                type="button"
                                className="icon-btn"
                                onClick={() => setEditing(null)}
                                disabled={savingEdit}
                                aria-label="Cancelar edição"
                              >
                                <X className="h-4 w-4" />
                              </button>
                            </div>
                          </td>
                        </>
                      ) : (
                        <>
                          <td className="td whitespace-nowrap text-ink-500 dark:text-ink-400">
                            {formatDateBR(transaction.purchaseDate)}
                          </td>
                          <td className="td whitespace-nowrap">
                            {formatDateBR(transaction.dueDate)}
                          </td>
                          <td className="td">
                            <div className="max-w-[340px]">
                              <p className="truncate font-medium text-ink-800 dark:text-ink-100">
                                {transaction.description}
                              </p>
                              <p className="text-[11px] text-ink-400">
                                {transaction.importBatchId
                                  ? `Importação #${transaction.importBatchId}`
                                  : 'Cadastro manual'}
                              </p>
                            </div>
                          </td>
                          <td
                            className={`td num whitespace-nowrap text-right font-medium ${
                              transaction.amountCents < 0
                                ? 'text-rose-600 dark:text-rose-400'
                                : transaction.amountCents > 0
                                  ? 'text-emerald-600 dark:text-emerald-400'
                                  : 'text-ink-500'
                            }`}
                          >
                            {formatBRL(transaction.amountCents)}
                          </td>
                          <td className="td">
                            <span className="inline-flex items-center gap-1.5 text-ink-600 dark:text-ink-300">
                              <CreditCard className="h-3.5 w-3.5 text-ink-400" />
                              <span className="max-w-[150px] truncate">
                                {transaction.paymentMethodName}
                              </span>
                            </span>
                          </td>
                          <td className="td num whitespace-nowrap text-ink-500 dark:text-ink-400">
                            {formatInstallments(
                              transaction.installmentNumber,
                              transaction.installmentTotal,
                            )}
                          </td>
                          <td className="td">
                            <span className="inline-flex max-w-[170px] items-center gap-1.5">
                              <span
                                className="h-1.5 w-1.5 shrink-0 rounded-full"
                                style={{
                                  backgroundColor: categoryColorHex(
                                    transaction.categoryId,
                                    categoryColorMap.get(transaction.categoryId),
                                  ),
                                }}
                              />
                              <span className="truncate text-ink-600 dark:text-ink-300">
                                {transaction.categoryName}
                              </span>
                            </span>
                          </td>
                          <td className="td">
                            {transaction.transferStatus === 'confirmed' && transaction.transferLink ? (
                              <button
                                type="button"
                                onClick={() => setTransferTarget(transaction)}
                                title={`${transaction.transferLink.sourceAccount} → ${transaction.transferLink.destinationAccount}`}
                                className="badge bg-violet-50 text-violet-700 transition hover:bg-violet-100 dark:bg-violet-950/40 dark:text-violet-300 dark:hover:bg-violet-950/70"
                              >
                                <Link2 className="mr-1 h-3 w-3" />
                                {transaction.transferLink.direction === 'out' ? 'Enviada' : 'Recebida'}
                              </button>
                            ) : transaction.transferStatus === 'unconfirmed' ? (
                              <button
                                type="button"
                                onClick={() => setTransferTarget(transaction)}
                                title="Marcada na importação, sem par confirmado. Clique para revisar."
                                className="badge bg-amber-50 text-amber-700 transition hover:bg-amber-100 dark:bg-amber-950/40 dark:text-amber-300 dark:hover:bg-amber-950/70"
                              >
                                Transferência?
                              </button>
                            ) : (
                              <button
                                type="button"
                                onClick={() => setTransferTarget(transaction)}
                                title="Vincular a uma transferência entre contas"
                                className="text-ink-300 transition hover:text-violet-500 dark:text-ink-600 dark:hover:text-violet-400"
                                aria-label="Vincular transferência"
                              >
                                <ArrowRightLeft className="h-3.5 w-3.5" />
                              </button>
                            )}
                          </td>
                          <td className="td">
                            <div className="flex justify-end gap-0.5 opacity-60 transition group-hover:opacity-100">
                              <button
                                type="button"
                                className="icon-btn"
                                onClick={() => setTransferTarget(transaction)}
                                aria-label={`Transferência de ${transaction.description}`}
                                title="Transferência"
                              >
                                <ArrowRightLeft className="h-3.5 w-3.5" />
                              </button>
                              <button
                                type="button"
                                className="icon-btn"
                                onClick={() => startEdit(transaction)}
                                aria-label={`Editar ${transaction.description}`}
                                title="Editar"
                              >
                                <Pencil className="h-3.5 w-3.5" />
                              </button>
                              <button
                                type="button"
                                className="icon-btn hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-950/40"
                                onClick={() => setDeleteTarget(transaction)}
                                aria-label={`Excluir ${transaction.description}`}
                                title="Excluir"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          </td>
                        </>
                      )}
                    </tr>
                  );
                })}

              {!loading && rows.length === 0 && !listError && (
                <tr>
                  <td colSpan={10}>
                    <EmptyState
                      icon={ReceiptText}
                      title="Nenhum lançamento encontrado"
                      description={
                        hasActiveFilters
                          ? 'Não há lançamentos para os filtros atuais. Ajuste os filtros ou importe uma planilha.'
                          : 'Cadastre um lançamento manualmente ou importe sua planilha financeira.'
                      }
                      action={
                        <div className="flex flex-wrap justify-center gap-2">
                          {hasActiveFilters && (
                            <Button variant="secondary" onClick={clearFilters}>
                              <RotateCcw className="h-3.5 w-3.5" />
                              Limpar filtros
                            </Button>
                          )}
                          <Button variant="primary" onClick={() => setAddOpen(true)}>
                            <Plus className="h-4 w-4" />
                            Novo lançamento
                          </Button>
                          <Button
                            variant="secondary"
                            onClick={() => navigate('/importacoes')}
                          >
                            <FileUp className="h-3.5 w-3.5" />
                            Importar
                          </Button>
                        </div>
                      }
                    />
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-ink-200 px-4 py-3 dark:border-ink-800">
          <p className="text-[11px] text-ink-400">
            {result && result.total > 0
              ? `Mostrando ${(result.page - 1) * result.pageSize + 1}–${Math.min(
                  result.page * result.pageSize,
                  result.total,
                )} de ${result.total}`
              : 'Nenhum resultado'}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1.5 text-[11px] text-ink-400">
              Por página
              <select
                className="select h-8 w-[72px] px-2 text-[12px]"
                value={pageSize}
                onChange={(event) =>
                  updateParams({ pageSize: Number(event.target.value), page: null })
                }
              >
                {[10, 25, 50, 100].map((size) => (
                  <option key={size} value={size}>
                    {size}
                  </option>
                ))}
              </select>
            </label>
            <Button
              size="sm"
              variant="secondary"
              disabled={page <= 1 || fetching}
              onClick={() => updateParams({ page: page - 1 }, { keepPage: true })}
            >
              Anterior
            </Button>
            <span className="text-[11px] text-ink-500 dark:text-ink-400">
              {result?.page ?? page} / {result?.totalPages ?? 1}
            </span>
            <Button
              size="sm"
              variant="secondary"
              disabled={page >= (result?.totalPages ?? 1) || fetching}
              onClick={() => updateParams({ page: page + 1 }, { keepPage: true })}
            >
              Próxima
            </Button>
          </div>
        </div>
      </div>

      {addOpen && (
        <AddTransactionModal
          categories={meta?.categories ?? []}
          payments={meta?.paymentMethods ?? []}
          onClose={() => setAddOpen(false)}
          onSaved={handleCreated}
        />
      )}

      {deleteTarget && (
        <Modal
          title="Excluir lançamento"
          size="sm"
          onClose={() => setDeleteTarget(null)}
          footer={
            <>
              <Button onClick={() => setDeleteTarget(null)} disabled={savingRowId !== null}>
                Cancelar
              </Button>
              <Button
                variant="danger"
                onClick={confirmDelete}
                loading={savingRowId === deleteTarget.id}
              >
                Excluir
              </Button>
            </>
          }
        >
          <p className="text-[13px] leading-relaxed text-ink-600 dark:text-ink-300">
            Tem certeza de que deseja excluir{' '}
            <strong className="text-ink-900 dark:text-white">{deleteTarget.description}</strong> (
            {formatBRL(deleteTarget.amountCents)})? Esta ação não pode ser desfeita.
          </p>
          {deleteTarget.transferStatus === 'confirmed' && (
            <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
              Este lançamento faz parte de uma transferência confirmada. Desvincule a transferência
              antes de excluí-lo.
            </p>
          )}
        </Modal>
      )}

      {transferTarget && (
        <TransferModal
          transaction={transferTarget}
          onClose={() => setTransferTarget(null)}
          onChanged={() => {
            reload();
            void refreshMeta();
          }}
        />
      )}

      {bulkConfirm && (
        <Modal
          title={
            bulkConfirm.type === 'delete'
              ? 'Excluir lançamentos selecionados'
              : bulkConfirm.type === 'category'
                ? 'Alterar categoria'
                : 'Alterar pagamento'
          }
          size="sm"
          onClose={() => setBulkConfirm(null)}
          footer={
            <>
              <Button
                onClick={() => setBulkConfirm(null)}
                disabled={bulkBusy}
              >
                Cancelar
              </Button>
              <Button
                variant={bulkConfirm.type === 'delete' ? 'danger' : 'primary'}
                onClick={executeBulk}
                loading={bulkBusy}
              >
                {bulkConfirm.type === 'delete' ? 'Excluir selecionados' : 'Confirmar alteração'}
              </Button>
            </>
          }
        >
          <div className="space-y-3 text-[13px] leading-relaxed text-ink-600 dark:text-ink-300">
            {bulkConfirm.type === 'delete' ? (
              <p>
                Excluir <strong className="text-ink-900 dark:text-white">{selectedCount}</strong>{' '}
                lançamento(s)? Esta ação não pode ser desfeita.
              </p>
            ) : (
              <p>
                Aplicar{' '}
                <strong className="text-ink-900 dark:text-white">{bulkLookupName}</strong> a{' '}
                <strong className="text-ink-900 dark:text-white">{selectedCount}</strong>{' '}
                lançamento(s)?
              </p>
            )}
            {selectedOutsidePage > 0 && (
              <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
                A seleção inclui {selectedOutsidePage} lançamento(s) que não estão na página
                atual. Todos os {selectedCount} selecionados serão afetados.
              </p>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}
