import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
} from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Ban,
  Bookmark,
  Check,
  CheckCircle2,
  ChevronDown,
  Copy,
  Database,
  FileSpreadsheet,
  FileUp,
  Info,
  Link2,
  ListChecks,
  Loader2,
  Pencil,
  RefreshCw,
  RotateCcw,
  Trash2,
  Undo2,
  UploadCloud,
  Wand2,
} from 'lucide-react';
import { Button } from '../components/ui/Button';
import { Field } from '../components/ui/Field';
import { Modal } from '../components/ui/Modal';
import { PageHeader } from '../components/ui/Page';
import { useMeta } from '../context/MetaContext';
import { useToast } from '../context/ToastContext';
import { api, errorMessage } from '../lib/api';
import {
  buildCategoryDecisions,
  buildImportIdentity,
  canAutoAcceptSuggestion,
  isMappingIdentityCompatible,
  isReviewableCategoryGroup,
  previewIdentityKey,
  resolveIncludedDuplicateRows,
} from '../lib/import-decisions';
import {
  formatBRL,
  formatDateBR,
  formatDateTimeBR,
  formatFileSize,
  formatInstallments,
  isoToParts,
} from '../lib/format';
import type {
  CategoryDecisionsPayload,
  CategorySuggestionGroup,
  ColumnMapping,
  DuplicateCounterpart,
  DuplicateInfo,
  ImportField,
  ImportMappingTemplate,
  ImportOverrides,
  ImportPreview,
  ImportSummary,
  InstallmentRecoveryProposal,
  PreviewRow,
  RowSuggestion,
  TransferCandidate,
  TransferDecision,
  TransferParty,
} from '../lib/types';

const FIELD_CONFIG: {
  field: ImportField;
  label: string;
  required: boolean;
}[] = [
  { field: 'purchaseDate', label: 'Data Compra', required: false },
  { field: 'dueDate', label: 'Vencimento', required: false },
  { field: 'description', label: 'Compra', required: true },
  { field: 'amount', label: 'Valor', required: true },
  { field: 'paymentMethod', label: 'Pagamento', required: false },
  { field: 'installments', label: 'Parcelas', required: false },
  { field: 'category', label: 'Categorias', required: false },
  { field: 'transfer', label: 'Transf', required: false },
];

const MAX_FILE_SIZE = 25 * 1024 * 1024;

type FilterTab = 'all' | 'valid' | 'duplicates' | 'errors' | 'transfers';

function rowStatus(
  row: PreviewRow,
  rejected: Set<number>,
): { label: string; className: string; icon: typeof CheckCircle2 } {
  if (row.errors.length > 0) {
    return {
      label: 'Erro',
      className: 'bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300',
      icon: AlertTriangle,
    };
  }
  if (row.duplicate) {
    const ignored = rejected.has(row.rowNumber);
    return {
      label: `${row.duplicate.kind === 'exact' ? 'Duplicada exata' : 'Duplicada provável'}${
        ignored ? ' · ignorada' : ''
      }`,
      className:
        row.duplicate.kind === 'exact'
          ? 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300'
          : 'bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300',
      icon: Copy,
    };
  }
  if (rejected.has(row.rowNumber)) {
    return {
      label: 'Ignorada',
      className: 'bg-ink-100 text-ink-500 dark:bg-ink-800 dark:text-ink-400',
      icon: Ban,
    };
  }
  return {
    label: 'Válida',
    className: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300',
    icon: CheckCircle2,
  };
}

const DECISION_OPTIONS: { value: TransferDecision; label: string; active: string }[] = [
  {
    value: 'confirm',
    label: 'Confirmar',
    active: 'bg-emerald-600 text-white border-emerald-600 hover:bg-emerald-600',
  },
  {
    value: 'reject',
    label: 'Rejeitar',
    active: 'bg-rose-600 text-white border-rose-600 hover:bg-rose-600',
  },
  {
    value: 'pending',
    label: 'Pendente',
    active: 'bg-ink-600 text-white border-ink-600 hover:bg-ink-600',
  },
];

function defaultDecisions(candidates: TransferCandidate[]): Record<string, TransferDecision> {
  const decisions: Record<string, TransferDecision> = {};
  for (const candidate of candidates) {
    if (candidate.confidence === 'high' && !candidate.ambiguous) {
      decisions[candidate.key] = 'confirm';
    }
  }
  return decisions;
}

function partiesConflict(left: TransferCandidate, right: TransferCandidate): boolean {
  const leftKeys = [left.outgoing.key, left.incoming.key];
  const rightKeys = [right.outgoing.key, right.incoming.key];
  return leftKeys.some((key) => rightKeys.includes(key));
}

