import { useState } from 'react';
import { Button } from '../ui/Button';
import { Field } from '../ui/Field';
import { Modal } from '../ui/Modal';
import { formatBRL, formatDateBR } from '../../lib/format';
import { remainingCents, type BulkSelection } from '../../lib/bills-view';

/** Lista curta das contas afetadas; o resto vira "e mais N". */
const LISTED = 6;

/**
 * Confirmação das ações em massa. Pagar marca cada conta como paga pelo valor
 * que falta, sem lançamento; pular tira as contas do mês.
 */
export function BulkBillsDialog({
  action,
  selection,
  today,
  onClose,
  onConfirm,
}: {
  action: 'pay' | 'skip';
  selection: BulkSelection;
  today: string;
  onClose: () => void;
  onConfirm: (paidAt: string) => Promise<void>;
}) {
  const [paidAt, setPaidAt] = useState(today);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const count = selection.bills.length;
  const blocked = action === 'skip' && selection.partial.length > 0;

  const confirm = async () => {
    if (action === 'pay' && !/^\d{4}-\d{2}-\d{2}$/.test(paidAt)) {
      setError('Informe a data do pagamento.');
      return;
    }
    setSaving(true);
    try {
      await onConfirm(paidAt);
    } finally {
      setSaving(false);
    }
  };

  const noun = count === 1 ? 'conta' : 'contas';
  return (
    <Modal
      title={action === 'pay' ? `Marcar ${count} ${noun} como pagas` : `Pular ${count} ${noun}`}
      description={action === 'pay' ? `Total: ${formatBRL(selection.remainingCents)}` : undefined}
      size="sm"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancelar
          </Button>
          <Button variant="primary" onClick={() => void confirm()} loading={saving} disabled={blocked}>
            {action === 'pay' ? 'Marcar como pagas' : 'Pular'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <ul className="divide-y divide-ink-100 rounded-lg border border-ink-200 text-[13px] dark:divide-ink-800 dark:border-ink-800">
          {selection.bills.slice(0, LISTED).map((bill) => (
            <li key={bill.id} className="flex items-center justify-between gap-3 px-3 py-1.5">
              <span className="min-w-0 truncate">
                {bill.description}
                <span className="ml-1.5 text-[11px] text-ink-400">{formatDateBR(bill.dueDate)}</span>
              </span>
              <span className="shrink-0 tabular-nums">{formatBRL(remainingCents(bill))}</span>
            </li>
          ))}
          {count > LISTED && (
            <li className="px-3 py-1.5 text-[12px] text-ink-500 dark:text-ink-400">e mais {count - LISTED}</li>
          )}
        </ul>
        {action === 'pay' ? (
          <Field
            label="Pagas em"
            htmlFor="bulk-paid-at"
            hint="Cada conta é quitada pelo valor que falta, sem criar lançamento. Para registrar o lançamento, pague uma a uma."
            error={error ?? undefined}
          >
            <input id="bulk-paid-at" type="date" className="input" value={paidAt} onChange={(e) => setPaidAt(e.target.value)} />
          </Field>
        ) : blocked ? (
          <p role="alert" className="text-[12px] text-amber-700 dark:text-amber-300">
            {selection.partial.map((bill) => bill.description).join(', ')}{' '}
            {selection.partial.length === 1 ? 'tem' : 'têm'} pagamento parcial e não pode ser pulada. Tire da seleção ou
            desfaça os pagamentos antes.
          </p>
        ) : (
          <p className="text-[13px] text-ink-600 dark:text-ink-300">
            As contas saem do que está em aberto. Dá para reabrir cada uma depois.
          </p>
        )}
      </div>
    </Modal>
  );
}
