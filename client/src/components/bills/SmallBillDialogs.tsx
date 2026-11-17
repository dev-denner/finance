import { useState } from 'react';
import { Button } from '../ui/Button';
import { Field } from '../ui/Field';
import { Modal } from '../ui/Modal';
import { formatBRL, formatDateBR } from '../../lib/format';
import type { Bill } from '../../lib/types';

/** Registrar (ou remover) a data em que o pagamento foi agendado no banco. */
export function ScheduleDialog({
  bill,
  today,
  onClose,
  onConfirm,
}: {
  bill: Bill;
  today: string;
  onClose: () => void;
  onConfirm: (scheduledFor: string | null) => Promise<void>;
}) {
  const [date, setDate] = useState(bill.scheduledFor ?? (today <= bill.dueDate ? today : bill.dueDate));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (value: string | null) => {
    if (value !== null && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      setError('Informe a data do agendamento.');
      return;
    }
    setSaving(true);
    try {
      await onConfirm(value);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title="Agendar pagamento"
      description={`${bill.description} · vence ${formatDateBR(bill.dueDate)}`}
      size="sm"
      onClose={onClose}
      footer={
        <>
          {bill.scheduledFor && (
            <Button variant="ghost" onClick={() => void run(null)} disabled={saving} className="mr-auto">
              Remover agendamento
            </Button>
          )}
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancelar
          </Button>
          <Button variant="primary" onClick={() => void run(date)} loading={saving}>
            Salvar
          </Button>
        </>
      }
    >
      <Field
        label="Agendado para"
        htmlFor="schedule-date"
        hint="Data em que o banco vai debitar. A conta deixa de aparecer como pendente nos lembretes."
        error={error ?? undefined}
      >
        <input id="schedule-date" type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} />
      </Field>
    </Modal>
  );
}

/**
 * Excluir. Conta avulsa é apagada. Ocorrência de recorrência pode ser só
 * pulada (a série não a recria) ou a recorrência inteira pode ser removida,
 * mantendo as já pagas.
 */
export function DeleteBillDialog({
  bill,
  recurrenceLabel,
  onClose,
  onDeleteBill,
  onDeleteTemplate,
}: {
  bill: Bill;
  recurrenceLabel: string | null;
  onClose: () => void;
  onDeleteBill: () => Promise<void>;
  onDeleteTemplate: () => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const run = async (action: () => Promise<void>) => {
    setSaving(true);
    try {
      await action();
    } finally {
      setSaving(false);
    }
  };
  const isRecurring = bill.templateId !== null;

  return (
    <Modal
      title={isRecurring ? 'Excluir conta recorrente' : 'Excluir conta'}
      description={`${bill.description} · ${formatDateBR(bill.dueDate)} · ${formatBRL(bill.amountCents)}`}
      size="sm"
      onClose={onClose}
      footer={
        isRecurring ? (
          <>
            <Button variant="secondary" onClick={onClose} disabled={saving}>
              Cancelar
            </Button>
            <Button variant="danger-soft" onClick={() => void run(onDeleteTemplate)} disabled={saving}>
              Excluir a recorrência
            </Button>
            <Button variant="danger" onClick={() => void run(onDeleteBill)} loading={saving}>
              Pular só esta
            </Button>
          </>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose} disabled={saving}>
              Cancelar
            </Button>
            <Button variant="danger" onClick={() => void run(onDeleteBill)} loading={saving}>
              Excluir
            </Button>
          </>
        )
      }
    >
      {isRecurring ? (
        <div className="space-y-2 text-[13px] text-ink-600 dark:text-ink-300">
          <p>
            Esta conta faz parte de uma recorrência{recurrenceLabel ? ` (${recurrenceLabel})` : ''}.
          </p>
          <p>
            <strong className="font-medium text-ink-800 dark:text-ink-100">Pular só esta</strong> mantém a série e
            marca esta ocorrência como pulada. <strong className="font-medium text-ink-800 dark:text-ink-100">Excluir a
            recorrência</strong> apaga as ocorrências em aberto; as já pagas continuam no histórico.
          </p>
        </div>
      ) : (
        <p className="text-[13px] text-ink-600 dark:text-ink-300">Esta ação não pode ser desfeita.</p>
      )}
    </Modal>
  );
}

