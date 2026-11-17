import { useEffect, useMemo, useRef, useState } from 'react';
import { FileText, Repeat, ScanLine, X } from 'lucide-react';
import { Button } from '../ui/Button';
import { Field } from '../ui/Field';
import { Modal } from '../ui/Modal';
import { EditScopeDialog } from './SmallBillDialogs';
import { useToast } from '../../context/ToastContext';
import { api, errorMessage } from '../../lib/api';
import {
  FREQUENCY_LABELS,
  applyBoletoReading,
  billFormFrom,
  billInputFrom,
  emptyBillForm,
  futureEditPlan,
  templateInputFrom,
  validateBillForm,
  type BillForm,
  type BillFormErrors,
} from '../../lib/bills-view';
import { formatDateBR } from '../../lib/format';
import type { Bill, BillFrequency, BillTemplate, Lookup } from '../../lib/types';

export type BillFormTarget =
  | { kind: 'create' }
  | { kind: 'edit'; bill: Bill; template?: BillTemplate };

interface BillFormDialogProps {
  target: BillFormTarget;
  today: string;
  categories: Lookup[];
  paymentMethods: Lookup[];
  onClose: () => void;
  /** Chamado após gravar; a mensagem vai para o aviso. */
  onSaved: (message: string) => void;
}

const PREVIEW_DELAY_MS = 350;

function recurrenceDiffers(form: BillForm, initial: BillForm): boolean {
  return (
    form.frequency !== initial.frequency ||
    form.interval !== initial.interval ||
    (form.frequency === 'monthly' && form.lastBusinessDay) !== (initial.frequency === 'monthly' && initial.lastBusinessDay) ||
    form.endMode !== initial.endMode ||
    (form.endMode === 'date' && form.endDate !== initial.endDate) ||
    (form.endMode === 'count' && form.occurrenceCount !== initial.occurrenceCount)
  );
}

