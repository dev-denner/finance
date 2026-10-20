import { useEffect, useState } from 'react';
import { ArrowRight, Link2, Loader2, Unlink } from 'lucide-react';
import { Button } from './ui/Button';
import { Modal } from './ui/Modal';
import { useToast } from '../context/ToastContext';
import { api, errorMessage } from '../lib/api';
import { formatBRL, formatDateBR } from '../lib/format';
import type { Transaction, TransferCandidate, TransferParty } from '../lib/types';

interface TransferModalProps {
  transaction: Transaction;
  onClose: () => void;
  onChanged: () => void;
}

function ConfidenceBadge({ confidence, ambiguous }: { confidence: string; ambiguous?: boolean }) {
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
  return (
    <span className="badge bg-ink-100 text-ink-600 dark:bg-ink-800 dark:text-ink-300">
      Possível
    </span>
  );
}

function PartyCard({ party, tone }: { party: TransferParty; tone: 'out' | 'in' }) {
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
        <span className="num text-[13px] font-semibold text-ink-800 dark:text-ink-100">
          {formatBRL(party.amountCents)}
        </span>
      </div>
      <p className="mt-0.5 truncate text-[12px] font-medium text-ink-700 dark:text-ink-200">
        {party.description}
      </p>
      <p className="mt-0.5 flex items-center gap-2 text-[11px] text-ink-500 dark:text-ink-400">
        <span>{formatDateBR(party.dueDate)}</span>
        <span className="truncate">{party.paymentMethod}</span>
      </p>
      <p className="mt-0.5 text-[10px] text-ink-400">
        {party.source === 'database' ? `Lançamento #${party.transactionId}` : `Arquivo · linha ${party.rowNumber}`}
      </p>
    </div>
  );
}