/** "Só esta" ou "esta e as futuras" ao editar uma ocorrência de recorrência. */
export function EditScopeDialog({
  recurrenceChanged,
  onClose,
  onChoose,
}: {
  recurrenceChanged: boolean;
  onClose: () => void;
  onChoose: (scope: 'this' | 'future') => Promise<void>;
}) {
  const [saving, setSaving] = useState<'this' | 'future' | null>(null);
  const run = async (scope: 'this' | 'future') => {
    setSaving(scope);
    try {
      await onChoose(scope);
    } finally {
      setSaving(null);
    }
  };
  return (
    <Modal
      title="Aplicar a alteração a…"
      size="sm"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving !== null}>
            Cancelar
          </Button>
          <Button
            variant="secondary"
            onClick={() => void run('this')}
            disabled={recurrenceChanged || saving !== null}
            loading={saving === 'this'}
          >
            Só esta
          </Button>
          <Button variant="primary" onClick={() => void run('future')} loading={saving === 'future'} disabled={saving !== null}>
            Esta e as futuras
          </Button>
        </>
      }
    >
      <p className="text-[13px] text-ink-600 dark:text-ink-300">
        Esta conta faz parte de uma recorrência. As ocorrências anteriores e as já pagas não mudam.
      </p>
      {recurrenceChanged && (
        <p className="mt-2 text-[12px] text-amber-700 dark:text-amber-300">
          Você alterou a repetição; isso só pode valer para esta e as futuras.
        </p>
      )}
    </Modal>
  );
}

function paymentSource(payment: Bill['payments'][number]): string {
  if (payment.transactionId === null) return 'Sem lançamento';
  const parts = [payment.transactionDescription ?? 'Lançamento', payment.paymentMethodName].filter(Boolean);
  if (payment.origin === 'import_match') parts.push('importado');
  return parts.join(' · ');
}

/**
 * Pagamentos de uma conta, para desfazer um de cada vez. Desfazer o pagamento
 * que quitou a conta (o último) a reabre; os demais continuam registrados.
 */
export function PaymentsDialog({
  bill,
  onClose,
  onUndo,
  onUndoAll,
}: {
  bill: Bill;
  onClose: () => void;
  onUndo: (paymentId: number) => Promise<void>;
  onUndoAll: () => Promise<void>;
}) {
  const [busy, setBusy] = useState<number | 'all' | null>(null);
  const run = async (target: number | 'all', action: () => Promise<void>) => {
    setBusy(target);
    try {
      await action();
    } finally {
      setBusy(null);
    }
  };
  const total = bill.payments.reduce((sum, payment) => sum + payment.amountCents, 0);

  return (
    <Modal
      title="Pagamentos da conta"
      description={`${bill.description} · previsto ${formatBRL(bill.amountCents)} · pago ${formatBRL(total)}`}
      size="md"
      onClose={onClose}
      footer={
        <>
          <Button variant="danger-soft" onClick={() => void run('all', onUndoAll)} disabled={busy !== null} className="mr-auto">
            Desfazer todos
          </Button>
          <Button variant="secondary" onClick={onClose} disabled={busy !== null}>
            Fechar
          </Button>
        </>
      }
    >
      <ul className="divide-y divide-ink-100 rounded-lg border border-ink-200 text-[13px] dark:divide-ink-800 dark:border-ink-800">
        {bill.payments.map((payment) => (
          <li key={payment.id} className="flex items-center gap-3 px-3 py-2">
            <span className="w-[84px] shrink-0 tabular-nums text-ink-500 dark:text-ink-400">{formatDateBR(payment.paidAt)}</span>
            <span className="min-w-0 flex-1 truncate text-[12px] text-ink-500 dark:text-ink-400">{paymentSource(payment)}</span>
            <span className="shrink-0 font-medium tabular-nums">{formatBRL(payment.amountCents)}</span>
            <Button
              size="sm"
              variant="ghost"
              aria-label={`Desfazer pagamento de ${formatBRL(payment.amountCents)} em ${formatDateBR(payment.paidAt)}`}
              onClick={() => void run(payment.id, () => onUndo(payment.id))}
              loading={busy === payment.id}
              disabled={busy !== null && busy !== payment.id}
            >
              Desfazer
            </Button>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-[12px] text-ink-500 dark:text-ink-400">
        {bill.state === 'paid'
          ? 'Desfazer o último pagamento, o que quitou a conta, a reabre com os demais como parciais. Desfazer um anterior mantém a conta paga.'
          : 'A conta continua em aberto; o que falta é recalculado.'}{' '}
        Lançamentos criados pelo pagamento são apagados; os importados continuam em Movimentações.
      </p>
    </Modal>
  );
}