export function BillFormDialog({ target, today, categories, paymentMethods, onClose, onSaved }: BillFormDialogProps) {
  const { showToast } = useToast();
  const initial = useMemo(
    () =>
      target.kind === 'edit'
        ? billFormFrom(target.bill, target.template)
        : // Sem categoria pré-escolhida: a primeira da lista seria um palpite.
          emptyBillForm(today, null),
    [target, today],
  );
  const [form, setForm] = useState<BillForm>(initial);
  const [errors, setErrors] = useState<BillFormErrors>({});
  const [saving, setSaving] = useState(false);
  const [askScope, setAskScope] = useState(false);
  const [preview, setPreview] = useState<{ sequence: number; dueDate: string }[] | null>(null);
  const previewRequest = useRef(0);
  /** Boleto lido na criação: anexado e com a linha digitável gravada ao salvar uma conta avulsa. */
  const [boleto, setBoleto] = useState<{ file: File; barcode: string | null; notes: string[] } | null>(null);
  const [readingBoleto, setReadingBoleto] = useState(false);
  const boletoInput = useRef<HTMLInputElement>(null);

  const readBoleto = async (file: File) => {
    setReadingBoleto(true);
    try {
      const reading = await api.readBoleto(file);
      const applied = applyBoletoReading(form, reading, formatDateBR);
      setForm(applied.form);
      setBoleto({ file, barcode: reading.barcode?.digits ?? null, notes: applied.notes });
    } catch (error) {
      showToast(errorMessage(error), 'error');
    } finally {
      setReadingBoleto(false);
    }
  };

  const isOccurrence = target.kind === 'edit' && target.bill.templateId !== null;
  const showRecurrence = target.kind === 'create' ? form.repeat : isOccurrence;
  const set = <K extends keyof BillForm>(key: K, value: BillForm[K]) => setForm((current) => ({ ...current, [key]: value }));

  // Prévia das próximas datas, calculada pelo servidor com a mesma regra da gravação.
  useEffect(() => {
    if (!showRecurrence) {
      setPreview(null);
      return;
    }
    const candidate = { ...form, repeat: true };
    if (Object.keys(validateBillForm(candidate)).length > 0) {
      setPreview(null);
      return;
    }
    const requestId = ++previewRequest.current;
    const previewInput =
      target.kind === 'edit' && target.template
        ? futureEditPlan(candidate, target.bill, target.template).preview
        : templateInputFrom(candidate);
    const timer = window.setTimeout(() => {
      api
        .previewBillTemplate(previewInput)
        .then((result) => {
          if (requestId === previewRequest.current) setPreview(result.dates);
        })
        .catch(() => {
          if (requestId === previewRequest.current) setPreview(null);
        });
    }, PREVIEW_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [form, showRecurrence, target]);

  const persist = async (scope?: 'this' | 'future') => {
    setSaving(true);
    try {
      if (target.kind === 'create') {
        if (form.repeat) {
          const { template } = await api.createBillTemplate(templateInputFrom(form));
          onSaved(`Recorrência criada: ${template.recurrenceLabel}.`);
        } else {
          const { bill } = await api.createBill({ ...billInputFrom(form), barcode: boleto?.barcode ?? null });
          if (boleto) {
            try {
              await api.uploadBillAttachment(bill.id, boleto.file);
            } catch (error) {
              showToast(`Conta criada, mas o boleto não foi anexado: ${errorMessage(error)}`, 'error');
              onSaved('Conta criada.');
              return;
            }
          }
          onSaved(boleto ? 'Conta criada com o boleto anexado.' : 'Conta criada.');
        }
        return;
      }
      const { bill } = target;
      if (bill.templateId === null || scope === 'this') {
        await api.updateBill(bill.id, billInputFrom(form));
        onSaved(scope === 'this' ? 'Só esta ocorrência foi alterada.' : 'Conta atualizada.');
        return;
      }
      const template = target.template ?? (await api.getBillTemplate(bill.templateId)).template;
      const plan = futureEditPlan(form, bill, template);
      await api.updateBillTemplate(bill.templateId, plan.update, { scope: 'future', from: plan.from });
      onSaved(`Alteração aplicada a partir de ${formatDateBR(plan.from)}.`);
    } catch (error) {
      showToast(errorMessage(error), 'error');
    } finally {
      setSaving(false);
    }
  };

  const submit = () => {
    const candidate = showRecurrence ? { ...form, repeat: true } : form;
    const next = validateBillForm(candidate);
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    if (isOccurrence) {
      setAskScope(true);
      return;
    }
    void persist();
  };

  const title =
    target.kind === 'create' ? 'Nova conta a pagar' : isOccurrence ? 'Editar conta recorrente' : 'Editar conta a pagar';
  const frequency = FREQUENCY_LABELS[form.frequency];

  return (
    <>
      <Modal
        title={title}
        size="md"
        onClose={onClose}
        footer={
          <>
            <Button variant="secondary" onClick={onClose} disabled={saving}>
              Cancelar
            </Button>
            <Button variant="primary" onClick={submit} loading={saving && !askScope}>
              Salvar
            </Button>
          </>
        }
      >
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          {target.kind === 'create' && (
            <div className="rounded-xl border border-dashed border-ink-300 px-3 py-2.5 dark:border-ink-700">
              <input
                ref={boletoInput}
                type="file"
                accept="application/pdf"
                className="hidden"
                aria-label="Boleto em PDF"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = '';
                  if (file) void readBoleto(file);
                }}
              />
              {boleto ? (
                <div className="space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-1.5 text-[13px] font-medium text-ink-800 dark:text-ink-100">
                      <FileText className="h-4 w-4 shrink-0 text-emerald-600" aria-hidden="true" />
                      <span className="truncate">{boleto.file.name}</span>
                    </span>
                    <button type="button" className="icon-btn" aria-label="Tirar o boleto" onClick={() => setBoleto(null)}>
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                  <ul className="space-y-0.5 text-[11px] text-ink-500 dark:text-ink-400">
                    {boleto.notes.map((note) => (
                      <li key={note}>{note}</li>
                    ))}
                    <li>
                      {form.repeat
                        ? 'Numa recorrência o boleto não é anexado: anexe-o depois na ocorrência do mês.'
                        : 'Ao salvar, o PDF fica anexado à conta, com a linha digitável.'}
                    </li>
                  </ul>
                </div>
              ) : (
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-[12px] text-ink-500 dark:text-ink-400">
                    Tem o boleto em PDF? Ele preenche valor, vencimento, descrição e categoria.
                  </p>
                  <Button size="sm" variant="secondary" onClick={() => boletoInput.current?.click()} loading={readingBoleto}>
                    <ScanLine className="h-3.5 w-3.5" />
                    Preencher pelo boleto
                  </Button>
                </div>
              )}
            </div>
          )}

          <Field label="Descrição" htmlFor="bill-description" error={errors.description} required>
            <input
              id="bill-description"
              className="input"
              value={form.description}
              placeholder="Ex.: Condomínio"
              onChange={(e) => set('description', e.target.value)}
              autoFocus
            />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Valor (R$)" htmlFor="bill-amount" error={errors.amount} required>
              <input
                id="bill-amount"
                className="input text-right tabular-nums"
                inputMode="decimal"
                placeholder="0,00"
                value={form.amount}
                onChange={(e) => set('amount', e.target.value)}
              />
            </Field>
            <Field
              label={showRecurrence ? (isOccurrence ? 'Vencimento' : 'Primeiro vencimento') : 'Vencimento'}
              htmlFor="bill-due"
              error={errors.dueDate}
              required
            >
              <input id="bill-due" type="date" className="input" value={form.dueDate} onChange={(e) => set('dueDate', e.target.value)} />
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Categoria" htmlFor="bill-category" error={errors.categoryId} required>
              <select
                id="bill-category"
                className="select"
                value={form.categoryId ?? ''}
                onChange={(e) => set('categoryId', e.target.value ? Number(e.target.value) : null)}
              >
                <option value="">Selecione…</option>
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Conta padrão" htmlFor="bill-account" hint="Opcional. Liga o registro do lançamento ao pagar.">
              <select
                id="bill-account"
                className="select"
                value={form.paymentMethodId ?? ''}
                onChange={(e) => set('paymentMethodId', e.target.value ? Number(e.target.value) : null)}
              >
                <option value="">Nenhuma</option>
                {paymentMethods.map((method) => (
                  <option key={method.id} value={method.id}>
                    {method.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <Field label="Observações" htmlFor="bill-notes" error={errors.notes}>
            <input id="bill-notes" className="input" value={form.notes} onChange={(e) => set('notes', e.target.value)} />
          </Field>

          {target.kind === 'create' && (
            <label className="flex cursor-pointer items-center gap-2.5 text-[13px] font-medium text-ink-700 dark:text-ink-200">
              <input
                type="checkbox"
                className="h-4 w-4 accent-blue-600"
                checked={form.repeat}
                onChange={(e) => set('repeat', e.target.checked)}
              />
              <Repeat className="h-3.5 w-3.5 text-ink-400" aria-hidden="true" />
              Repetir
            </label>
          )}

          {showRecurrence && (
            <fieldset className="space-y-3 rounded-xl border border-ink-200 bg-ink-50/60 p-3 dark:border-ink-700 dark:bg-ink-950/30">
              <legend className="px-1 text-[11px] font-semibold uppercase tracking-wider text-ink-500 dark:text-ink-400">
                Repetição
              </legend>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Frequência" htmlFor="bill-frequency">
                  <select
                    id="bill-frequency"
                    className="select"
                    value={form.frequency}
                    onChange={(e) => set('frequency', e.target.value as BillFrequency)}
                  >
                    {(Object.keys(FREQUENCY_LABELS) as BillFrequency[]).map((key) => (
                      <option key={key} value={key}>
                        {FREQUENCY_LABELS[key].adjective}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field
                  label={`A cada (${Number(form.interval) === 1 ? frequency.singular : frequency.plural})`}
                  htmlFor="bill-interval"
                  error={errors.interval}
                >
                  <input
                    id="bill-interval"
                    className="input tabular-nums"
                    inputMode="numeric"
                    value={form.interval}
                    onChange={(e) => set('interval', e.target.value)}
                  />
                </Field>
              </div>
              {form.frequency === 'monthly' && (
                <label className="flex items-start gap-2 text-[13px] text-ink-700 dark:text-ink-200">
                  <input
                    type="checkbox"
                    className="mt-0.5 h-4 w-4 accent-blue-600"
                    checked={form.lastBusinessDay}
                    onChange={(e) => set('lastBusinessDay', e.target.checked)}
                  />
                  <span>
                    No último dia útil do mês
                    <span className="block text-[11px] text-ink-500 dark:text-ink-400">
                      Em vez do dia da primeira data. Fins de semana e feriados bancários nacionais ficam de fora.
                    </span>
                  </span>
                </label>
              )}

              <div role="radiogroup" aria-label="Término" className="space-y-2 text-[13px] text-ink-700 dark:text-ink-200">
                <p className="label mb-1">Termina</p>
                <label className="flex items-center gap-2">
                  <input type="radio" name="bill-end" className="accent-blue-600" checked={form.endMode === 'never'} onChange={() => set('endMode', 'never')} />
                  Sem data para terminar
                </label>
                <label className="flex flex-wrap items-center gap-2">
                  <input type="radio" name="bill-end" className="accent-blue-600" checked={form.endMode === 'date'} onChange={() => set('endMode', 'date')} />
                  Em
                  <input
                    type="date"
                    aria-label="Data final"
                    className="input h-8 w-auto"
                    value={form.endDate}
                    disabled={form.endMode !== 'date'}
                    onChange={(e) => set('endDate', e.target.value)}
                  />
                  {errors.endDate && <span className="text-[11px] text-rose-600 dark:text-rose-400">{errors.endDate}</span>}
                </label>
                <label className="flex flex-wrap items-center gap-2">
                  <input type="radio" name="bill-end" className="accent-blue-600" checked={form.endMode === 'count'} onChange={() => set('endMode', 'count')} />
                  Após
                  <input
                    aria-label="Quantidade de vezes"
                    className="input h-8 w-20 tabular-nums"
                    inputMode="numeric"
                    value={form.occurrenceCount}
                    disabled={form.endMode !== 'count'}
                    onChange={(e) => set('occurrenceCount', e.target.value)}
                  />
                  vezes
                  {errors.occurrenceCount && (
                    <span className="text-[11px] text-rose-600 dark:text-rose-400">{errors.occurrenceCount}</span>
                  )}
                </label>
              </div>

              <div className="text-[12px] text-ink-500 dark:text-ink-400" aria-live="polite">
                {preview && preview.length > 0 ? (
                  <>
                    <span className="font-medium text-ink-600 dark:text-ink-300">Próximas datas: </span>
                    {preview.map((item) => formatDateBR(item.dueDate).slice(0, 5)).join(' · ')}
                    {isOccurrence && ' (a partir desta conta, se aplicar a esta e às futuras)'}
                  </>
                ) : (
                  'Preencha valor, data e categoria para ver as próximas datas.'
                )}
              </div>
            </fieldset>
          )}
          <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
        </form>
      </Modal>

      {askScope && (
        <EditScopeDialog
          recurrenceChanged={recurrenceDiffers(form, initial)}
          onClose={() => setAskScope(false)}
          onChoose={async (scope) => {
            await persist(scope);
            setAskScope(false);
          }}
        />
      )}
    </>
  );
}
