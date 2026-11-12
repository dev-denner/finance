import { useState } from 'react';
import { Button } from '../ui/Button';
import { Field } from '../ui/Field';
import { Modal } from '../ui/Modal';
import { centsToInput, parseCentsInput } from '../../lib/bills-view';
import { formatBRL, formatDateBR } from '../../lib/format';
import type { Bill, Lookup, PayBillInput } from '../../lib/types';

interface PayDialogProps {
  bill: Bill;
  today: string;
  paymentMethods: Lookup[];
  onClose: () => void;
  onConfirm: (input: PayBillInput) => Promise<void>;
}

/**
 * Pagar uma conta. Por padrão só marca como paga (o Módulo 1 é uma agenda);
 * "Registrar lançamento" cria a saída em Movimentações. O toggle já vem ligado
 * quando a conta tem conta padrão (ex.: fatura de cartão debitada sempre na
 * mesma conta corrente).
 */
export function PayDialog({ bill, today, paymentMethods, onClose, onConfirm }: PayDialogProps) {
  const [paidAt, setPaidAt] = useState(today);
  const [amount, setAmount] = useState(centsToInput(bill.amountCents));
  const [registerTransaction, setRegisterTransaction] = useState(bill.paymentMethodId !== null);
  const [paymentMethodId, setPaymentMethodId] = useState<number | null>(
    bill.paymentMethodId ?? paymentMethods[0]?.id ?? null,
  );
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<{ paidAt?: string; amount?: string; account?: string }>({});

  const submit = async () => {
    const paidCents = parseCentsInput(amount);
    const next: typeof errors = {};
    if (!/^\d{4}-\d{2}-\d{2}$/.test(paidAt)) next.paidAt = 'Informe a data do pagamento.';
    if (paidCents === null) next.amount = 'Informe um valor positivo, como 1.234,56.';
    if (registerTransaction && paymentMethodId === null) next.account = 'Selecione a conta de onde saiu o dinheiro.';
    setErrors(next);
    if (Object.keys(next).length > 0 || paidCents === null) return;

    setSaving(true);
    try {
      await onConfirm(
        registerTransaction && paymentMethodId !== null
          ? { mode: 'transaction', paidAt, paidCents, paymentMethodId }
          : { mode: 'external', paidAt, paidCents },
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title="Pagar conta"
      description={
        <>
          {bill.description} · vence {formatDateBR(bill.dueDate)} · {formatBRL(bill.amountCents)}
        </>
      }
      size="sm"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancelar
          </Button>
          <Button variant="primary" onClick={() => void submit()} loading={saving}>
            Confirmar pagamento
          </Button>
        </>
      }
    >
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label="Pago em" htmlFor="pay-date" error={errors.paidAt} required>
            <input id="pay-date" type="date" className="input" value={paidAt} onChange={(e) => setPaidAt(e.target.value)} />
          </Field>
          <Field label="Valor pago (R$)" htmlFor="pay-amount" error={errors.amount} required>
            <input
              id="pay-amount"
              className="input text-right tabular-nums"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </Field>
        </div>

        <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-ink-200 px-3 py-2.5 text-[13px] dark:border-ink-700">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 accent-blue-600"
            checked={registerTransaction}
            onChange={(e) => setRegisterTransaction(e.target.checked)}
          />
          <span>
            <span className="font-medium text-ink-800 dark:text-ink-100">Registrar lançamento em Movimentações</span>
            <span className="mt-0.5 block text-[12px] text-ink-500 dark:text-ink-400">
              Cria a saída na conta escolhida. Desligado, a conta só fica marcada como paga.
            </span>
          </span>
        </label>

        {registerTransaction && (
          <Field label="Conta de saída" htmlFor="pay-account" error={errors.account} required>
            <select
              id="pay-account"
              className="select"
              value={paymentMethodId ?? ''}
              onChange={(e) => setPaymentMethodId(e.target.value ? Number(e.target.value) : null)}
            >
              <option value="">Selecione…</option>
              {paymentMethods.map((method) => (
                <option key={method.id} value={method.id}>
                  {method.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
      </form>
    </Modal>
  );
}
