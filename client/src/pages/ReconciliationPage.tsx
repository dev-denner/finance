import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Link2,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
  Unlink,
  XCircle,
} from 'lucide-react';
import { Button } from '../components/ui/Button';
import { PageHeader, Spinner } from '../components/ui/Page';
import { useToast } from '../context/ToastContext';
import { api, errorMessage } from '../lib/api';
import { formatBRL, formatDateBR, formatDateTimeBR } from '../lib/format';
import type {
  ConfirmedTransferRecord,
  ReconciliationResult,
  RejectedTransferRecord,
  TransferCandidate,
  TransferParty,
} from '../lib/types';

function ConfidenceBadge({
  confidence,
  ambiguous,
}: {
  confidence: string;
  ambiguous?: boolean;
}) {
  if (ambiguous) {
    return (
      <span className="badge bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
        Ambíguo
      </span>
    );
  }
  if (confidence === 'high') {
    return (
      <span className="badge bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
        Alta confiança
      </span>
    );
  }
  if (confidence === 'manual') {
    return (
      <span className="badge bg-violet-50 text-violet-700 dark:bg-violet-950/40 dark:text-violet-300">
        Manual
      </span>
    );
  }
  return (
    <span className="badge bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300">
      Possível correspondência
    </span>
  );
}

function Leg({
  party,
  side,
}: {
  party: TransferParty | TransferCandidate['outgoing'];
  side: 'out' | 'in';
}) {
  return (
    <div
      className={`rounded-xl border p-3 ${
        side === 'out'
          ? 'border-rose-200 bg-rose-50/40 dark:border-rose-900/50 dark:bg-rose-950/20'
          : 'border-emerald-200 bg-emerald-50/40 dark:border-emerald-900/50 dark:bg-emerald-950/20'
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <span
          className={`text-[10px] font-semibold uppercase tracking-wide ${
            side === 'out'
              ? 'text-rose-600 dark:text-rose-300'
              : 'text-emerald-600 dark:text-emerald-300'
          }`}
        >
          {side === 'out' ? 'Saída' : 'Entrada'}
        </span>
        <span className="text-[11px] text-ink-400">{formatDateBR(party.dueDate)}</span>
      </div>
      <p className="mt-1 text-[13px] font-medium text-ink-900 dark:text-white">
        {party.description}
      </p>
      <p className="mt-0.5 text-[11px] text-ink-500 dark:text-ink-400">
        {party.paymentMethod}
        {party.category ? ` · ${party.category}` : ''}
      </p>
      <p
        className={`mt-1.5 text-sm font-semibold tabular-nums ${
          party.amountCents < 0
            ? 'text-rose-700 dark:text-rose-300'
            : 'text-emerald-700 dark:text-emerald-300'
        }`}
      >
        {formatBRL(party.amountCents)}
      </p>
      {party.classification && (
        <p className="mt-1 text-[10px] text-ink-400">
          Classificação:{' '}
          {party.classification === 'transfer'
            ? 'transferência interna'
            : party.classification === 'card_settlement'
              ? 'pagamento de cartão'
              : party.classification}
        </p>
      )}
    </div>
  );
}

function Section({
  title,
  description,
  count,
  tone,
  actions,
  children,
  empty,
}: {
  title: string;
  description: string;
  count: number;
  tone: 'emerald' | 'amber' | 'ink' | 'rose';
  actions?: ReactNode;
  children: ReactNode;
  empty: string;
}) {
  const toneClasses = {
    emerald: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300',
    amber: 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300',
    ink: 'bg-ink-100 text-ink-600 dark:bg-ink-800 dark:text-ink-300',
    rose: 'bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300',
  }[tone];

  return (
    <section className="card overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-ink-200 px-4 py-3.5 dark:border-ink-800">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-ink-900 dark:text-white">{title}</h2>
            <span className={`badge ${toneClasses}`}>{count}</span>
          </div>
          <p className="mt-0.5 text-[11px] text-ink-400">{description}</p>
        </div>
        {actions}
      </div>
      {count === 0 ? (
        <p className="px-4 py-7 text-center text-[12px] text-ink-400">{empty}</p>
      ) : (
        <div className="space-y-2.5 p-3">{children}</div>
      )}
    </section>
  );
}

function PairArrow() {
  return (
    <div className="hidden items-center justify-center px-1 text-ink-300 md:flex">
      <ArrowRight className="h-5 w-5" />
    </div>
  );
}

export function ReconciliationPage() {
  const { showToast } = useToast();
  const [toleranceDays, setToleranceDays] = useState(3);
  const [includeRejected, setIncludeRejected] = useState(false);
  const [data, setData] = useState<ReconciliationResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await api.getReconciliation(toleranceDays, includeRejected));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [toleranceDays, includeRejected]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (key: string, action: () => Promise<unknown>, success: string) => {
    setBusy(key);
    try {
      await action();
      showToast(success);
      await load();
    } catch (err) {
      showToast(errorMessage(err), 'error');
    } finally {
      setBusy(null);
    }
  };

  const confirm = (candidate: TransferCandidate) => {
    const outgoingId = candidate.outgoing.transactionId;
    const incomingId = candidate.incoming.transactionId;
    if (outgoingId === null || incomingId === null) return;
    void run(
      `confirm:${candidate.key}`,
      () =>
        api.linkTransfer(
          outgoingId,
          incomingId,
          candidate.confidence === 'high' ? 'high' : 'probable',
        ),
      'Transferência confirmada. O consolidado já considera o vínculo.',
    );
  };

  const reject = (candidate: TransferCandidate) => {
    const outgoingId = candidate.outgoing.transactionId;
    const incomingId = candidate.incoming.transactionId;
    if (outgoingId === null || incomingId === null) return;
    void run(
      `reject:${candidate.key}`,
      () => api.rejectTransferPair(outgoingId, incomingId),
      'Correspondência rejeitada. Ela não será sugerida novamente enquanto os dados não mudarem.',
    );
  };

  const unlink = (record: ConfirmedTransferRecord) => {
    void run(
      `unlink:${record.id}`,
      () => api.unlinkTransfer(record.id),
      'Transferência desvinculada. As duas pontas voltam a ser analisadas separadamente.',
    );
  };

  const reconsider = (record: RejectedTransferRecord) => {
    void run(
      `reconsider:${record.id}`,
      () =>
        api.clearTransferRejection(record.outgoing.id, record.incoming.id),
      'Rejeição removida. O par volta a ser sugerido.',
    );
  };

  const summary = data?.summary;

  return (
    <div>
      <PageHeader
        title="Conciliação de transferências"
        subtitle="Analisa todos os lançamentos já gravados em busca de pares entre contas. A conciliação é independente da importação e não altera valores."
        actions={
          <Button variant="secondary" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            Reanalisar
          </Button>
        }
      />

      <div className="card mb-4 flex flex-wrap items-end gap-4 p-4">
        <label className="block">
          <span className="mb-1 block text-[11px] font-medium text-ink-500 dark:text-ink-400">
            Tolerância de datas
          </span>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={0}
              max={31}
              className="input h-9 w-24"
              value={toleranceDays}
              onChange={(event) => {
                const next = Number(event.target.value);
                setToleranceDays(Number.isFinite(next) ? Math.max(0, Math.min(31, next)) : 3);
              }}
            />
            <span className="text-[12px] text-ink-500 dark:text-ink-400">dia(s)</span>
          </div>
        </label>
        <label className="flex items-center gap-2 pb-2 text-[12px] text-ink-600 dark:text-ink-300">
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-ink-300"
            checked={includeRejected}
            onChange={(event) => setIncludeRejected(event.target.checked)}
          />
          Incluir pares rejeitados nas sugestões
        </label>
        <div className="ml-auto flex flex-wrap items-center gap-2 pb-0.5">
          <span className="flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-1 text-[11px] font-medium text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
            <ShieldCheck className="h-3.5 w-3.5" />
            {summary?.confirmed ?? 0} conciliada(s)
          </span>
          <span className="flex items-center gap-1 rounded-full bg-amber-50 px-2.5 py-1 text-[11px] font-medium text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
            <Search className="h-3.5 w-3.5" />
            {summary?.candidates ?? 0} possível(is)
          </span>
          <span className="flex items-center gap-1 rounded-full bg-ink-100 px-2.5 py-1 text-[11px] font-medium text-ink-600 dark:bg-ink-800 dark:text-ink-300">
            <AlertTriangle className="h-3.5 w-3.5" />
            {summary?.unmatched ?? 0} sem par
          </span>
          <span className="flex items-center gap-1 rounded-full bg-rose-50 px-2.5 py-1 text-[11px] font-medium text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">
            <XCircle className="h-3.5 w-3.5" />
            {summary?.rejected ?? 0} rejeitada(s)
          </span>
        </div>
      </div>

      {error && (
        <div className="mb-4 flex items-center gap-2 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-[13px] text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/30 dark:text-rose-300">
          <AlertTriangle className="h-4 w-4" />
          {error}
        </div>
      )}

      {loading && !data ? (
        <div className="card">
          <Spinner label="Analisando lançamentos e possíveis transferências..." />
        </div>
      ) : data ? (
        <div className="space-y-4">
          <Section
            title="Possíveis correspondências"
            description="Sinais opostos, mesmo valor, contas diferentes e datas próximas. Confira as evidências antes de confirmar."
            count={data.candidates.length}
            tone="amber"
            empty="Nenhum par compatível encontrado com os critérios atuais."
          >
            {data.candidates.map((candidate) => (
              <div key={candidate.key} className="rounded-xl border border-ink-200 p-3 dark:border-ink-800">
                <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <ConfidenceBadge
                      confidence={candidate.confidence}
                      ambiguous={candidate.ambiguous}
                    />
                    <span className="badge bg-ink-100 text-ink-600 dark:bg-ink-800 dark:text-ink-300">
                      {candidate.dayDistance === 0
                        ? 'mesmo dia'
                        : `${candidate.dayDistance} dia(s) de diferença`}
                    </span>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      loading={busy === `reject:${candidate.key}`}
                      disabled={busy !== null}
                      onClick={() => reject(candidate)}
                    >
                      <XCircle className="h-3.5 w-3.5" />
                      Rejeitar
                    </Button>
                    <Button
                      size="sm"
                      variant="primary"
                      loading={busy === `confirm:${candidate.key}`}
                      disabled={busy !== null}
                      onClick={() => confirm(candidate)}
                    >
                      <Link2 className="h-3.5 w-3.5" />
                      Confirmar transferência
                    </Button>
                  </div>
                </div>
                <div className="grid items-stretch gap-2 md:grid-cols-[1fr_32px_1fr]">
                  <Leg party={candidate.outgoing} side="out" />
                  <PairArrow />
                  <Leg party={candidate.incoming} side="in" />
                </div>
                <ul className="mt-2.5 flex flex-wrap gap-1.5">
                  {candidate.reasons.map((reason) => (
                    <li
                      key={reason}
                      className="rounded-full bg-ink-50 px-2 py-0.5 text-[10px] text-ink-500 dark:bg-ink-800/60 dark:text-ink-400"
                    >
                      {reason}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </Section>

          <Section
            title="Transferências conciliadas"
            description="Pares confirmados. Eles não entram como receita/despesa e cada lançamento participa de apenas uma transferência ativa."
            count={data.confirmed.length}
            tone="emerald"
            empty="Nenhuma transferência conciliada ainda."
          >
            {data.confirmed.map((record) => (
              <div
                key={record.id}
                className="rounded-xl border border-emerald-200 bg-emerald-50/30 p-3 dark:border-emerald-900/50 dark:bg-emerald-950/20"
              >
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="badge bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
                      <CheckCircle2 className="h-3 w-3" />
                      Conciliada
                    </span>
                    <ConfidenceBadge confidence={record.confidence} />
                    <span className="text-[10px] text-ink-400">
                      {record.origin === 'import' ? 'Origem: importação' : 'Origem: manual'}
                    </span>
                  </div>
                  <Button
                    size="sm"
                    variant="danger-soft"
                    loading={busy === `unlink:${record.id}`}
                    disabled={busy !== null}
                    onClick={() => unlink(record)}
                  >
                    <Unlink className="h-3.5 w-3.5" />
                    Desvincular
                  </Button>
                </div>
                <div className="grid items-stretch gap-2 md:grid-cols-[1fr_32px_1fr]">
                  <Leg
                    side="out"
                    party={{
                      ...record.outgoing,
                      key: `db:${record.outgoing.id}`,
                      source: 'database',
                      rowNumber: null,
                      transactionId: record.outgoing.id,
                      paymentMethod: record.outgoing.paymentMethodName,
                      category: record.outgoing.categoryName,
                    }}
                  />
                  <PairArrow />
                  <Leg
                    side="in"
                    party={{
                      ...record.incoming,
                      key: `db:${record.incoming.id}`,
                      source: 'database',
                      rowNumber: null,
                      transactionId: record.incoming.id,
                      paymentMethod: record.incoming.paymentMethodName,
                      category: record.incoming.categoryName,
                    }}
                  />
                </div>
              </div>
            ))}
          </Section>

          <Section
            title="Sem contraparte"
            description="Lançamentos com marcação ou classificação de transferência que não encontraram par compatível."
            count={data.unmatched.length}
            tone="ink"
            empty="Todos os lançamentos com indício de transferência encontraram alguma contraparte (ou já estão conciliados)."
          >
            <div className="grid gap-2 md:grid-cols-2">
              {data.unmatched.map((party) => (
                <Leg
                  key={party.key}
                  side={party.amountCents < 0 ? 'out' : 'in'}
                  party={party}
                />
              ))}
            </div>
          </Section>

          <Section
            title="Rejeitadas"
            description="Pares rejeitados manualmente. A rejeição só vale enquanto valor, data, conta e descrição permanecerem iguais."
            count={data.rejected.length}
            tone="rose"
            actions={
              data.rejected.length > 0 ? (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy !== null}
                  onClick={() =>
                    void run(
                      'reconsider-all',
                      () => api.clearAllTransferRejections(),
                      'Todas as rejeições foram removidas. Os pares voltam a ser sugeridos.',
                    )
                  }
                  loading={busy === 'reconsider-all'}
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  Reconsiderar todas
                </Button>
              ) : undefined
            }
            empty="Nenhum par rejeitado."
          >
            {data.rejected.map((record) => (
              <div
                key={record.id}
                className="rounded-xl border border-rose-200 bg-rose-50/30 p-3 dark:border-rose-900/50 dark:bg-rose-950/20"
              >
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="badge bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">
                      <XCircle className="h-3 w-3" />
                      Rejeitada
                    </span>
                    {!record.signatureMatches && (
                      <span className="badge bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
                        Dados alterados: rejeição expirou
                      </span>
                    )}
                    <span className="text-[10px] text-ink-400">
                      {formatDateTimeBR(record.createdAt)}
                    </span>
                  </div>
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={busy === `reconsider:${record.id}`}
                    disabled={busy !== null}
                    onClick={() => reconsider(record)}
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    Reconsiderar
                  </Button>
                </div>
                <div className="grid items-stretch gap-2 md:grid-cols-[1fr_32px_1fr]">
                  <Leg
                    side="out"
                    party={{
                      ...record.outgoing,
                      key: `db:${record.outgoing.id}`,
                      source: 'database',
                      rowNumber: null,
                      transactionId: record.outgoing.id,
                      paymentMethod: record.outgoing.paymentMethodName,
                      category: record.outgoing.categoryName,
                    }}
                  />
                  <PairArrow />
                  <Leg
                    side="in"
                    party={{
                      ...record.incoming,
                      key: `db:${record.incoming.id}`,
                      source: 'database',
                      rowNumber: null,
                      transactionId: record.incoming.id,
                      paymentMethod: record.incoming.paymentMethodName,
                      category: record.incoming.categoryName,
                    }}
                  />
                </div>
              </div>
            ))}
          </Section>
        </div>
      ) : null}

      <div className="mt-4 rounded-xl border border-ink-200 bg-ink-50/60 p-3.5 text-[11px] leading-relaxed text-ink-500 dark:border-ink-800 dark:bg-ink-950/30 dark:text-ink-400">
        <p className="mb-1 font-semibold text-ink-700 dark:text-ink-200">
          Como a conciliação decide
        </p>
        <p>
          O app combina sinais opostos, mesmo valor absoluto, contas diferentes e datas próximas.
          Marcadores de transferência, descrições (PIX/TED/transferência) e a classificação
          semântica das categorias elevam a confiança. Nenhum valor é alterado: a conciliação
          apenas cria ou remove o vínculo entre as duas pontas.
        </p>
      </div>
    </div>
  );
}
