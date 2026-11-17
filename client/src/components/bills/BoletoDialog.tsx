import { useEffect, useRef, useState } from 'react';
import { Copy, ExternalLink, FileText, Image as ImageIcon, Paperclip, Trash2 } from 'lucide-react';
import { Button } from '../ui/Button';
import { Field } from '../ui/Field';
import { Modal } from '../ui/Modal';
import { api, errorMessage } from '../../lib/api';
import { formatBRL, formatDateBR } from '../../lib/format';
import type { BarcodeParseResult, Bill } from '../../lib/types';

const PARSE_DELAY_MS = 300;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`;
}

/**
 * Linha digitável e anexos de uma conta. Vale só para esta ocorrência: numa
 * recorrência, cada mês tem o seu boleto.
 */
export function BoletoDialog({
  bill,
  onClose,
  onChanged,
  notify,
}: {
  bill: Bill;
  onClose: () => void;
  /** Recarrega a tela; devolve a conta atualizada para o diálogo continuar aberto. */
  onChanged: () => Promise<Bill | null>;
  notify: (message: string, kind: 'success' | 'error') => void;
}) {
  const [current, setCurrent] = useState(bill);
  const [barcode, setBarcode] = useState(bill.barcodeFormatted ?? '');
  const [check, setCheck] = useState<BarcodeParseResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const parseRequest = useRef(0);

  // Confere a linha digitável enquanto se digita (pelo servidor, que também valida ao gravar).
  useEffect(() => {
    // Toda mudança invalida o resultado anterior e as consultas em andamento.
    const requestId = ++parseRequest.current;
    setCheck(null);
    if (barcode.replace(/\D/g, '').length === 0) return;
    const timer = window.setTimeout(() => {
      api
        .parseBarcode(barcode)
        .then((result) => {
          if (requestId === parseRequest.current) setCheck(result);
        })
        .catch(() => {
          if (requestId === parseRequest.current) setCheck(null);
        });
    }, PARSE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [barcode]);

  const run = async (key: string, action: () => Promise<unknown>, message: string) => {
    setBusy(key);
    try {
      await action();
      const updated = await onChanged();
      if (updated) {
        setCurrent(updated);
        setBarcode(updated.barcodeFormatted ?? '');
      }
      notify(message, 'success');
    } catch (err) {
      notify(errorMessage(err), 'error');
    } finally {
      setBusy(null);
    }
  };

  const digits = barcode.replace(/\D/g, '');
  const changed = digits !== (current.barcode ?? '');
  // Só vale o resultado da consulta feita para o código que está no campo.
  const valid = check?.valid === true && check.digits === digits ? check : null;
  const suggestion =
    valid &&
    ((valid.amountCents !== null && valid.amountCents !== current.amountCents) ||
      (valid.dueDate !== null && valid.dueDate !== current.dueDate))
      ? valid
      : null;

  const copy = async () => {
    if (!current.barcode) return;
    try {
      await navigator.clipboard.writeText(current.barcode);
      notify('Linha digitável copiada.', 'success');
    } catch {
      notify('Não foi possível copiar; selecione a linha e copie manualmente.', 'error');
    }
  };

  return (
    <Modal
      title="Boleto e anexos"
      description={`${current.description} · vence ${formatDateBR(current.dueDate)} · ${formatBRL(current.amountCents)}`}
      size="md"
      onClose={onClose}
      footer={
        <Button variant="secondary" onClick={onClose} disabled={busy !== null}>
          Fechar
        </Button>
      }
    >
      <div className="space-y-5">
        <section className="space-y-2" aria-labelledby="boleto-barcode-title">
          <h3 id="boleto-barcode-title" className="label">
            Linha digitável
          </h3>
          <Field
            label="Código"
            htmlFor="boleto-barcode"
            hint="Boleto (47 dígitos) ou conta de consumo/tributo (48). Pontos e espaços são ignorados."
            error={check?.valid === false && digits.length > 0 ? check.error : undefined}
          >
            <input
              id="boleto-barcode"
              className="input font-mono text-[12px]"
              inputMode="numeric"
              autoComplete="off"
              value={barcode}
              onChange={(e) => setBarcode(e.target.value)}
            />
          </Field>
          {valid && (
            <p className="text-[12px] text-emerald-700 dark:text-emerald-300">
              {valid.kind === 'bank' ? 'Boleto bancário' : 'Conta de consumo ou tributo'} válido
              {valid.amountCents !== null && ` · ${formatBRL(valid.amountCents)}`}
              {valid.dueDate !== null && ` · vence ${formatDateBR(valid.dueDate)}`}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="primary"
              disabled={!changed || (digits.length > 0 && !valid) || busy !== null}
              loading={busy === 'barcode'}
              onClick={() =>
                void run('barcode', () => api.updateBill(current.id, { barcode: digits || null }), digits ? 'Linha digitável salva.' : 'Linha digitável removida.')
              }
            >
              {digits ? 'Salvar linha' : 'Remover linha'}
            </Button>
            {current.barcode && !changed && (
              <Button size="sm" variant="secondary" onClick={() => void copy()}>
                <Copy className="h-3.5 w-3.5" />
                Copiar
              </Button>
            )}
            {suggestion && (
              <Button
                size="sm"
                variant="secondary"
                disabled={busy !== null}
                loading={busy === 'apply'}
                onClick={() =>
                  void run(
                    'apply',
                    () =>
                      api.updateBill(current.id, {
                        barcode: suggestion.digits,
                        ...(suggestion.amountCents !== null ? { amountCents: suggestion.amountCents } : {}),
                        ...(suggestion.dueDate !== null ? { dueDate: suggestion.dueDate } : {}),
                      }),
                    'Conta atualizada com o valor e o vencimento do boleto.',
                  )
                }
              >
                Usar {[suggestion.amountCents !== null && formatBRL(suggestion.amountCents), suggestion.dueDate !== null && `vencimento ${formatDateBR(suggestion.dueDate)}`]
                  .filter(Boolean)
                  .join(' e ')}
              </Button>
            )}
          </div>
        </section>

        <section className="space-y-2" aria-labelledby="boleto-attachments-title">
          <div className="flex items-center justify-between gap-2">
            <h3 id="boleto-attachments-title" className="label">
              Anexos
            </h3>
            <Button size="sm" variant="secondary" onClick={() => fileInput.current?.click()} loading={busy === 'upload'} disabled={busy !== null}>
              <Paperclip className="h-3.5 w-3.5" />
              Anexar arquivo
            </Button>
            <input
              ref={fileInput}
              type="file"
              accept="application/pdf,image/png,image/jpeg"
              className="hidden"
              aria-label="Arquivo do anexo"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file) void run('upload', () => api.uploadBillAttachment(current.id, file), 'Anexo adicionado.');
              }}
            />
          </div>
          {current.attachments.length === 0 ? (
            <p className="text-[12px] text-ink-500 dark:text-ink-400">Nenhum anexo. Envie o boleto em PDF ou uma foto (PNG/JPEG), até 10 MB.</p>
          ) : (
            <ul className="divide-y divide-ink-100 rounded-lg border border-ink-200 text-[13px] dark:divide-ink-800 dark:border-ink-800">
              {current.attachments.map((attachment) => {
                const Icon = attachment.contentType === 'application/pdf' ? FileText : ImageIcon;
                return (
                  <li key={attachment.id} className="flex items-center gap-2 px-3 py-2">
                    <Icon className="h-4 w-4 shrink-0 text-ink-400" aria-hidden="true" />
                    <a
                      href={api.billAttachmentUrl(current.id, attachment.id)}
                      target="_blank"
                      rel="noreferrer"
                      className="min-w-0 flex-1 truncate font-medium text-blue-700 hover:underline dark:text-blue-300"
                    >
                      {attachment.filename}
                      <ExternalLink className="ml-1 inline h-3 w-3" aria-hidden="true" />
                    </a>
                    <span className="shrink-0 text-[11px] tabular-nums text-ink-400">{formatSize(attachment.sizeBytes)}</span>
                    <button
                      type="button"
                      className="icon-btn hover:text-rose-600"
                      aria-label={`Excluir anexo ${attachment.filename}`}
                      disabled={busy !== null}
                      onClick={() =>
                        void run(`delete-${attachment.id}`, () => api.deleteBillAttachment(current.id, attachment.id), 'Anexo excluído.')
                      }
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </Modal>
  );
}