function PartyMini({ party, tone }: { party: TransferParty; tone: 'out' | 'in' }) {
  const outgoing = tone === 'out';
  return (
    <div
      className={`rounded-lg border px-3 py-2 ${
        outgoing
          ? 'border-rose-200 bg-rose-50/60 dark:border-rose-900/50 dark:bg-rose-950/20'
          : 'border-emerald-200 bg-emerald-50/60 dark:border-emerald-900/50 dark:bg-emerald-950/20'
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <span
          className={`text-[10px] font-semibold uppercase tracking-wider ${
            outgoing ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-600 dark:text-emerald-400'
          }`}
        >
          {outgoing ? 'Saída' : 'Entrada'}
        </span>
        <span className="num text-[12px] font-semibold text-ink-800 dark:text-ink-100">
          {formatBRL(party.amountCents)}
        </span>
      </div>
      <p className="mt-0.5 truncate text-[12px] font-medium text-ink-700 dark:text-ink-200">
        {party.description}
      </p>
      <p className="mt-0.5 truncate text-[10px] text-ink-500 dark:text-ink-400">
        {formatDateBR(party.dueDate)} · {party.paymentMethod} ·{' '}
        {party.source === 'database' ? `Lançamento #${party.transactionId}` : `Linha ${party.rowNumber}`}
      </p>
    </div>
  );
}

function TransferCandidateRow({
  candidate,
  decision,
  onDecision,
}: {
  candidate: TransferCandidate;
  decision: TransferDecision;
  onDecision: (decision: TransferDecision) => void;
}) {
  return (
    <div className="rounded-xl border border-ink-200 p-3 dark:border-ink-800">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <span
            className={`badge ${
              candidate.confidence === 'high'
                ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
                : 'bg-ink-100 text-ink-600 dark:bg-ink-800 dark:text-ink-300'
            }`}
          >
            {candidate.confidence === 'high' ? 'Alta confiança' : 'Possível transferência'}
          </span>
          {candidate.ambiguous && (
            <span className="badge bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
              Ambíguo
            </span>
          )}
        </div>
        <span className="text-[11px] text-ink-400">
          {candidate.dayDistance === 0
            ? 'Mesma data'
            : `${candidate.dayDistance} dia(s) de diferença`}
        </span>
      </div>

      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <PartyMini party={candidate.outgoing} tone="out" />
        <PartyMini party={candidate.incoming} tone="in" />
      </div>

      <ul className="mt-2 space-y-0.5">
        {candidate.reasons.map((reason) => (
          <li key={reason} className="text-[11px] text-ink-500 dark:text-ink-400">
            • {reason}
          </li>
        ))}
      </ul>

      <div className="mt-2.5 flex flex-wrap items-center justify-end gap-1.5">
        {DECISION_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => onDecision(option.value)}
            className={`rounded-md border px-2.5 py-1 text-[11px] font-medium transition ${
              decision === option.value
                ? option.active
                : 'border-ink-200 text-ink-500 hover:bg-ink-50 dark:border-ink-700 dark:text-ink-400 dark:hover:bg-ink-800/50'
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function CorrectionModal({
  row,
  initial,
  onClose,
  onSave,
  onReject,
}: {
  row: PreviewRow;
  initial: Record<ImportField, string>;
  onClose: () => void;
  onSave: (values: Record<ImportField, string>) => void;
  onReject: () => void;
}) {
  const [values, setValues] = useState<Record<ImportField, string>>(initial);

  const update = (field: ImportField, value: string) => {
    setValues((current) => ({ ...current, [field]: value }));
  };

  return (
    <Modal
      title={`Corrigir linha ${row.rowNumber}`}
      description="A correção será aplicada somente a esta linha e a prévia será recalculada."
      size="lg"
      onClose={onClose}
      footer={
        <>
          <Button variant="danger-soft" onClick={onReject}>
            <Ban className="h-3.5 w-3.5" />
            Ignorar linha
          </Button>
          <div className="flex-1" />
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" onClick={() => onSave(values)}>
            Aplicar correção
          </Button>
        </>
      }
    >
      {row.errors.length > 0 && (
        <div className="mb-4 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/30 dark:text-rose-300">
          <p className="mb-1 font-medium">Erros encontrados:</p>
          <ul className="list-inside list-disc space-y-0.5">
            {row.errors.map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        {FIELD_CONFIG.map((config) => (
          <Field
            key={config.field}
            label={config.label}
            required={config.required}
            className={config.field === 'description' ? 'sm:col-span-2' : ''}
            hint={
              config.field === 'amount'
                ? 'Aceita -R$ 500,00, R$ 1.250,50 e -R$ 500.00'
                : config.field === 'installments'
                  ? 'Ex.: 1/12 ou 12x'
                  : config.field === 'purchaseDate'
                    ? 'DD/MM/AAAA'
                    : config.field === 'dueDate'
                      ? 'Opcional: calculado pela data de compra e parcela'
                      : undefined
            }
          >
            <input
              className="input"
              value={values[config.field] ?? ''}
              onChange={(event) => update(config.field, event.target.value)}
            />
          </Field>
        ))}
      </div>
    </Modal>
  );
}

function TabButton({
  active,
  label,
  count,
  tone,
  onClick,
}: {
  active: boolean;
  label: string;
  count: number;
  tone: 'ink' | 'emerald' | 'amber' | 'rose' | 'violet';
  onClick: () => void;
}) {
  const toneClasses = {
    ink: 'bg-ink-100 text-ink-600 dark:bg-ink-800 dark:text-ink-300',
    emerald: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300',
    amber: 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300',
    rose: 'bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300',
    violet: 'bg-violet-50 text-violet-700 dark:bg-violet-950/40 dark:text-violet-300',
  }[tone];

  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] font-medium transition ${
        active
          ? 'bg-white text-ink-900 shadow-sm dark:bg-ink-800 dark:text-white'
          : 'text-ink-500 hover:text-ink-800 dark:text-ink-400 dark:hover:text-white'
      }`}
    >
      {label}
      <span className={`rounded-full px-1.5 py-0.5 text-[10px] ${toneClasses}`}>{count}</span>
    </button>
  );
}

function fieldInitialValue(row: PreviewRow, field: ImportField): string {
  if (field === 'installments') {
    if (row.values.installmentNumber !== null || row.values.installmentTotal !== null) {
      return formatInstallments(row.values.installmentNumber, row.values.installmentTotal);
    }
    return row.raw.installments ?? '';
  }
  if (field === 'description') return row.values.description || row.raw.description || '';
  if (field === 'paymentMethod') return row.values.paymentMethod || row.raw.paymentMethod || '';
  if (field === 'category') return row.values.category || row.raw.category || '';
  return row.raw[field] ?? '';
}

function sameText(left: unknown, right: unknown): boolean {
  return String(left ?? '').trim() === String(right ?? '').trim();
}

type DuplicateFieldKey =
  | 'description'
  | 'dates'
  | 'amount'
  | 'payment'
  | 'category'
  | 'installments';

const DUPLICATE_FIELDS: { key: DuplicateFieldKey; label: string }[] = [
  { key: 'description', label: 'Descrição' },
  { key: 'dates', label: 'Datas' },
  { key: 'amount', label: 'Valor' },
  { key: 'payment', label: 'Pagamento' },
  { key: 'category', label: 'Categoria' },
  { key: 'installments', label: 'Parcelas' },
];

interface DuplicateGroup {
  key: string;
  kind: 'exact' | 'probable' | 'mixed';
  rows: PreviewRow[];
  existing: DuplicateCounterpart | null;
  reasons: string[];
}

type DuplicateColumn =
  | { id: string; source: 'file'; row: PreviewRow }
  | { id: string; source: 'database'; counterpart: DuplicateCounterpart };

function duplicateGroupSignature(rows: PreviewRow[]): string {
  const signatures: string[] = [];
  for (const row of rows) {
    const duplicate = row.duplicate;
    if (!duplicate) continue;
    signatures.push(
      [
        row.rowNumber,
        duplicate.kind,
        duplicate.source,
        duplicate.groupKey,
        duplicate.counterpartRowNumber ?? '',
        duplicate.counterpartTransactionId ?? '',
      ].join(':'),
    );
  }
  return signatures.sort().join('|');
}

function fileDuplicateField(row: PreviewRow, field: DuplicateFieldKey): string {
  switch (field) {
    case 'description':
      return row.values.description || row.raw.description || '—';
    case 'dates': {
      const purchaseDate = row.values.purchaseDate
        ? formatDateBR(row.values.purchaseDate)
        : row.raw.purchaseDate || '—';
      const dueDate = row.values.dueDate
        ? formatDateBR(row.values.dueDate)
        : row.raw.dueDate || '—';
      return `${purchaseDate} · ${dueDate}`;
    }
    case 'amount':
      return row.values.amountCents !== null
        ? formatBRL(row.values.amountCents)
        : row.raw.amount || '—';
    case 'payment':
      return row.values.paymentMethod || row.raw.paymentMethod || '—';
    case 'category':
      return row.values.category || row.raw.category || '—';
    case 'installments':
      if (row.values.installmentNumber !== null || row.values.installmentTotal !== null) {
        return formatInstallments(
          row.values.installmentNumber,
          row.values.installmentTotal,
        );
      }
      return row.raw.installments || '—';
  }
}

function databaseDuplicateField(
  counterpart: DuplicateCounterpart,
  field: DuplicateFieldKey,
): string {
  switch (field) {
    case 'description':
      return counterpart.description || '—';
    case 'dates':
      return `${formatDateBR(counterpart.purchaseDate)} · ${formatDateBR(counterpart.dueDate)}`;
    case 'amount':
      return formatBRL(counterpart.amountCents);
    case 'payment':
      return counterpart.paymentMethod || '—';
    case 'category':
      return counterpart.category || '—';
    case 'installments':
      return counterpart.installmentNumber !== null || counterpart.installmentTotal !== null
        ? formatInstallments(counterpart.installmentNumber, counterpart.installmentTotal)
        : '—';
  }
}

function duplicateColumnValue(column: DuplicateColumn, field: DuplicateFieldKey): string {
  return column.source === 'file'
    ? fileDuplicateField(column.row, field)
    : databaseDuplicateField(column.counterpart, field);
}

function decisionSummary(selected: number, ignored: number): string {
  const imported =
    selected === 0
      ? 'Nenhum registro será importado'
      : selected === 1
        ? '1 registro será importado'
        : `${selected} registros serão importados`;
  const skipped =
    ignored === 0
      ? 'nenhum será ignorado'
      : ignored === 1
        ? '1 será ignorado'
        : `${ignored} serão ignorados`;
  return `${imported}; ${skipped}.`;
}

function DuplicateGroupCard({
  group,
  rejected,
  onInclude,
  onExclude,
  onIncludeOnly,
  onIncludeAll,
  onExcludeAll,
  onEdit,
}: {
  group: DuplicateGroup;
  rejected: Set<number>;
  onInclude: (rowNumber: number) => void;
  onExclude: (rowNumber: number) => void;
  onIncludeOnly: (rowNumbers: number[], chosen: number) => void;
  onIncludeAll: (rowNumbers: number[]) => void;
  onExcludeAll: (rowNumbers: number[]) => void;
  onEdit: (row: PreviewRow) => void;
}) {
  const [open, setOpen] = useState(true);
  const columns: DuplicateColumn[] = [
    ...(group.existing
      ? [
          {
            id: `db:${group.existing.transactionId ?? 'existing'}`,
            source: 'database' as const,
            counterpart: group.existing,
          },
        ]
      : []),
    ...group.rows.map((row) => ({
      id: `file:${row.rowNumber}`,
      source: 'file' as const,
      row,
    })),
  ];
  const rowNumbers = group.rows.map((row) => row.rowNumber);
  const selectedRows = group.rows.filter((row) => !rejected.has(row.rowNumber));
  const selectedCount = selectedRows.length;
  const ignoredCount = group.rows.length - selectedCount;
  const allSelected = group.rows.length > 0 && selectedCount === group.rows.length;
  const noneSelected = selectedCount === 0;
  const firstRowNumber = group.rows[0]?.rowNumber;
  const divergences = Object.fromEntries(
    DUPLICATE_FIELDS.map((field) => {
      const values = columns.map((column) => duplicateColumnValue(column, field.key));
      return [field.key, values.some((value) => !sameText(value, values[0]))];
    }),
  ) as Record<DuplicateFieldKey, boolean>;
  const hasDivergence = DUPLICATE_FIELDS.some((field) => divergences[field.key]);
  const kindLabel =
    group.kind === 'exact'
      ? 'Duplicidade exata'
      : group.kind === 'probable'
        ? 'Duplicidade provável'
        : 'Exata e provável';
  const kindClass =
    group.kind === 'exact'
      ? 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300'
      : group.kind === 'probable'
        ? 'bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300'
        : 'bg-violet-50 text-violet-700 dark:bg-violet-950/40 dark:text-violet-300';

  return (
    <section
      aria-label={`Grupo de duplicidade com ${group.rows.length} linha(s) do arquivo${
        group.existing ? ' e 1 registro já cadastrado' : ''
      }`}
      className="overflow-hidden rounded-xl border border-ink-200 dark:border-ink-800"
    >
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-ink-200 bg-ink-50/50 px-3 py-2.5 dark:border-ink-800 dark:bg-ink-950/20">
        <div className="flex min-w-0 items-start gap-2">
          <button
            type="button"
            onClick={() => setOpen((current) => !current)}
            className="icon-btn mt-0.5 h-6 w-6 text-ink-400"
            aria-expanded={open}
            aria-label={open ? 'Recolher grupo de duplicidade' : 'Expandir grupo de duplicidade'}
          >
            <ChevronDown
              className={`h-3.5 w-3.5 transition-transform ${open ? '' : '-rotate-90'}`}
            />
          </button>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className={`badge ${kindClass}`}>{kindLabel}</span>
              <span className="text-[11px] text-ink-500 dark:text-ink-400">
                {group.rows.length === 1
                  ? '1 linha do arquivo'
                  : `${group.rows.length} linhas do arquivo`}
                {group.existing ? ' · 1 já cadastrado' : ''}
              </span>
              {hasDivergence ? (
                <span className="badge bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
                  Campos divergentes
                </span>
              ) : (
                <span className="badge bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
                  Dados equivalentes
                </span>
              )}
            </div>
            <p className="mt-0.5 text-[10px] text-ink-400" title={group.reasons.join(' ')}>
              {group.reasons.join(' · ')}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => firstRowNumber !== undefined && onIncludeOnly(rowNumbers, firstRowNumber)}
            disabled={firstRowNumber === undefined}
            title="Manter a primeira linha do arquivo e ignorar as demais"
          >
            Manter primeiro
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => onIncludeAll(rowNumbers)}
            disabled={allSelected || group.rows.length === 0}
          >
            Importar todos
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onExcludeAll(rowNumbers)}
            disabled={noneSelected || group.rows.length === 0}
          >
            Ignorar todos
          </Button>
        </div>
      </div>

      {open && (
        <div
          className="overflow-x-auto focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/50"
          tabIndex={0}
          role="region"
          aria-label={`Comparação de ${group.rows.length} linha(s) do arquivo${
            group.existing ? ' com registro já cadastrado' : ''
          }`}
        >
          <table
            className="w-full border-collapse"
            style={{ minWidth: `${150 + columns.length * 220}px` }}
          >
            <thead>
              <tr>
                <th
                  scope="col"
                  className="sticky left-0 z-10 w-[150px] border-b border-r border-ink-200 bg-ink-50 px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-ink-400 dark:border-ink-800 dark:bg-ink-900 dark:text-ink-400"
                >
                  Campo
                </th>
                {columns.map((column) => {
                  if (column.source === 'database') {
                    return (
                      <th
                        key={column.id}
                        scope="col"
                        className="min-w-[220px] border-b border-r border-ink-200 bg-emerald-50/40 px-3 py-2 text-left align-top dark:border-ink-800 dark:bg-emerald-950/20"
                      >
                        <div className="flex items-center gap-1.5">
                          <Database className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                          <span className="text-[11px] font-semibold text-ink-800 dark:text-ink-100">
                            Já cadastrado
                          </span>
                        </div>
                        <p
                          className="mt-0.5 text-[10px] text-ink-400"
                          title={
                            column.counterpart.importedAt
                              ? `Importado em ${formatDateTimeBR(column.counterpart.importedAt)}`
                              : undefined
                          }
                        >
                          Origem: banco ·{' '}
                          {column.counterpart.transactionId !== null
                            ? `lançamento #${column.counterpart.transactionId}`
                            : 'registro existente'}
                          {column.counterpart.importBatchId !== null
                            ? ` · lote #${column.counterpart.importBatchId}`
                            : ''}
                        </p>
                        <p className="mt-0.5 text-[10px] text-ink-400">
                          Referência; não será importado.
                        </p>
                      </th>
                    );
                  }

                  const checked = !rejected.has(column.row.rowNumber);
                  return (
                    <th
                      key={column.id}
                      scope="col"
                      className="min-w-[220px] border-b border-r border-ink-200 bg-ink-50/60 px-3 py-2 text-left align-top dark:border-ink-800 dark:bg-ink-900/40"
                    >
                      <label className="flex cursor-pointer items-start gap-2">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(event) =>
                            event.target.checked
                              ? onInclude(column.row.rowNumber)
                              : onExclude(column.row.rowNumber)
                          }
                          className="mt-0.5 h-4 w-4 shrink-0 rounded border-ink-300 accent-blue-600"
                          aria-label={`Importar linha ${column.row.rowNumber}`}
                        />
                        <span className="min-w-0">
                          <span className="block text-[11px] font-semibold text-ink-800 dark:text-ink-100">
                            Linha {column.row.rowNumber}
                          </span>
                          <span className="block text-[10px] text-ink-400">Origem: arquivo</span>
                        </span>
                      </label>
                      <span
                        className={`badge mt-1 ${
                          checked
                            ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
                            : 'bg-ink-100 text-ink-500 dark:bg-ink-800 dark:text-ink-400'
                        }`}
                      >
                        {checked ? 'Importar' : 'Ignorar'}
                      </span>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {DUPLICATE_FIELDS.map((field) => {
                const divergent = divergences[field.key];
                return (
                  <tr key={field.key}>
                    <th
                      scope="row"
                      className="sticky left-0 z-10 border-b border-r border-ink-200 bg-white px-3 py-1.5 text-left text-[10px] font-medium uppercase tracking-wider text-ink-400 dark:border-ink-800 dark:bg-ink-900"
                    >
                      {field.label}
                    </th>
                    {columns.map((column) => (
                      <td
                        key={column.id}
                        className={`border-b border-r border-ink-200 px-3 py-1.5 text-[11px] dark:border-ink-800 ${
                          divergent
                            ? 'bg-amber-50/80 font-medium text-amber-900 dark:bg-amber-950/30 dark:text-amber-100'
                            : column.source === 'database'
                              ? 'bg-emerald-50/20 text-ink-500 dark:bg-emerald-950/10 dark:text-ink-400'
                              : 'text-ink-600 dark:text-ink-300'
                        }`}
                      >
                        {duplicateColumnValue(column, field.key)}
                      </td>
                    ))}
                  </tr>
                );
              })}
              <tr>
                <th
                  scope="row"
                  className="sticky left-0 z-10 border-r border-ink-200 bg-white px-3 py-2 text-left text-[10px] font-medium uppercase tracking-wider text-ink-400 dark:border-ink-800 dark:bg-ink-900"
                >
                  Ações
                </th>
                {columns.map((column) => (
                  <td
                    key={column.id}
                    className={`border-r border-ink-200 px-3 py-2 dark:border-ink-800 ${
                      column.source === 'database'
                        ? 'bg-emerald-50/20 dark:bg-emerald-950/10'
                        : ''
                    }`}
                  >
                    {column.source === 'file' ? (
                      <Button size="sm" variant="ghost" onClick={() => onEdit(column.row)}>
                        <Pencil className="h-3 w-3" />
                        Editar registro
                      </Button>
                    ) : (
                      <span className="text-[10px] text-ink-400">Somente referência</span>
                    )}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-ink-200 px-3 py-2 dark:border-ink-800">
        <p
          className={`text-[11px] font-medium ${
            selectedCount > 0
              ? 'text-emerald-700 dark:text-emerald-300'
              : 'text-amber-700 dark:text-amber-300'
          }`}
          aria-live="polite"
        >
          {decisionSummary(selectedCount, ignoredCount)}
        </p>
        <p className="text-[10px] text-ink-400">
          {group.existing
            ? 'O registro já cadastrado permanece e não é importado novamente.'
            : 'A seleção vale apenas para este grupo.'}
        </p>
      </div>
    </section>
  );
}

function ErrorRowCard({
  row,
  draft,
  valueFor,
  rejected,
  onDraftChange,
  onApply,
  onSuggestion,
  onCorrection,
  onToggleRejected,
}: {
  row: PreviewRow;
  draft: Partial<Record<ImportField, string>>;
  valueFor: (field: ImportField) => string;
  rejected: boolean;
  onDraftChange: (field: ImportField, value: string) => void;
  onApply: () => void;
  onSuggestion: (suggestion: RowSuggestion) => void;
  onCorrection: () => void;
  onToggleRejected: () => void;
}) {
  const fields = [...new Set(row.issues.map((issue) => issue.field))];
  const hasDraft = Object.keys(draft).length > 0;

  return (
    <div
      className={`rounded-xl border p-3 ${
        rejected
          ? 'border-ink-200 bg-ink-50/40 opacity-80 dark:border-ink-800 dark:bg-ink-900/40'
          : 'border-rose-200 bg-rose-50/20 dark:border-rose-900/50 dark:bg-rose-950/10'
      }`}
    >
      <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-[12px] font-semibold text-ink-800 dark:text-ink-100">
            Linha {row.rowNumber} · {row.raw.description || 'Sem descrição'}
          </p>
          <ul className="mt-1 space-y-0.5">
            {row.issues.map((issue) => (
              <li
                key={`${issue.field}-${issue.message}`}
                className="text-[11px] text-rose-700 dark:text-rose-300"
              >
                • {issue.message}
              </li>
            ))}
          </ul>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" variant="ghost" onClick={onCorrection}>
            <Pencil className="h-3 w-3" />
            Todos os campos
          </Button>
          {rejected ? (
            <Button size="sm" variant="secondary" onClick={onToggleRejected}>
              <Undo2 className="h-3 w-3" />
              Restaurar
            </Button>
          ) : (
            <Button size="sm" variant="secondary" onClick={onToggleRejected}>
              <Ban className="h-3 w-3" />
              Não importar
            </Button>
          )}
        </div>
      </div>

      {fields.length > 0 && (
        <div className="grid gap-2 sm:grid-cols-2">
          {fields.map((field) => {
            const config = FIELD_CONFIG.find((item) => item.field === field);
            return (
              <label key={field} className="block">
                <span className="mb-0.5 block text-[10px] font-medium uppercase tracking-wider text-ink-400">
                  {config?.label ?? field}
                </span>
                <input
                  className="input h-8 border-rose-300 bg-rose-50/60 text-[12px] focus:border-rose-500 dark:border-rose-800 dark:bg-rose-950/20"
                  value={valueFor(field)}
                  onChange={(event) => onDraftChange(field, event.target.value)}
                />
              </label>
            );
          })}
        </div>
      )}

      {row.suggestions.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] font-medium uppercase tracking-wider text-ink-400">
            Sugestões:
          </span>
          {row.suggestions.map((suggestion) => (
            <button
              key={`${suggestion.number}-${suggestion.total}-${suggestion.label}`}
              type="button"
              onClick={() => onSuggestion(suggestion)}
              className="rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-[10px] font-medium text-amber-800 transition hover:bg-amber-100 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200"
            >
              <Wand2 className="mr-1 inline h-3 w-3" />
              {suggestion.label}
            </button>
          ))}
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <p className="text-[10px] text-ink-400">
          Linha original {row.rowNumber} · referência preservada
          {row.raw.installments ? ` · coluna Parcelas: ${row.raw.installments}` : ''}
        </p>
        <Button size="sm" variant="primary" onClick={onApply} disabled={!hasDraft}>
          <Check className="h-3 w-3" />
          Aplicar e revalidar
        </Button>
      </div>
    </div>
  );
}

function InstallmentRecoverySection({
  proposals,
  selected,
  loading,
  applying,
  onLoad,
  onToggle,
  onSelectAll,
  onApply,
}: {
  proposals: InstallmentRecoveryProposal[] | null;
  selected: Set<number>;
  loading: boolean;
  applying: boolean;
  onLoad: () => void;
  onToggle: (id: number) => void;
  onSelectAll: () => void;
  onApply: () => void;
}) {
  const selectable = proposals?.filter((proposal) => !proposal.conflict) ?? [];
  const allSelected = selectable.length > 0 && selectable.every((p) => selected.has(p.transactionId));

  return (
    <div className="card mt-4 overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-ink-200 px-4 py-3 dark:border-ink-800">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold text-ink-900 dark:text-white">
            <ListChecks className="h-4 w-4 text-blue-500" />
            Parcelas em lançamentos existentes
          </h2>
          <p className="mt-0.5 text-[11px] text-ink-400">
            Procura parcelas ausentes ou incompletas que possam ser recuperadas pela descrição.
            Nada é alterado sem confirmação.
          </p>
        </div>
        <Button variant="secondary" size="sm" onClick={onLoad} loading={loading}>
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          Verificar parcelas
        </Button>
      </div>

      {proposals === null ? (
        <p className="px-4 py-6 text-center text-[12px] text-ink-400">
          Use "Verificar parcelas" para analisar os lançamentos já gravados.
        </p>
      ) : proposals.length === 0 ? (
        <p className="px-4 py-6 text-center text-[12px] text-ink-400">
          Nenhuma parcela recuperável encontrada. Lançamentos sem informação na descrição não são
          alterados.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-ink-200 bg-ink-50/50 px-4 py-2 dark:border-ink-800 dark:bg-ink-950/20">
            <label className="flex cursor-pointer items-center gap-2 text-[11px] font-medium text-ink-600 dark:text-ink-300">
              <input
                type="checkbox"
                className="h-3.5 w-3.5 rounded accent-blue-600"
                checked={allSelected}
                disabled={selectable.length === 0}
                onChange={onSelectAll}
              />
              Selecionar todas as correções sem conflito ({selectable.length})
            </label>
            <span className="text-[11px] text-ink-400">
              {selected.size} selecionada(s)
            </span>
          </div>
          <div className="max-h-[340px] space-y-2 overflow-auto p-3">
            {proposals.map((proposal) => (
              <div
                key={proposal.transactionId}
                className={`rounded-lg border p-2.5 ${
                  proposal.conflict
                    ? 'border-amber-200 bg-amber-50/40 dark:border-amber-900/50 dark:bg-amber-950/20'
                    : 'border-ink-200 dark:border-ink-800'
                }`}
              >
                <div className="flex items-start gap-2.5">
                  <input
                    type="checkbox"
                    className="mt-0.5 h-3.5 w-3.5 rounded accent-blue-600"
                    checked={selected.has(proposal.transactionId)}
                    disabled={proposal.conflict}
                    onChange={() => onToggle(proposal.transactionId)}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <p className="text-[12px] font-medium text-ink-800 dark:text-ink-100">
                        {proposal.description}
                      </p>
                      {proposal.conflict && (
                        <span className="badge bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
                          Conflito · revise manualmente
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 text-[11px] text-ink-500 dark:text-ink-400">
                      Lançamento #{proposal.transactionId} · {formatDateBR(proposal.dueDate)} ·{' '}
                      atual:{' '}
                      {proposal.currentNumber !== null || proposal.currentTotal !== null
                        ? formatInstallments(
                            proposal.currentNumber,
                            proposal.currentTotal,
                          )
                        : 'sem parcelas'}{' '}
                      <ArrowRight className="inline h-3 w-3" /> proposto:{' '}
                      <strong className="text-ink-700 dark:text-ink-200">
                        {proposal.proposedNumber}/{proposal.proposedTotal}
                      </strong>
                    </p>
                    <p className="mt-0.5 text-[10px] text-ink-400">
                      {proposal.reason}
                      {proposal.previous
                        ? ` · valor anterior preservado: ${proposal.previous}`
                        : ' · sem valor anterior'}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-ink-200 px-4 py-2.5 dark:border-ink-800">
            <p className="text-[10px] text-ink-400">
              A origem "descrição" e o valor anterior ficam registrados em cada lançamento.
            </p>
            <Button
              variant="primary"
              size="sm"
              onClick={onApply}
              loading={applying}
              disabled={selected.size === 0 || applying}
            >
              <CheckCircle2 className="h-3.5 w-3.5" />
              Aplicar {selected.size} correção(ões)
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

export function TransactionsImportPage() {
  const { meta, refresh: refreshMeta } = useMeta();
  const { showToast } = useToast();
  const navigate = useNavigate();
  const fileInput = useRef<HTMLInputElement>(null);
  const previewRequest = useRef(0);
  const previousPreview = useRef<ImportPreview | null>(null);
  // Mantém a identidade usada na prévia alinhada com a importação mesmo quando
  // o usuário remapeia colunas ou corrige linhas.
  const destinationRef = useRef<number | null>(null);
  const decisionsRef = useRef<CategoryDecisionsPayload>({});
  const previewGroupsRef = useRef<CategorySuggestionGroup[]>([]);
  /** Identidade (conta + decisões) usada na última prévia bem-sucedida. */
  const previewIdentityRef = useRef('');
  /** Espelho em estado para bloquear a importação durante o debounce. */
  const [syncedIdentity, setSyncedIdentity] = useState('');

  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping>({});
  const [overrides, setOverrides] = useState<ImportOverrides>({});
  const [rejected, setRejected] = useState<Set<number>>(new Set());
  const [skipDuplicates, setSkipDuplicates] = useState(true);
  const [dragActive, setDragActive] = useState(false);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [correction, setCorrection] = useState<PreviewRow | null>(null);
  const [transferDecisions, setTransferDecisions] = useState<Record<string, TransferDecision>>({});
  const [activeTab, setActiveTab] = useState<FilterTab>('all');
  const [duplicateIncludes, setDuplicateIncludes] = useState<Set<number>>(new Set());
  const [duplicateNotice, setDuplicateNotice] = useState<string | null>(null);
  const [inlineDrafts, setInlineDrafts] = useState<
    Record<number, Partial<Record<ImportField, string>>>
  >({});
  const [recoveryProposals, setRecoveryProposals] = useState<
    InstallmentRecoveryProposal[] | null
  >(null);
  const [recoverySelected, setRecoverySelected] = useState<Set<number>>(new Set());
  const [loadingRecovery, setLoadingRecovery] = useState(false);
  const [applyingRecovery, setApplyingRecovery] = useState(false);
  const [templates, setTemplates] = useState<ImportMappingTemplate[]>([]);
  const [templateName, setTemplateName] = useState('');
  const [savingTemplate, setSavingTemplate] = useState(false);
  /** Último modelo aplicado a este arquivo (é registrado no lote importado). */
  const [appliedTemplateId, setAppliedTemplateId] = useState<number | null>(null);
  /** Conta de destino quando o arquivo não tem coluna de pagamento. */
  const [destinationPaymentMethodId, setDestinationPaymentMethodId] = useState<number | null>(null);
  /** Decisões de categoria por categoria de origem, agrupadas na prévia. */
  const [categoryDecisions, setCategoryDecisions] = useState<CategoryDecisionsPayload>({});

  const loadTemplates = useCallback(async () => {
    try {
      const response = await api.listMappingTemplates();
      setTemplates(response.templates);
    } catch (err) {
      showToast(errorMessage(err), 'error');
    }
  }, [showToast]);

  useEffect(() => {
    void loadTemplates();
  }, [loadTemplates]);

  const runPreview = useCallback(
    async (
      selectedFile: File,
      nextMapping?: ColumnMapping,
      nextOverrides?: ImportOverrides,
      nextTemplateId?: number,
      nextOptions?: {
        destinationPaymentMethodId?: number | null;
        categoryDecisions?: CategoryDecisionsPayload;
      },
      preserveDrafts = false,
      silentSync = false,
    ) => {
      const requestId = previewRequest.current + 1;
      previewRequest.current = requestId;
      const priorPreview = previousPreview.current;
      setLoadingPreview(true);
      setError(null);
      // Sem opções explícitas, replica exatamente as decisões que a importação
      // vai enviar (incluindo aceites automáticos), para que a duplicidade da
      // prévia use a mesma identidade gravada.
      const options = nextOptions ?? {
        destinationPaymentMethodId: destinationRef.current,
        categoryDecisions: buildCategoryDecisions(
          previewGroupsRef.current,
          decisionsRef.current,
        ),
      };
      try {
        const response = await api.previewImport(
          selectedFile,
          nextMapping,
          nextOverrides ?? overrides,
          undefined,
          nextTemplateId,
          options,
        );
        if (requestId !== previewRequest.current) return;
        // A chave gravada precisa ser exatamente a que o efeito de
        // sincronização e `canImport` comparam. Serializar o mesmo payload de
        // duas formas diferentes (aqui e em `importIdentityKey`) fazia a chave
        // nunca coincidir: a prévia não estabilizava e o botão Importar
        // permanecia desabilitado.
        const identity = previewIdentityKey(options);
        previewIdentityRef.current = identity;
        setSyncedIdentity(identity);
        if (response.appliedTemplate) {
          setAppliedTemplateId(response.appliedTemplate.id);
        }
        const groupsChanged =
          priorPreview !== null &&
          duplicateGroupSignature(priorPreview.rows) !==
            duplicateGroupSignature(response.rows);
        if (groupsChanged && !silentSync) {
          setDuplicateNotice(
            'A estrutura de duplicidades foi recalculada após a edição. As decisões anteriores foram preservadas; confira a seleção antes de importar.',
          );
        }
        previousPreview.current = response;
        setPreview(response);
        setMapping(response.mapping);
        setTransferDecisions((current) => {
          const next = defaultDecisions(response.transferCandidates);
          for (const [key, decision] of Object.entries(current)) {
            if (Object.prototype.hasOwnProperty.call(next, key)) next[key] = decision;
          }
          return next;
        });
        setInlineDrafts((current) => (preserveDrafts ? current : {}));
        const rowNumbers = new Set(response.rows.map((row) => row.rowNumber));
        setRejected(
          (current) => new Set([...current].filter((rowNumber) => rowNumbers.has(rowNumber))),
        );
        setDuplicateIncludes(
          (current) => new Set([...current].filter((rowNumber) => rowNumbers.has(rowNumber))),
        );
      } catch (err) {
        if (requestId !== previewRequest.current) return;
        // Re-prévia automática não deve apagar a revisão atual em caso de falha.
        if (!silentSync) {
          previousPreview.current = null;
          setDuplicateNotice(null);
          setPreview(null);
        }
        setError(errorMessage(err));
        showToast(errorMessage(err), 'error');
      } finally {
        if (requestId === previewRequest.current) setLoadingPreview(false);
      }
    },
    [overrides, showToast],
  );

  // Sincroniza a identidade usada por padrão em toda prévia (remapeamento,
  // correção, modelo) com a conta e as decisões atuais.
  useEffect(() => {
    destinationRef.current = destinationPaymentMethodId;
    decisionsRef.current = categoryDecisions;
    previewGroupsRef.current = preview?.categorySuggestions ?? [];
  });

  // A prévia precisa usar a mesma identidade que a importação (conta de
  // destino + decisões de categoria, incluindo aceites automáticos). Quando a
  // prévia atual foi calculada com outra identidade, recalcula uma vez.
  useEffect(() => {
    if (!file || !preview) return;
    const identity = buildImportIdentity(
      preview.categorySuggestions,
      categoryDecisions,
      destinationPaymentMethodId,
    );
    const desired = previewIdentityKey(identity);
    if (desired === previewIdentityRef.current) return;
    const timer = window.setTimeout(() => {
      void runPreview(
        file,
        mapping,
        overrides,
        appliedTemplateId ?? undefined,
        {
          destinationPaymentMethodId: identity.destinationPaymentMethodId,
          categoryDecisions: identity.categoryDecisions,
        },
        true,
        true,
      );
    }, 300);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview, destinationPaymentMethodId, categoryDecisions]);

  const resetImport = useCallback(() => {
    previewRequest.current += 1;
    previousPreview.current = null;
    setFile(null);
    setPreview(null);
    setMapping({});
    setOverrides({});
    setRejected(new Set());
    setDuplicateIncludes(new Set());
    setDuplicateNotice(null);
    setInlineDrafts({});
    setActiveTab('all');
    setSummary(null);
    setTransferDecisions({});
    setError(null);
    setCorrection(null);
    setLoadingPreview(false);
    setAppliedTemplateId(null);
    setTemplateName('');
    setDestinationPaymentMethodId(null);
    setCategoryDecisions({});
    destinationRef.current = null;
    decisionsRef.current = {};
    previewGroupsRef.current = [];
    previewIdentityRef.current = '';
    setSyncedIdentity('');
    if (fileInput.current) fileInput.current.value = '';
  }, []);

  const selectFile = (selectedFile: File) => {
    if (selectedFile.size > MAX_FILE_SIZE) {
      showToast('Arquivo muito grande. O limite é 25 MB.', 'error');
      return;
    }
    if (!/\.(csv|xls|xlsx|xlsm)$/i.test(selectedFile.name)) {
      showToast('Formato não suportado. Envie CSV, XLS ou XLSX.', 'error');
      return;
    }
    previousPreview.current = null;
    setFile(selectedFile);
    setPreview(null);
    setMapping({});
    setOverrides({});
    setRejected(new Set());
    setDuplicateIncludes(new Set());
    setDuplicateNotice(null);
    setInlineDrafts({});
    setActiveTab('all');
    setTransferDecisions({});
    setError(null);
    setAppliedTemplateId(null);
    setDestinationPaymentMethodId(null);
    setCategoryDecisions({});
    destinationRef.current = null;
    decisionsRef.current = {};
    previewGroupsRef.current = [];
    previewIdentityRef.current = '';
    setSyncedIdentity('');
    void runPreview(selectedFile, undefined, {});
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragActive(false);
    const dropped = event.dataTransfer.files?.[0];
    if (dropped) selectFile(dropped);
  };

  const changeMapping = (field: ImportField, value: string) => {
    const next: ColumnMapping = {
      ...mapping,
      [field]: value === '' ? null : Number(value),
    };
    setMapping(next);
    if (!isMappingIdentityCompatible(mapping, next)) {
      // A conta de destino e as decisões de categoria dependem das colunas de
      // conta e categoria do arquivo. Uma seleção feita para o mapeamento
      // anterior não pode ser reutilizada em silêncio: ela é descartada e o
      // usuário precisa escolher de novo.
      setDestinationPaymentMethodId(null);
      setCategoryDecisions({});
      destinationRef.current = null;
      decisionsRef.current = {};
      // Os grupos da prévia anterior não valem para o novo mapeamento.
      previewGroupsRef.current = [];
      setDuplicateNotice(
        'O mapeamento mudou nas colunas de conta/categoria. Selecione a conta de destino e revise as categorias antes de importar.',
      );
    }
    if (file) void runPreview(file, next, overrides);
  };

  const saveCurrentTemplate = async () => {
    if (!preview) return;
    const name = templateName.trim();
    if (!name) {
      showToast('Informe um nome para o modelo de mapeamento.', 'error');
      return;
    }
    setSavingTemplate(true);
    try {
      await api.saveMappingTemplate({ name, headers: preview.headers, mapping });
      setTemplateName('');
      await loadTemplates();
      showToast(`Modelo "${name}" salvo. Ele será detectado automaticamente em arquivos do mesmo formato.`, 'success');
    } catch (err) {
      showToast(errorMessage(err), 'error');
    } finally {
      setSavingTemplate(false);
    }
  };

  const applyTemplateById = (templateId: number) => {
    if (!file) return;
    // Mapeamento vazio deixa o servidor aplicar o modelo sobre a sugestão.
    void runPreview(file, {}, overrides, templateId);
  };

  const deleteTemplateById = async (templateId: number) => {
    try {
      await api.deleteMappingTemplate(templateId);
      if (appliedTemplateId === templateId) setAppliedTemplateId(null);
      await loadTemplates();
      showToast('Modelo de mapeamento excluído.', 'info');
    } catch (err) {
      showToast(errorMessage(err), 'error');
    }
  };

  const applyCorrection = (values: Record<ImportField, string>) => {
    if (!correction || !file) return;
    const rowNumber = String(correction.rowNumber);
    const nextOverrides: ImportOverrides = {
      ...overrides,
      [rowNumber]: values,
    };
    setOverrides(nextOverrides);
    setCorrection(null);
    void runPreview(file, mapping, nextOverrides);
  };

  const effectiveRejected = useMemo(() => {
    const next = new Set(rejected);
    if (preview) {
      for (const row of preview.rows) {
        if (
          skipDuplicates &&
          row.duplicate?.kind === 'exact' &&
          !duplicateIncludes.has(row.rowNumber)
        ) {
          next.add(row.rowNumber);
        }
      }
    }
    return next;
  }, [preview, rejected, skipDuplicates, duplicateIncludes]);

  const includeRow = (rowNumber: number) => {
    setRejected((current) => {
      const next = new Set(current);
      next.delete(rowNumber);
      return next;
    });
    setDuplicateIncludes((current) => {
      const next = new Set(current);
      next.add(rowNumber);
      return next;
    });
  };

  const excludeRow = (rowNumber: number) => {
    setDuplicateIncludes((current) => {
      const next = new Set(current);
      next.delete(rowNumber);
      return next;
    });
    setRejected((current) => {
      const next = new Set(current);
      next.add(rowNumber);
      return next;
    });
  };

  const includeRows = (rowNumbers: number[]) => {
    setRejected((current) => {
      const next = new Set(current);
      for (const rowNumber of rowNumbers) next.delete(rowNumber);
      return next;
    });
    setDuplicateIncludes((current) => {
      const next = new Set(current);
      for (const rowNumber of rowNumbers) next.add(rowNumber);
      return next;
    });
  };

  const excludeRows = (rowNumbers: number[]) => {
    setDuplicateIncludes((current) => {
      const next = new Set(current);
      for (const rowNumber of rowNumbers) next.delete(rowNumber);
      return next;
    });
    setRejected((current) => {
      const next = new Set(current);
      for (const rowNumber of rowNumbers) next.add(rowNumber);
      return next;
    });
  };

  const toggleRejected = (rowNumber: number) => {
    if (effectiveRejected.has(rowNumber)) includeRow(rowNumber);
    else excludeRow(rowNumber);
  };

  const includeOnly = (rowNumbers: number[], chosen: number) => {
    setRejected((current) => {
      const next = new Set(current);
      for (const rowNumber of rowNumbers) {
        if (rowNumber === chosen) next.delete(rowNumber);
        else next.add(rowNumber);
      }
      return next;
    });
    setDuplicateIncludes((current) => {
      const next = new Set(current);
      for (const rowNumber of rowNumbers) {
        if (rowNumber === chosen) next.add(rowNumber);
        else next.delete(rowNumber);
      }
      return next;
    });
  };

  const rejectAllInvalid = () => {
    if (!preview) return;
    setRejected((current) => {
      const next = new Set(current);
      for (const row of preview.rows) {
        if (row.errors.length > 0) next.add(row.rowNumber);
      }
      return next;
    });
  };

  const restoreAll = () => {
    setRejected(new Set());
    setDuplicateIncludes(new Set());
    setDuplicateNotice(null);
  };

  const transferCandidates = useMemo(() => {
    if (!preview) return [];
    const included = (party: TransferParty) =>
      party.source !== 'file' ||
      (party.rowNumber !== null && !effectiveRejected.has(party.rowNumber));
    return preview.transferCandidates.filter(
      (candidate) => included(candidate.outgoing) && included(candidate.incoming),
    );
  }, [preview, effectiveRejected]);

  const setTransferDecision = (candidate: TransferCandidate, decision: TransferDecision) => {
    setTransferDecisions((current) => {
      const next = { ...current };
      if (decision === 'confirm' && preview) {
        for (const other of transferCandidates) {
          if (
            other.key !== candidate.key &&
            partiesConflict(other, candidate) &&
            next[other.key] === 'confirm'
          ) {
            next[other.key] = 'pending';
          }
        }
      }
      next[candidate.key] = decision;
      return next;
    });
  };

  const acceptedRows = useMemo(() => {
    if (!preview) return [];
    return preview.rows.filter(
      (row) => row.errors.length === 0 && !effectiveRejected.has(row.rowNumber),
    );
  }, [preview, effectiveRejected]);

  const selectedDuplicateCount = useMemo(() => {
    if (!preview) return 0;
    return preview.rows.filter(
      (row) =>
        row.errors.length === 0 &&
        !effectiveRejected.has(row.rowNumber) &&
        Boolean(row.duplicate),
    ).length;
  }, [preview, effectiveRejected]);

  const counts = useMemo(() => {
    const rows = preview?.rows ?? [];
    return {
      all: rows.length,
      valid: rows.filter((row) => row.errors.length === 0 && !row.duplicate).length,
      duplicates: rows.filter((row) => row.errors.length === 0 && Boolean(row.duplicate)).length,
      errors: rows.filter((row) => row.errors.length > 0).length,
      transfers: transferCandidates.length,
    };
  }, [preview, transferCandidates]);

  const filteredRows = useMemo(() => {
    if (!preview) return [];
    switch (activeTab) {
      case 'valid':
        return preview.rows.filter((row) => row.errors.length === 0 && !row.duplicate);
      case 'duplicates':
        return preview.rows.filter((row) => row.errors.length === 0 && Boolean(row.duplicate));
      case 'errors':
        return preview.rows.filter((row) => row.errors.length > 0);
      case 'all':
      default:
        return preview.rows;
    }
  }, [preview, activeTab]);

  // Une grupos que compartilham a mesma linha-líder ou o mesmo lançamento persistido,
  // para que cada registro apareça em uma única comparação.
  const duplicateGroups = useMemo<DuplicateGroup[]>(() => {
    if (!preview) return [];

    interface WorkingGroup {
      key: string;
      infos: DuplicateInfo[];
      rows: PreviewRow[];
      existing: DuplicateCounterpart | null;
      leaders: Set<number>;
    }

    const rowsByNumber = new Map(preview.rows.map((row) => [row.rowNumber, row]));
    const groups = new Map<string, WorkingGroup>();
    const parent = new Map<string, string>();

    const ensureGroup = (key: string): WorkingGroup => {
      let group = groups.get(key);
      if (!group) {
        group = { key, infos: [], rows: [], existing: null, leaders: new Set() };
        groups.set(key, group);
        parent.set(key, key);
      }
      return group;
    };

    const find = (key: string): string => {
      const current = parent.get(key) ?? key;
      if (current === key) return key;
      const root = find(current);
      parent.set(key, root);
      return root;
    };

    const union = (left: string, right: string) => {
      const leftRoot = find(left);
      const rightRoot = find(right);
      if (leftRoot !== rightRoot) parent.set(leftRoot, rightRoot);
    };

    for (const row of preview.rows) {
      const duplicate = row.duplicate;
      if (!duplicate) continue;
      const group = ensureGroup(duplicate.groupKey);
      group.infos.push(duplicate);
      group.rows.push(row);
      if (duplicate.source === 'database' && !group.existing) {
        group.existing = duplicate.counterpart;
      }
    }

    const fileGroupsByLeader = new Map<number, string[]>();
    const databaseGroupsByTransaction = new Map<number, string[]>();
    for (const group of groups.values()) {
      if (group.existing?.transactionId !== null && group.existing?.transactionId !== undefined) {
        const transactionGroups =
          databaseGroupsByTransaction.get(group.existing.transactionId) ?? [];
        transactionGroups.push(group.key);
        databaseGroupsByTransaction.set(group.existing.transactionId, transactionGroups);
      }
      const fileInfo = group.infos.find((info) => info.source === 'file');
      if (!fileInfo || fileInfo.counterpartRowNumber === null) continue;
      const leaderRowNumbers = fileGroupsByLeader.get(fileInfo.counterpartRowNumber) ?? [];
      leaderRowNumbers.push(group.key);
      fileGroupsByLeader.set(fileInfo.counterpartRowNumber, leaderRowNumbers);
    }

    for (const groupKeys of databaseGroupsByTransaction.values()) {
      const targetKey = groupKeys[0];
      if (!targetKey) continue;
      for (const groupKey of groupKeys) union(groupKey, targetKey);
    }

    for (const [leaderRowNumber, groupKeys] of fileGroupsByLeader) {
      const leader = rowsByNumber.get(leaderRowNumber);
      if (!leader) continue;
      const targetKey = leader.duplicate ? leader.duplicate.groupKey : groupKeys[0];
      if (!targetKey) continue;
      for (const groupKey of groupKeys) union(groupKey, targetKey);
      if (!leader.duplicate) {
        groups.get(targetKey)?.leaders.add(leader.rowNumber);
      }
    }

    const aggregated = new Map<string, DuplicateGroup>();
    for (const group of groups.values()) {
      const root = find(group.key);
      let merged = aggregated.get(root);
      if (!merged) {
        merged = { key: root, kind: 'probable', rows: [], existing: null, reasons: [] };
        aggregated.set(root, merged);
      }

      const orderedInfos = [...group.infos].sort(
        (left, right) =>
          Number(right.source === 'database') - Number(left.source === 'database'),
      );
      for (const info of orderedInfos) {
        if (!merged.reasons.includes(info.reason)) merged.reasons.push(info.reason);
      }

      for (const row of group.rows) {
        if (!merged.rows.some((current) => current.rowNumber === row.rowNumber)) {
          merged.rows.push(row);
        }
      }
      if (!merged.existing && group.existing) merged.existing = group.existing;
      for (const rowNumber of group.leaders) {
        const leader = rowsByNumber.get(rowNumber);
        if (leader && !merged.rows.some((current) => current.rowNumber === leader.rowNumber)) {
          merged.rows.push(leader);
        }
      }
    }

    for (const group of aggregated.values()) {
      group.rows.sort((left, right) => left.rowNumber - right.rowNumber);
      const kinds = [
        ...new Set(
          group.rows.flatMap((row) => (row.duplicate ? [row.duplicate.kind] : [])),
        ),
      ];
      group.kind =
        kinds.length === 1 ? kinds[0] : kinds.length > 1 ? 'mixed' : 'probable';
    }

    return [...aggregated.values()].sort((left, right) => {
      const leftRow = left.rows[0]?.rowNumber ?? Number.MAX_SAFE_INTEGER;
      const rightRow = right.rows[0]?.rowNumber ?? Number.MAX_SAFE_INTEGER;
      return leftRow - rightRow;
    });
  }, [preview]);

  const draftValue = (row: PreviewRow, field: ImportField) =>
    inlineDrafts[row.rowNumber]?.[field] ??
    overrides[String(row.rowNumber)]?.[field] ??
    fieldInitialValue(row, field);

  const setDraft = (rowNumber: number, field: ImportField, value: string) => {
    setInlineDrafts((current) => ({
      ...current,
      [rowNumber]: { ...(current[rowNumber] ?? {}), [field]: value },
    }));
  };

  const mergeOverride = (rowNumber: number, patch: Partial<Record<ImportField, string>>) => {
    if (!file) return;
    const key = String(rowNumber);
    const nextOverrides: ImportOverrides = {
      ...overrides,
      [key]: { ...(overrides[key] ?? {}), ...patch },
    };
    setOverrides(nextOverrides);
    void runPreview(file, mapping, nextOverrides);
  };

  const applyInlineDraft = (row: PreviewRow) => {
    const patch = inlineDrafts[row.rowNumber];
    if (!patch || Object.keys(patch).length === 0) return;
    mergeOverride(row.rowNumber, patch);
  };

  const applySuggestion = (row: PreviewRow, suggestion: RowSuggestion) => {
    mergeOverride(row.rowNumber, {
      installments: `${suggestion.number}/${suggestion.total}`,
    });
  };

  const loadRecovery = async () => {
    setLoadingRecovery(true);
    try {
      const response = await api.getInstallmentRecovery();
      setRecoveryProposals(response.proposals);
      setRecoverySelected(
        new Set(
          response.proposals
            .filter((proposal) => !proposal.conflict)
            .map((proposal) => proposal.transactionId),
        ),
      );
    } catch (err) {
      showToast(errorMessage(err), 'error');
    } finally {
      setLoadingRecovery(false);
    }
  };

  const toggleRecovery = (id: number) => {
    setRecoverySelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAllRecovery = () => {
    if (!recoveryProposals) return;
    const selectable = recoveryProposals
      .filter((proposal) => !proposal.conflict)
      .map((proposal) => proposal.transactionId);
    setRecoverySelected((current) =>
      selectable.length > 0 && selectable.every((id) => current.has(id))
        ? new Set()
        : new Set(selectable),
    );
  };

  const applyRecovery = async () => {
    if (recoverySelected.size === 0) return;
    setApplyingRecovery(true);
    try {
      const result = await api.applyInstallmentRecovery([...recoverySelected]);
      showToast(
        `${result.updated} parcela(s) corrigida(s).${
          result.skipped.length > 0
            ? ` ${result.skipped.length} conflito(s) preservado(s) para revisão manual.`
            : ''
        }`,
        result.updated > 0 ? 'success' : 'info',
      );
      const response = await api.getInstallmentRecovery();
      setRecoveryProposals(response.proposals);
      setRecoverySelected(
        new Set(
          response.proposals
            .filter((proposal) => !proposal.conflict)
            .map((proposal) => proposal.transactionId),
        ),
      );
      await refreshMeta();
    } catch (err) {
      showToast(errorMessage(err), 'error');
    } finally {
      setApplyingRecovery(false);
    }
  };

  const appliedTemplateName = useMemo(
    () =>
      preview?.appliedTemplate?.name ??
      templates.find((template) => template.id === appliedTemplateId)?.name ??
      null,
    [preview, templates, appliedTemplateId],
  );

  // A conta só é obrigatória quando alguma linha que será importada não tem conta.
  const needsDestinationAccount = acceptedRows.some(
    (row) => row.values.paymentMethod == null,
  );

  const reviewCategoryGroups = useMemo(
    () => (preview?.categorySuggestions ?? []).filter(isReviewableCategoryGroup),
    [preview],
  );

  // A importação só é liberada quando a prévia exibida já usou a mesma
  // identidade (conta + decisões) que será enviada. Fecha a janela do debounce
  // em que o usuário poderia importar com a tabela desatualizada.
  const desiredIdentity = previewIdentityKey(
    buildImportIdentity(
      preview?.categorySuggestions ?? [],
      categoryDecisions,
      destinationPaymentMethodId,
    ),
  );

  const canImport =
    Boolean(file) &&
    Boolean(preview) &&
    preview!.mappingErrors.length === 0 &&
    acceptedRows.length > 0 &&
    !loadingPreview &&
    !importing &&
    desiredIdentity === syncedIdentity &&
    (!needsDestinationAccount || destinationPaymentMethodId !== null);

  const executeImport = async () => {
    if (!file || !preview) return;
    if (needsDestinationAccount && destinationPaymentMethodId === null) return;
    setImporting(true);
    try {
      // Cada grupo recebe uma decisão explícita. A mesma função alimenta a
      // prévia, garantindo identidade de duplicidade igual à da importação.
      const identity = buildImportIdentity(
        preview.categorySuggestions,
        categoryDecisions,
        destinationPaymentMethodId,
      );
      // Duplicata só entra quando o usuário pediu explicitamente. O servidor
      // trata a lista como autoridade.
      const includedDuplicateRows = resolveIncludedDuplicateRows(preview.rows, {
        skipDuplicates,
        duplicateIncludes,
      });

      const response = await api.importFile(file, {
        mapping,
        overrides,
        // As decisões da revisão são enviadas explicitamente em rejectedRows.
        skipDuplicates: false,
        rejectedRows: [...effectiveRejected],
        includedDuplicateRows,
        toleranceDays: preview.transferToleranceDays,
        transferDecisions,
        templateId: appliedTemplateId ?? undefined,
        // A conta de destino é enviada sempre, igual à prévia: é parte da
        // identidade usada para calcular a duplicidade.
        destinationPaymentMethodId: destinationPaymentMethodId ?? undefined,
        categoryDecisions: identity.categoryDecisions,
      });
      setSummary(response);
      showToast(
        `${response.importedRows} lançamento(s) importado(s) com sucesso.`,
        response.importedRows > 0 ? 'success' : 'info',
      );
      await refreshMeta();
    } catch (err) {
      showToast(errorMessage(err), 'error');
    } finally {
      setImporting(false);
    }
  };

  const closeSummary = () => {
    resetImport();
  };

  const openSummaryTransactions = () => {
    const parts = isoToParts(summary?.firstDueDate);
    if (parts) {
      navigate(`/lancamentos?year=${parts.year}&month=${parts.month}&dateField=due`);
    } else {
      navigate('/lancamentos');
    }
    resetImport();
  };

  const correctionInitial = useMemo(() => {
    if (!correction) return null;
    return {
      ...correction.raw,
      ...(overrides[String(correction.rowNumber)] ?? {}),
      ...(inlineDrafts[correction.rowNumber] ?? {}),
    } as Record<ImportField, string>;
  }, [correction, overrides, inlineDrafts]);

  return (
    <div>
      <PageHeader
        title="Importar movimentações"
        subtitle="Importe sua planilha financeira em CSV ou Excel. Você revisa e corrige tudo antes de gravar."
        actions={
          <>
            <Link to="/lancamentos" className="btn-secondary">
              <ArrowRight className="h-3.5 w-3.5" />
              Ver movimentações
            </Link>
            <Link to="/importacoes" className="btn-secondary">
              <ArrowLeft className="h-3.5 w-3.5" />
              Voltar para Importações
            </Link>
          </>
        }
      />

      <input
        ref={fileInput}
        type="file"
        accept=".csv,.xls,.xlsx,.xlsm"
        className="hidden"
        onChange={(event) => {
          const selected = event.target.files?.[0];
          if (selected) selectFile(selected);
        }}
      />

      {!file ? (
        <div
          role="button"
          tabIndex={0}
          onClick={() => fileInput.current?.click()}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') fileInput.current?.click();
          }}
          onDragOver={(event) => {
            event.preventDefault();
            setDragActive(true);
          }}
          onDragLeave={() => setDragActive(false)}
          onDrop={handleDrop}
          className={`card flex cursor-pointer flex-col items-center justify-center border-dashed px-6 py-14 text-center transition ${
            dragActive
              ? 'border-blue-400 bg-blue-50/60 dark:border-blue-500 dark:bg-blue-950/20'
              : 'hover:border-blue-300 hover:bg-ink-50/50 dark:hover:border-blue-800 dark:hover:bg-ink-800/20'
          }`}
        >
          <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-blue-50 text-blue-600 dark:bg-blue-950/50 dark:text-blue-400">
            <UploadCloud className="h-6 w-6" />
          </div>
          <p className="text-[15px] font-semibold text-ink-900 dark:text-white">
            Arraste o arquivo aqui ou clique para selecionar
          </p>
          <p className="mt-1 text-[13px] text-ink-500 dark:text-ink-400">
            CSV, XLS ou XLSX · até 25 MB · a planilha original não é alterada
          </p>
          <div className="mt-5 grid max-w-xl gap-2 text-left text-[11px] text-ink-400 sm:grid-cols-2">
            <p className="rounded-lg bg-ink-50 px-3 py-2 dark:bg-ink-800/50">
              <strong className="text-ink-600 dark:text-ink-300">Datas:</strong> DD/MM/AAAA
            </p>
            <p className="rounded-lg bg-ink-50 px-3 py-2 dark:bg-ink-800/50">
              <strong className="text-ink-600 dark:text-ink-300">Valores:</strong> -R$ 500,00 · R$
              1.250,50
            </p>
            <p className="rounded-lg bg-ink-50 px-3 py-2 dark:bg-ink-800/50">
              <strong className="text-ink-600 dark:text-ink-300">Parcelas:</strong> 1/12
            </p>
            <p className="rounded-lg bg-ink-50 px-3 py-2 dark:bg-ink-800/50">
              <strong className="text-ink-600 dark:text-ink-300">Colunas:</strong> Data Compra,
              Vencimento, Compra, Valor, Pagamento, Parcelas, Categorias, Transf
            </p>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="card flex flex-wrap items-center gap-3 px-4 py-3.5">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-emerald-50 text-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-400">
              <FileSpreadsheet className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-semibold text-ink-900 dark:text-white">
                {file.name}
              </p>
              <p className="text-[11px] text-ink-400">
                {formatFileSize(file.size)}
                {preview ? ` · Planilha "${preview.sheetName}" · ${preview.totalRows} linha(s)` : ''}
              </p>
            </div>
            {loadingPreview && (
              <span className="flex items-center gap-1.5 text-[11px] text-ink-400">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Validando...
              </span>
            )}
            <Button variant="secondary" size="sm" onClick={() => fileInput.current?.click()}>
              Trocar arquivo
            </Button>
            <Button variant="ghost" size="sm" onClick={resetImport}>
              <RotateCcw className="h-3.5 w-3.5" />
              Remover
            </Button>
          </div>

          {error && (
            <div className="flex items-center gap-2 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-[13px] text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/30 dark:text-rose-300">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              {error}
            </div>
          )}

          {preview && (
            <>
              <div className="card overflow-hidden">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-ink-200 px-4 py-3 dark:border-ink-800">
                  <div>
                    <h2 className="text-sm font-semibold text-ink-900 dark:text-white">
                      Mapeamento de colunas
                    </h2>
                    <p className="text-[11px] text-ink-400">
                      Confirme a correspondência entre as colunas da planilha e os campos do
                      sistema. A ordem das colunas não importa.
                    </p>
                    {appliedTemplateName && (
                      <p className="mt-1 flex items-center gap-1 text-[11px] font-medium text-blue-700 dark:text-blue-300">
                        <Bookmark className="h-3 w-3" />
                        Modelo "{appliedTemplateName}" em uso nesta importação.
                      </p>
                    )}
                  </div>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => file && void runPreview(file, {}, overrides)}
                    disabled={loadingPreview}
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                    Detectar automaticamente
                  </Button>
                </div>
                <div className="grid gap-3.5 px-4 py-4 sm:grid-cols-2 xl:grid-cols-4">
                  {FIELD_CONFIG.map((config) => {
                    const value = mapping[config.field];
                    const samples = preview.rows
                      .slice(0, 2)
                      .map((row) => row.raw[config.field])
                      .filter(Boolean);
                    return (
                      <div key={config.field}>
                        <label className="label">
                          {config.label}
                          {config.required && <span className="ml-0.5 text-rose-500">*</span>}
                        </label>
                        <select
                          className="select"
                          value={value === null || value === undefined ? '' : value}
                          onChange={(event) => changeMapping(config.field, event.target.value)}
                          disabled={loadingPreview}
                        >
                          <option value="">Ignorar</option>
                          {preview.headers.map((header, index) => (
                            <option key={`${header}-${index}`} value={index}>
                              {header}
                            </option>
                          ))}
                        </select>
                        <p className="mt-1 truncate text-[10px] text-ink-400" title={samples.join(' · ')}>
                          {samples.length > 0 ? `Ex.: ${samples.join(' · ')}` : 'Sem amostra'}
                        </p>
                      </div>
                    );
                  })}
                </div>
                {preview.mappingErrors.length > 0 && (
                  <div className="border-t border-amber-200 bg-amber-50 px-4 py-2.5 text-[12px] text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
                    {preview.mappingErrors.join(' ')}
                  </div>
                )}
                {preview.mappingWarnings.length > 0 && (
                  <ul className="space-y-1 border-t border-ink-200 bg-ink-50/60 px-4 py-2.5 text-[12px] dark:border-ink-800 dark:bg-ink-900/40">
                    {preview.mappingWarnings.map((warning, index) => (
                      <li
                        key={`${warning.field ?? 'geral'}-${index}`}
                        className={`flex items-start gap-1.5 ${
                          warning.level === 'warning'
                            ? 'text-amber-700 dark:text-amber-300'
                            : 'text-ink-500 dark:text-ink-400'
                        }`}
                      >
                        {warning.level === 'warning' ? (
                          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        ) : (
                          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        )}
                        {warning.message}
                      </li>
                    ))}
                  </ul>
                )}
                <div className="flex flex-wrap items-center gap-2 border-t border-ink-200 px-4 py-2.5 dark:border-ink-800">
                  <div className="flex items-center gap-2">
                    <input
                      className="input h-8 w-56 text-[12px]"
                      placeholder="Nome do modelo (ex.: Cartão Nubank)"
                      value={templateName}
                      maxLength={80}
                      onChange={(event) => setTemplateName(event.target.value)}
                      disabled={loadingPreview || savingTemplate}
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void saveCurrentTemplate()}
                      disabled={savingTemplate || loadingPreview}
                    >
                      <Bookmark className="h-3.5 w-3.5" />
                      Salvar modelo
                    </Button>
                  </div>
                  <div className="ml-auto flex flex-wrap items-center gap-1.5">
                    {templates.map((template) => (
                      <span
                        key={template.id}
                        className={`flex items-center gap-1 rounded-lg border px-2 py-1 text-[11px] ${
                          appliedTemplateId === template.id
                            ? 'border-blue-300 bg-blue-50 text-blue-700 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-300'
                            : 'border-ink-200 bg-ink-50 text-ink-600 dark:border-ink-700 dark:bg-ink-800 dark:text-ink-300'
                        }`}
                      >
                        {template.name}
                        <button
                          type="button"
                          onClick={() => applyTemplateById(template.id)}
                          title={`Aplicar o modelo "${template.name}"`}
                          className="p-0.5 text-blue-600 transition hover:text-blue-500 dark:text-blue-400"
                        >
                          <Wand2 className="h-3 w-3" />
                          <span className="sr-only">Aplicar modelo</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => void deleteTemplateById(template.id)}
                          title={`Excluir o modelo "${template.name}"`}
                          className="p-0.5 text-rose-500 transition hover:text-rose-400"
                        >
                          <Trash2 className="h-3 w-3" />
                          <span className="sr-only">Excluir modelo</span>
                        </button>
                      </span>
                    ))}
                    {templates.length === 0 && (
                      <span className="text-[11px] text-ink-400">
                        Nenhum modelo salvo. Salve o mapeamento atual para reutilizar em
                        importações futuras do mesmo formato.
                      </span>
                    )}
                  </div>
                </div>
              </div>

              {needsDestinationAccount && (
                <div className="card overflow-hidden">
                  <div className="flex flex-wrap items-center gap-3 border-b border-ink-200 px-4 py-3 dark:border-ink-800">
                    <div>
                      <h2 className="text-sm font-semibold text-ink-900 dark:text-white">
                        Conta de destino do lote
                      </h2>
                      <p className="text-[11px] text-ink-400">
                        Algumas linhas não trazem conta/pagamento. Escolha a conta usada apenas
                        nessas linhas; as contas informadas no arquivo são preservadas.
                      </p>
                    </div>
                  </div>
                  <div className="px-4 py-3">
                    <select
                      className="select max-w-sm"
                      value={destinationPaymentMethodId ?? ''}
                      onChange={(event) =>
                        setDestinationPaymentMethodId(
                          event.target.value ? Number(event.target.value) : null,
                        )
                      }
                    >
                      <option value="">Selecione uma conta…</option>
                      {(meta?.paymentMethods ?? []).map((paymentMethod) => (
                        <option key={paymentMethod.id} value={paymentMethod.id}>
                          {paymentMethod.name}
                        </option>
                      ))}
                    </select>
                    {destinationPaymentMethodId === null && (
                      <p className="mt-1.5 text-[11px] text-amber-600 dark:text-amber-400">
                        Selecione uma conta para liberar a importação.
                      </p>
                    )}
                  </div>
                </div>
              )}

              {reviewCategoryGroups.length > 0 && (
                <div className="card overflow-hidden">
                  <div className="border-b border-ink-200 px-4 py-3 dark:border-ink-800">
                    <h2 className="text-sm font-semibold text-ink-900 dark:text-white">
                      Revisão de categorias
                    </h2>
                    <p className="text-[11px] text-ink-400">
                      Sugestões agrupadas por categoria de origem. A decisão vale para todas as
                      linhas do grupo. Sugestões ambíguas não são aplicadas sozinhas e aliases só
                      são salvos ao confirmar uma equivalência.
                    </p>
                  </div>
                  <ul className="divide-y divide-ink-200 dark:divide-ink-800">
                    {reviewCategoryGroups
                      .map((group) => {
                        const chosen = categoryDecisions[group.sourceNormalized];
                        const canAutoAccept = canAutoAcceptSuggestion(group);
                        const currentValue =
                          chosen === undefined
                            ? canAutoAccept
                              ? 'accept'
                              : 'create'
                            : chosen.action === 'use'
                              ? `cat:${chosen.targetCategoryId}`
                              : chosen.action;
                        const confidenceLabel =
                          group.confidence === 'high'
                            ? 'alta'
                            : group.confidence === 'medium'
                              ? 'média'
                              : 'baixa';
                        return (
                          <li
                            key={group.sourceNormalized}
                            className="flex flex-wrap items-start justify-between gap-3 px-4 py-3"
                          >
                            <div className="min-w-[240px] flex-1">
                              <p className="flex flex-wrap items-center gap-2 text-[13px] font-medium text-ink-900 dark:text-white">
                                {group.sourceCategory}
                                <span className="rounded bg-ink-100 px-1.5 py-0.5 text-[10px] font-normal text-ink-500 dark:bg-ink-800 dark:text-ink-400">
                                  {group.count} linha(s)
                                </span>
                                <span
                                  className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${
                                    group.confidence === 'high'
                                      ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
                                      : group.confidence === 'medium'
                                        ? 'bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300'
                                        : 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300'
                                  }`}
                                  title="Nível de confiança da sugestão"
                                >
                                  confiança {confidenceLabel}
                                </span>
                                {group.ambiguous && (
                                  <span className="rounded bg-rose-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">
                                    ambígua
                                  </span>
                                )}
                              </p>
                              <p className="mt-0.5 text-[11px] text-ink-500 dark:text-ink-400">
                                {group.reason}
                                {group.targetCategoryName
                                  ? ` Sugestão: ${group.targetCategoryName}.`
                                  : ''}
                              </p>
                            </div>
                            <div className="flex flex-col items-end gap-1">
                              <select
                                className="select h-8 max-w-[260px] text-[12px]"
                                value={currentValue}
                                onChange={(event) => {
                                  const value = event.target.value;
                                  setCategoryDecisions((previous) => ({
                                    ...previous,
                                    [group.sourceNormalized]: value.startsWith('cat:')
                                      ? {
                                          action: 'use',
                                          targetCategoryId: Number(value.slice(4)),
                                        }
                                      : value === 'accept'
                                        ? {
                                            action: 'accept',
                                            targetCategoryId: group.targetCategoryId ?? undefined,
                                          }
                                        : { action: 'create' },
                                  }));
                                }}
                              >
                                {group.targetCategoryId !== null && (
                                  <option value="accept">
                                    Usar sugerida{group.targetCategoryName
                                      ? ` (${group.targetCategoryName})`
                                      : ''}
                                  </option>
                                )}
                                <option value="create">Criar “{group.sourceCategory}”</option>
                                {(meta?.categories ?? []).length > 0 && (
                                  <optgroup label="Escolher categoria existente">
                                    {(meta?.categories ?? []).map((category) => (
                                      <option key={category.id} value={`cat:${category.id}`}>
                                        {category.name}
                                      </option>
                                    ))}
                                  </optgroup>
                                )}
                              </select>
                              {currentValue === 'accept' && chosen === undefined && (
                                <button
                                  type="button"
                                  onClick={() =>
                                    setCategoryDecisions((previous) => ({
                                      ...previous,
                                      [group.sourceNormalized]: {
                                        action: 'accept',
                                        targetCategoryId: group.targetCategoryId ?? undefined,
                                      },
                                    }))
                                  }
                                  className="text-[10px] font-semibold text-blue-600 transition hover:text-blue-500 dark:text-blue-400"
                                  title="Salvar esta equivalência como alias para próximas importações"
                                >
                                  Salvar equivalência
                                </button>
                              )}
                              {chosen !== undefined && chosen.action !== 'create' && (
                                <span className="text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                                  Equivalência confirmada
                                </span>
                              )}
                            </div>
                          </li>
                        );
                      })}
                  </ul>
                </div>
              )}

              <div className="card overflow-hidden">
                <div className="flex flex-wrap items-center gap-3 border-b border-ink-200 px-4 py-3 dark:border-ink-800">
                  <div>
                    <h2 className="text-sm font-semibold text-ink-900 dark:text-white">
                      Prévia e validação
                    </h2>
                    <p className="text-[11px] text-ink-400">
                      Corrija ou rejeite linhas antes de importar. Nada foi gravado ainda.
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                    <span className="badge bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
                      {counts.valid} válida(s)
                    </span>
                    <span className="badge bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">
                      {counts.errors} com erro
                    </span>
                    <span className="badge bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
                      {counts.duplicates} duplicada(s)
                    </span>
                    {effectiveRejected.size > 0 && (
                      <span className="badge bg-ink-100 text-ink-500 dark:bg-ink-800 dark:text-ink-400">
                        {effectiveRejected.size} ignorada(s)
                      </span>
                    )}
                  </div>
                  <div className="ml-auto flex flex-wrap items-center gap-2">
                    <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-ink-200 px-2.5 py-1.5 text-[11px] font-medium text-ink-600 dark:border-ink-700 dark:text-ink-300">
                      <input
                        type="checkbox"
                        checked={skipDuplicates}
                        onChange={(event) => setSkipDuplicates(event.target.checked)}
                        className="h-3.5 w-3.5 rounded accent-blue-600"
                      />
                      Ignorar duplicadas exatas
                    </label>
                    {preview.rows.some(
                      (row) => row.errors.length > 0 && !effectiveRejected.has(row.rowNumber),
                    ) && (
                      <Button variant="ghost" size="sm" onClick={rejectAllInvalid}>
                        <Ban className="h-3.5 w-3.5" />
                        Ignorar inválidas
                      </Button>
                    )}
                    {(rejected.size > 0 || duplicateIncludes.size > 0) && (
                      <Button variant="ghost" size="sm" onClick={restoreAll}>
                        <Undo2 className="h-3.5 w-3.5" />
                        Limpar decisões
                      </Button>
                    )}
                    <Button
                      variant="primary"
                      onClick={executeImport}
                      loading={importing}
                      disabled={!canImport}
                    >
                      <FileUp className="h-4 w-4" />
                      Importar {acceptedRows.length} linha(s)
                    </Button>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2 border-b border-ink-200 bg-ink-50/60 px-3 py-2 dark:border-ink-800 dark:bg-ink-950/20">
                  <div className="flex flex-wrap items-center gap-1 rounded-lg bg-ink-100/70 p-0.5 dark:bg-ink-900/60">
                    <TabButton
                      active={activeTab === 'all'}
                      label="Todas"
                      count={counts.all}
                      tone="ink"
                      onClick={() => setActiveTab('all')}
                    />
                    <TabButton
                      active={activeTab === 'valid'}
                      label="Válidas"
                      count={counts.valid}
                      tone="emerald"
                      onClick={() => setActiveTab('valid')}
                    />
                    <TabButton
                      active={activeTab === 'duplicates'}
                      label="Duplicadas"
                      count={counts.duplicates}
                      tone="amber"
                      onClick={() => setActiveTab('duplicates')}
                    />
                    <TabButton
                      active={activeTab === 'errors'}
                      label="Erros"
                      count={counts.errors}
                      tone="rose"
                      onClick={() => setActiveTab('errors')}
                    />
                    <TabButton
                      active={activeTab === 'transfers'}
                      label="Transferências"
                      count={counts.transfers}
                      tone="violet"
                      onClick={() => setActiveTab('transfers')}
                    />
                  </div>
                  <p className="ml-auto text-[10px] text-ink-400">
                    As decisões permanecem ao trocar de aba.
                  </p>
                </div>

                {duplicateNotice && (
                  <div
                    role="status"
                    className="flex flex-wrap items-center gap-2 border-b border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/25 dark:text-amber-200"
                  >
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                    <p className="min-w-[200px] flex-1">{duplicateNotice}</p>
                    {activeTab !== 'duplicates' && duplicateGroups.length > 0 && (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => setActiveTab('duplicates')}
                      >
                        Revisar duplicidades
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" onClick={() => setDuplicateNotice(null)}>
                      Fechar
                    </Button>
                  </div>
                )}

                {(activeTab === 'all' || activeTab === 'valid') && (
                <div className="table-shell max-h-[500px]">
                  <table className="w-full min-w-[1240px] border-collapse">
                    <thead className="sticky top-0 z-10">
                      <tr>
                        <th className="th w-[96px]">Status</th>
                        <th className="th w-12 text-right">Linha</th>
                        <th className="th">Data Compra</th>
                        <th className="th">Vencimento</th>
                        <th className="th whitespace-nowrap">1ª parcela (est.)</th>
                        <th className="th">Compra</th>
                        <th className="th text-right">Valor</th>
                        <th className="th">Pagamento</th>
                        <th className="th">Parcelas</th>
                        <th className="th">Categoria</th>
                        <th className="th">Transf</th>
                        <th className="th w-[118px] text-right">Ações</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredRows.map((row) => {
                        const status = rowStatus(row, effectiveRejected);
                        const StatusIcon = status.icon;
                        const isRejected = effectiveRejected.has(row.rowNumber);
                        return (
                          <tr
                            key={row.rowNumber}
                            className={`transition ${
                              isRejected
                                ? 'opacity-55'
                                : row.errors.length > 0
                                  ? 'bg-rose-50/40 dark:bg-rose-950/10'
                                  : 'hover:bg-ink-50/70 dark:hover:bg-ink-800/30'
                            }`}
                          >
                            <td className="td">
                              <span className={`badge ${status.className}`}>
                                <StatusIcon className="h-3 w-3" />
                                {status.label}
                              </span>
                            </td>
                            <td className="td num text-right text-ink-400">{row.rowNumber}</td>
                            <td className="td whitespace-nowrap">
                              {row.values.purchaseDate
                                ? formatDateBR(row.values.purchaseDate)
                                : row.raw.purchaseDate || '—'}
                              {row.values.purchaseDateSource === 'due_date_fallback' && (
                                <span
                                  className="ml-1.5 rounded bg-ink-100 px-1 align-middle text-[9px] font-semibold uppercase text-ink-500 dark:bg-ink-800 dark:text-ink-400"
                                  title="Data de compra não informada no arquivo; derivada do vencimento. Origem registrada no lançamento."
                                >
                                  do venc.
                                </span>
                              )}
                            </td>
                            <td className="td whitespace-nowrap">
                              {row.values.dueDate
                                ? formatDateBR(row.values.dueDate)
                                : row.raw.dueDate || '—'}
                              {row.values.dueDateSource === 'estimated_from_installment' && (
                                <span
                                  className="ml-1.5 rounded bg-blue-50 px-1 align-middle text-[9px] font-semibold uppercase text-blue-600 dark:bg-blue-950/40 dark:text-blue-300"
                                  title="Vencimento não informado no arquivo: calculado pela data de compra e pela parcela atual. Pode diferir do vencimento bancário real."
                                >
                                  estimado
                                </span>
                              )}
                              {row.values.dueDateSource === 'derived_from_purchase_fallback' && (
                                <span
                                  className="ml-1.5 rounded bg-ink-100 px-1 align-middle text-[9px] font-semibold uppercase text-ink-500 dark:bg-ink-800 dark:text-ink-300"
                                  title="Sem vencimento e sem parcela válida: assumido igual à data de compra, sem cálculo de parcela."
                                >
                                  sem parcela
                                </span>
                              )}
                              {row.values.dueDateSource === 'derived_from_cash_purchase' && (
                                <span
                                  className="ml-1.5 rounded bg-emerald-50 px-1 align-middle text-[9px] font-semibold uppercase text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300"
                                  title="Compra à vista: vencimento considerado igual à data de compra."
                                >
                                  à vista
                                </span>
                              )}
                            </td>
                            <td className="td whitespace-nowrap">
                              {row.values.estimatedFirstInstallmentDate ? (
                                <span
                                  className="inline-flex items-center gap-1"
                                  title="Data estimada da primeira parcela: vencimento menos a quantidade de parcelas anteriores. É um cálculo, não a data real da compra."
                                >
                                  {formatDateBR(row.values.estimatedFirstInstallmentDate)}
                                  <span className="rounded bg-blue-50 px-1 text-[9px] font-semibold uppercase text-blue-600 dark:bg-blue-950/40 dark:text-blue-300">
                                    est.
                                  </span>
                                </span>
                              ) : (
                                '—'
                              )}
                            </td>
                            <td className="td">
                              <p className="max-w-[280px] truncate font-medium text-ink-800 dark:text-ink-100">
                                {row.values.description || row.raw.description || '—'}
                              </p>
                              {row.errors.length > 0 && (
                                <ul className="mt-0.5 space-y-0.5 text-[10px] text-rose-600 dark:text-rose-400">
                                  {row.errors.slice(0, 3).map((message) => (
                                    <li key={message}>{message}</li>
                                  ))}
                                </ul>
                              )}
                              {row.duplicate && row.errors.length === 0 && (
                                <p
                                  className={`mt-0.5 text-[10px] ${
                                    row.duplicate.kind === 'exact'
                                      ? 'text-amber-600 dark:text-amber-400'
                                      : 'text-blue-600 dark:text-blue-400'
                                  }`}
                                >
                                  {row.duplicate.reason}
                                </p>
                              )}
                            </td>
                            <td className="td num whitespace-nowrap text-right">
                              {row.values.amountCents !== null
                                ? formatBRL(row.values.amountCents)
                                : row.raw.amount || '—'}
                            </td>
                            <td className="td">
                              <span className="block max-w-[140px] truncate">
                                {row.values.paymentMethod}
                              </span>
                            </td>
                            <td className="td num whitespace-nowrap">
                              {row.values.installmentNumber !== null ||
                              row.values.installmentTotal !== null
                                ? formatInstallments(
                                    row.values.installmentNumber,
                                    row.values.installmentTotal,
                                  )
                                : row.raw.installments || '—'}
                            </td>
                            <td className="td">
                              <span className="block max-w-[140px] truncate">
                                {row.values.category}
                              </span>
                            </td>
                            <td className="td">
                              {row.values.transfer ? (
                                <span className="badge bg-violet-50 text-violet-700 dark:bg-violet-950/40 dark:text-violet-300">
                                  {row.values.transfer}
                                </span>
                              ) : (
                                <span className="text-ink-300 dark:text-ink-600">—</span>
                              )}
                            </td>
                            <td className="td">
                              <div className="flex justify-end gap-1">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => setCorrection(row)}
                                  className="h-7 px-2"
                                >
                                  <Pencil className="h-3 w-3" />
                                  Corrigir
                                </Button>
                                <button
                                  type="button"
                                  onClick={() => toggleRejected(row.rowNumber)}
                                  className={`icon-btn h-7 w-7 ${
                                    isRejected
                                      ? 'text-blue-600 dark:text-blue-400'
                                      : 'hover:bg-amber-50 hover:text-amber-600 dark:hover:bg-amber-950/40'
                                  }`}
                                  title={isRejected ? 'Restaurar linha' : 'Rejeitar linha'}
                                  aria-label={isRejected ? 'Restaurar linha' : 'Rejeitar linha'}
                                >
                                  {isRejected ? (
                                    <Undo2 className="h-3.5 w-3.5" />
                                  ) : (
                                    <Ban className="h-3.5 w-3.5" />
                                  )}
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                )}

                {(activeTab === 'all' || activeTab === 'valid') && filteredRows.length === 0 && (
                  <p className="py-8 text-center text-[12px] text-ink-400">
                    Nenhuma linha nesta aba.
                  </p>
                )}

                <div className="flex flex-wrap items-center justify-between gap-2 border-t border-ink-200 px-4 py-2.5 text-[11px] text-ink-400 dark:border-ink-800">
                  <span>
                    {acceptedRows.length} linha(s) serão importadas
                    {selectedDuplicateCount > 0
                      ? ` · ${selectedDuplicateCount} duplicada(s) incluída(s)`
                      : ''}
                    {effectiveRejected.size > 0
                      ? ` · ${effectiveRejected.size} ignorada(s)`
                      : ''}
                  </span>
                  <span>
                    Categorias e formas de pagamento inexistentes serão criadas automaticamente.
                  </span>
                </div>
              </div>

              {activeTab === 'duplicates' && (
                <div className="card overflow-hidden">
                  <div className="border-b border-ink-200 px-4 py-3 dark:border-ink-800">
                    <h2 className="flex items-center gap-2 text-sm font-semibold text-ink-900 dark:text-white">
                      <Copy className="h-4 w-4 text-amber-500" />
                      Revisão de duplicidades
                    </h2>
                    <p className="mt-0.5 text-[11px] text-ink-400">
                      Todos os registros equivalentes aparecem juntos. Escolha exatamente quais
                      importar; registros já cadastrados são apenas referência e nunca são
                      substituídos.
                    </p>
                  </div>
                  {duplicateGroups.length === 0 ? (
                    <p className="px-4 py-8 text-center text-[12px] text-ink-400">
                      Nenhuma duplicidade encontrada neste arquivo.
                    </p>
                  ) : (
                    <div className="space-y-3 p-3">
                      {duplicateGroups.map((group) => (
                        <DuplicateGroupCard
                          key={group.key}
                          group={group}
                          rejected={effectiveRejected}
                          onInclude={includeRow}
                          onExclude={excludeRow}
                          onIncludeOnly={includeOnly}
                          onIncludeAll={includeRows}
                          onExcludeAll={excludeRows}
                          onEdit={(row) => setCorrection(row)}
                        />
                      ))}
                    </div>
                  )}
                </div>
              )}

              {activeTab === 'errors' && (
                <div className="card overflow-hidden">
                  <div className="border-b border-ink-200 px-4 py-3 dark:border-ink-800">
                    <h2 className="flex items-center gap-2 text-sm font-semibold text-ink-900 dark:text-white">
                      <AlertTriangle className="h-4 w-4 text-rose-500" />
                      Revisão de erros
                    </h2>
                    <p className="mt-0.5 text-[11px] text-ink-400">
                      Corrija somente as células problemáticas e revalide. Os valores originais e a
                      referência da linha são preservados.
                    </p>
                  </div>
                  {filteredRows.length === 0 ? (
                    <p className="px-4 py-8 text-center text-[12px] text-ink-400">
                      Nenhuma linha inválida. Todas as linhas problemáticas foram corrigidas ou
                      ignoradas.
                    </p>
                  ) : (
                    <div className="space-y-2.5 p-3">
                      {filteredRows.map((row) => (
                        <ErrorRowCard
                          key={row.rowNumber}
                          row={row}
                          draft={inlineDrafts[row.rowNumber] ?? {}}
                          valueFor={(field) => draftValue(row, field)}
                          rejected={effectiveRejected.has(row.rowNumber)}
                          onDraftChange={(field, value) => setDraft(row.rowNumber, field, value)}
                          onApply={() => applyInlineDraft(row)}
                          onSuggestion={(suggestion) => applySuggestion(row, suggestion)}
                          onCorrection={() => setCorrection(row)}
                          onToggleRejected={() => toggleRejected(row.rowNumber)}
                        />
                      ))}
                    </div>
                  )}
                </div>
              )}

              {activeTab === 'transfers' && (
                <div className="card overflow-hidden">
                  <div className="flex flex-wrap items-start justify-between gap-2 border-b border-ink-200 px-4 py-3 dark:border-ink-800">
                    <div>
                      <h2 className="flex items-center gap-2 text-sm font-semibold text-ink-900 dark:text-white">
                        <Link2 className="h-4 w-4 text-violet-500" />
                        Transferências identificadas
                      </h2>
                      <p className="mt-0.5 text-[11px] text-ink-400">
                        {transferCandidates.length} par(es) candidato(s) · tolerância de{' '}
                        {preview.transferToleranceDays} dia(s) entre datas. Revise antes de importar.
                      </p>
                    </div>
                    <span className="text-[11px] text-ink-400">
                      Pares de alta confiança já vêm confirmados.
                    </span>
                  </div>
                  <div className="space-y-2.5 px-4 py-3.5">
                    {transferCandidates.length === 0 ? (
                      <p className="py-6 text-center text-[12px] text-ink-400">
                        Nenhuma transferência identificada entre o arquivo e os lançamentos
                        existentes. Você também pode revisar pares já gravados em Conciliação.
                      </p>
                    ) : (
                      <>
                        {transferCandidates.slice(0, 50).map((candidate) => (
                          <TransferCandidateRow
                            key={candidate.key}
                            candidate={candidate}
                            decision={transferDecisions[candidate.key] ?? 'pending'}
                            onDecision={(decision) => setTransferDecision(candidate, decision)}
                          />
                        ))}
                        {transferCandidates.length > 50 && (
                          <p className="text-[11px] text-ink-400">
                            Mostrando 50 de {transferCandidates.length} pares candidatos.
                          </p>
                        )}
                      </>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      <InstallmentRecoverySection
        proposals={recoveryProposals}
        selected={recoverySelected}
        loading={loadingRecovery}
        applying={applyingRecovery}
        onLoad={() => void loadRecovery()}
        onToggle={toggleRecovery}
        onSelectAll={selectAllRecovery}
        onApply={() => void applyRecovery()}
      />

      {correction && correctionInitial && (
        <CorrectionModal
          row={correction}
          initial={correctionInitial}
          onClose={() => setCorrection(null)}
          onSave={applyCorrection}
          onReject={() => {
            excludeRow(correction.rowNumber);
            setCorrection(null);
          }}
        />
      )}

      {summary && (
        <Modal
          title="Importação concluída"
          description={summary.filename}
          onClose={closeSummary}
          size="lg"
          footer={
            <>
              <Button onClick={closeSummary}>Importar outro arquivo</Button>
              <Button variant="primary" onClick={openSummaryTransactions}>
                Ver movimentações
              </Button>
            </>
          }
        >
          <div className="mb-4 flex items-center gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 dark:border-emerald-900/60 dark:bg-emerald-950/30">
            <CheckCircle2 className="h-8 w-8 shrink-0 text-emerald-600 dark:text-emerald-400" />
            <div>
              <p className="text-[14px] font-semibold text-emerald-900 dark:text-emerald-100">
                {summary.importedRows} lançamento(s) gravado(s)
              </p>
              <p className="text-[12px] text-emerald-700/80 dark:text-emerald-300/80">
                Lote #{summary.batchId} · {summary.totalRows} linha(s) lida(s) ·{' '}
                {summary.rejectedRows} rejeitada(s)
              </p>
            </div>
          </div>

          <div className="grid gap-2 sm:grid-cols-3">
            <div className="rounded-lg border border-ink-200 px-3 py-2.5 dark:border-ink-800">
              <p className="text-[10px] uppercase tracking-wider text-ink-400">Importadas</p>
              <p className="num text-lg font-semibold text-emerald-600 dark:text-emerald-400">
                {summary.importedRows}
              </p>
            </div>
            <div className="rounded-lg border border-ink-200 px-3 py-2.5 dark:border-ink-800">
              <p className="text-[10px] uppercase tracking-wider text-ink-400">Ignoradas</p>
              <p className="num text-lg font-semibold text-amber-600 dark:text-amber-400">
                {summary.ignoredRows}
              </p>
            </div>
            <div className="rounded-lg border border-ink-200 px-3 py-2.5 dark:border-ink-800">
              <p className="text-[10px] uppercase tracking-wider text-ink-400">Com erro</p>
              <p className="num text-lg font-semibold text-rose-600 dark:text-rose-400">
                {summary.invalidRows}
              </p>
            </div>
          </div>

          {summary.transferCandidates > 0 && (
            <div className="mt-4 rounded-lg border border-violet-200 bg-violet-50/60 px-3 py-2.5 dark:border-violet-900/50 dark:bg-violet-950/20">
              <p className="flex items-center gap-1.5 text-[12px] font-semibold text-violet-800 dark:text-violet-200">
                <Link2 className="h-3.5 w-3.5" />
                Transferências analisadas
              </p>
              <p className="mt-0.5 text-[12px] text-violet-700/90 dark:text-violet-300/90">
                {summary.confirmedTransfers} vinculada(s) · {summary.pendingTransfers} pendente(s) ·{' '}
                {summary.rejectedTransfers} rejeitada(s)
              </p>
              {summary.pendingTransfers > 0 && (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <p className="text-[11px] text-violet-700/80 dark:text-violet-300/80">
                    Há possíveis transferências relacionadas a lançamentos anteriores. Revise os
                    pares já gravados para evitar dupla contagem.
                  </p>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      closeSummary();
                      navigate('/conciliacao');
                    }}
                  >
                    Revisar conciliação
                    <ArrowRight className="h-3 w-3" />
                  </Button>
                </div>
              )}
            </div>
          )}

          {(summary.createdCategories.length > 0 ||
            summary.createdPaymentMethods.length > 0) && (
            <div className="mt-4 space-y-3">
              {summary.createdCategories.length > 0 && (
                <div>
                  <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-400">
                    Categorias criadas
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {summary.createdCategories.map((name) => (
                      <span
                        key={name}
                        className="badge bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300"
                      >
                        {name}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {summary.createdPaymentMethods.length > 0 && (
                <div>
                  <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-400">
                    Formas de pagamento criadas
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {summary.createdPaymentMethods.map((name) => (
                      <span
                        key={name}
                        className="badge bg-violet-50 text-violet-700 dark:bg-violet-950/40 dark:text-violet-300"
                      >
                        {name}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {summary.errors.length > 0 && (
            <div className="mt-4">
              <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-400">
                Linhas não importadas
              </p>
              <div className="max-h-40 space-y-1 overflow-auto rounded-lg border border-rose-200 bg-rose-50/50 p-2.5 text-[11px] text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/20 dark:text-rose-300">
                {summary.errors.slice(0, 20).map((error) => (
                  <p key={error.rowNumber}>
                    <strong>Linha {error.rowNumber}:</strong> {error.errors.join(' ')}
                  </p>
                ))}
                {summary.errors.length > 20 && (
                  <p>Mais {summary.errors.length - 20} linha(s) com erro.</p>
                )}
              </div>
            </div>
          )}

          {summary.importedRows === 0 && (
            <p className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
              Nenhum lançamento foi gravado. Verifique as linhas rejeitadas, os erros ou a opção
              de ignorar duplicadas.
            </p>
          )}
        </Modal>
      )}
    </div>
  );
}