export function TransferModal({ transaction, onClose, onChanged }: TransferModalProps) {
  const { showToast } = useToast();
  const [candidates, setCandidates] = useState<TransferCandidate[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const link = transaction.transferLink;

  useEffect(() => {
    if (link) return;
    let active = true;
    setLoading(true);
    api
      .getTransferCandidates(transaction.id)
      .then((data) => {
        if (active) setCandidates(data.candidates);
      })
      .catch((error) => {
        if (active) showToast(errorMessage(error), 'error');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [transaction.id, link, showToast]);

  const unlink = async () => {
    if (!link) return;
    setBusy('unlink');
    try {
      await api.unlinkTransfer(link.id);
      showToast('Transferência desvinculada. As marcações originais foram preservadas.');
      onChanged();
      onClose();
    } catch (error) {
      showToast(errorMessage(error), 'error');
    } finally {
      setBusy(null);
    }
  };

  const confirmLink = async (candidate: TransferCandidate) => {
    const outgoingId = candidate.outgoing.transactionId;
    const incomingId = candidate.incoming.transactionId;
    if (!outgoingId || !incomingId) {
      showToast('Não foi possível identificar os lançamentos deste par.', 'error');
      return;
    }
    setBusy(candidate.key);
    try {
      await api.linkTransfer(
        outgoingId,
        incomingId,
        candidate.confidence === 'high' ? 'high' : 'probable',
      );
      showToast('Transferência vinculada.');
      onChanged();
      onClose();
    } catch (error) {
      showToast(errorMessage(error), 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal
      title="Transferência entre contas"
      description={transaction.description}
      onClose={onClose}
      size="lg"
      footer={
        <>
          {link && (
            <Button variant="danger-soft" onClick={unlink} loading={busy === 'unlink'}>
              <Unlink className="h-3.5 w-3.5" />
              Desvincular
            </Button>
          )}
          <Button onClick={onClose}>Fechar</Button>
        </>
      }
    >
      {link ? (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="badge bg-violet-50 text-violet-700 dark:bg-violet-950/40 dark:text-violet-300">
              <Link2 className="mr-1 h-3 w-3" />
              Transferência confirmada
            </span>
            <span className="text-[12px] text-ink-500 dark:text-ink-400">
              {link.origin === 'import' ? 'Vínculo criado na importação' : 'Vínculo manual'}
            </span>
          </div>

          <div className="flex items-center gap-2 rounded-lg border border-ink-200 bg-ink-50/60 px-3 py-2 text-[12px] dark:border-ink-800 dark:bg-ink-900/40">
            <span className="truncate font-medium text-rose-600 dark:text-rose-400">
              {link.sourceAccount}
            </span>
            <ArrowRight className="h-3.5 w-3.5 shrink-0 text-ink-400" />
            <span className="truncate font-medium text-emerald-600 dark:text-emerald-400">
              {link.destinationAccount}
            </span>
          </div>

          <div>
            <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-400">
              Lançamento correspondente
            </p>
            <div className="rounded-lg border border-ink-200 px-3 py-2.5 dark:border-ink-800">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] text-ink-400">
                  {link.counterpart.amountCents < 0 ? 'Saída' : 'Entrada'}
                </span>
                <span className="num text-[13px] font-semibold text-ink-800 dark:text-ink-100">
                  {formatBRL(link.counterpart.amountCents)}
                </span>
              </div>
              <p className="mt-0.5 truncate text-[12px] font-medium text-ink-700 dark:text-ink-200">
                {link.counterpart.description}
              </p>
              <p className="mt-0.5 text-[11px] text-ink-500 dark:text-ink-400">
                {formatDateBR(link.counterpart.dueDate)} · {link.counterpart.paymentMethodName} ·{' '}
                {link.counterpart.categoryName}
              </p>
            </div>
          </div>

          <p className="text-[11px] leading-relaxed text-ink-400">
            Transferências internas não entram como receita ou despesa no consolidado. Ao desvincular,
            as marcações originais da planilha permanecem como evidência.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-[12px] leading-relaxed text-ink-500 dark:text-ink-400">
            {transaction.transferStatus === 'unconfirmed'
              ? 'Este lançamento foi marcado como transferência, mas ainda não tem um par confirmado.'
              : 'Nenhum vínculo de transferência. Escolha um lançamento correspondente, se houver.'}
          </p>

          {loading && (
            <div className="flex items-center justify-center gap-2 py-8 text-[13px] text-ink-400">
              <Loader2 className="h-4 w-4 animate-spin" />
              Procurando pares...
            </div>
          )}

          {!loading && candidates && candidates.length === 0 && (
            <p className="rounded-lg border border-ink-200 bg-ink-50/60 px-3 py-3 text-center text-[12px] text-ink-500 dark:border-ink-800 dark:bg-ink-900/40 dark:text-ink-400">
              Nenhum par candidato encontrado.
            </p>
          )}

          {!loading &&
            candidates?.map((candidate) => {
              const targetIsOutgoing = candidate.outgoing.transactionId === transaction.id;
              const other = targetIsOutgoing ? candidate.incoming : candidate.outgoing;
              return (
                <div
                  key={candidate.key}
                  className="rounded-xl border border-ink-200 p-3 dark:border-ink-800"
                >
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <ConfidenceBadge
                      confidence={candidate.confidence}
                      ambiguous={candidate.ambiguous}
                    />
                    <span className="text-[11px] text-ink-400">
                      {candidate.dayDistance === 0
                        ? 'Mesma data'
                        : `${candidate.dayDistance} dia(s) de diferença`}
                    </span>
                  </div>
                  <PartyCard party={other} tone={targetIsOutgoing ? 'in' : 'out'} />
                  <ul className="mt-2 space-y-0.5">
                    {candidate.reasons.map((reason) => (
                      <li key={reason} className="text-[11px] text-ink-500 dark:text-ink-400">
                        • {reason}
                      </li>
                    ))}
                  </ul>
                  <div className="mt-2.5 flex justify-end">
                    <Button
                      size="sm"
                      variant="primary"
                      onClick={() => confirmLink(candidate)}
                      loading={busy === candidate.key}
                    >
                      <Link2 className="h-3.5 w-3.5" />
                      Vincular
                    </Button>
                  </div>
                </div>
              );
            })}
        </div>
      )}
    </Modal>
  );
}
