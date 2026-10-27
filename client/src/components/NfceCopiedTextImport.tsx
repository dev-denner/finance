import { useRef, useState } from 'react';
import { Check, ClipboardPaste, ExternalLink, UploadCloud } from 'lucide-react';
import { ApiError, api } from '../lib/api';
import { formatBRL, formatDateTimeBR } from '../lib/format';
import type { CopiedNfceImportResult, CopiedNfcePreview, CopiedNfcePreviewRow } from '../lib/types';
import { Button } from './ui/Button';

type Busy = 'preview' | 'import' | null;

const MAX_TEXT_BYTES = 1024 * 1024;

function errorText(error: unknown): string {
  return error instanceof ApiError ? error.message : 'Não foi possível processar o texto copiado.';
}

function statusLabel(row: CopiedNfcePreviewRow): string {
  if (row.status === 'ready') return 'Pronta';
  if (row.status === 'duplicate-file') return 'Repetida no texto';
  if (row.status === 'already-imported') return 'Já importada';
  return 'Precisa conferir';
}

function statusClass(status: CopiedNfcePreviewRow['status']): string {
  if (status === 'ready') return 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300';
  if (status === 'already-imported') return 'bg-sky-50 text-sky-700 dark:bg-sky-950/30 dark:text-sky-300';
  if (status === 'duplicate-file') return 'bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300';
  return 'bg-rose-50 text-rose-700 dark:bg-rose-950/30 dark:text-rose-300';
}

export function NfceCopiedTextImport() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<CopiedNfcePreview | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [result, setResult] = useState<CopiedNfceImportResult | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState('');

  function changeText(value: string) {
    setText(value);
    setPreview(null);
    setSelected(new Set());
    setResult(null);
    setError('');
  }

  async function loadTextFile(file: File | undefined) {
    if (!file) return;
    if (file.size > MAX_TEXT_BYTES) {
      setError('O arquivo de texto deve ter no máximo 1 MB.');
      return;
    }
    try {
      changeText(await file.text());
    } catch {
      setError('Não foi possível ler o arquivo de texto.');
    }
  }

  async function runPreview() {
    if (!text.trim()) {
      setError('Cole o texto copiado ou carregue um arquivo TXT.');
      return;
    }
    if (new TextEncoder().encode(text).length > MAX_TEXT_BYTES) {
      setError('O texto deve ter no máximo 1 MB.');
      return;
    }
    setBusy('preview');
    setError('');
    setResult(null);
    try {
      const next = await api.previewCopiedNfceText(text);
      setPreview(next);
      setSelected(new Set(next.rows.filter((row) => row.status === 'ready').map((row) => row.block)));
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(null);
    }
  }

  async function runImport() {
    if (!preview || selected.size === 0) return;
    setBusy('import');
    setError('');
    try {
      const next = await api.importCopiedNfceText(text, [...selected].sort((a, b) => a - b));
      setResult(next);
      setSelected(new Set());
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(null);
    }
  }

  function toggleBlock(block: number) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(block)) next.delete(block);
      else next.add(block);
      return next;
    });
  }

  const readyBlocks = preview?.rows.filter((row) => row.status === 'ready').map((row) => row.block) ?? [];
  const allReadySelected = readyBlocks.length > 0 && readyBlocks.every((block) => selected.has(block));

  return (
    <section className="card mb-5 p-4" aria-labelledby="nfce-copied-text-title">
      <div className="mb-3">
        <h2 id="nfce-copied-text-title" className="text-base font-semibold">
          Importar notas copiadas
        </h2>
        <p className="mt-1 text-sm text-ink-500">
          Cole o texto de uma ou mais páginas de NFC-e. Separe as notas com uma linha de três ou mais hífens.
          A leitura é local; nenhuma consulta ao portal é feita.
        </p>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-3">
        <Button type="button" variant="secondary" onClick={() => inputRef.current?.click()}>
          <UploadCloud className="h-4 w-4" />
          Carregar arquivo TXT
        </Button>
        <span className="text-xs text-ink-500">Até 1 MB · máximo 50 notas por envio</span>
        <input
          ref={inputRef}
          type="file"
          accept=".txt,text/plain"
          className="hidden"
          aria-label="Carregar arquivo de texto"
          onChange={(event) => void loadTextFile(event.target.files?.[0])}
        />
      </div>

      <label className="sr-only" htmlFor="nfce-copied-text">Texto copiado das notas fiscais</label>
      <textarea
        id="nfce-copied-text"
        value={text}
        onChange={(event) => changeText(event.target.value)}
        rows={8}
        maxLength={MAX_TEXT_BYTES}
        placeholder={'Cole aqui o conteúdo copiado de uma ou mais consultas NFC-e.\n\n--------------------------------'}
        className="input mb-3 min-h-40 w-full resize-y font-mono text-xs"
      />
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="primary" loading={busy === 'preview'} disabled={busy !== null} onClick={() => void runPreview()}>
          <ClipboardPaste className="h-4 w-4" />
          Conferir notas copiadas
        </Button>
        {text && (
          <Button type="button" variant="secondary" disabled={busy !== null} onClick={() => changeText('')}>
            Limpar
          </Button>
        )}
        <span className="text-xs text-ink-500">O CPF do consumidor e outros dados do rodapé não são importados.</span>
      </div>

      {error && <p role="alert" className="mt-3 rounded-lg bg-rose-50 p-3 text-sm text-rose-700 dark:bg-rose-950/30 dark:text-rose-300">{error}</p>}

      {preview && (
        <div className="mt-5">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-ink-500">
              {preview.summary.ready} pronta(s) · {preview.summary.alreadyImported} já importada(s) · {preview.summary.duplicateFile} repetida(s) · {preview.summary.invalid} para conferir
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                className="text-sm text-blue-600 hover:underline dark:text-blue-400"
                onClick={() => setSelected(allReadySelected ? new Set() : new Set(readyBlocks))}
              >
                {allReadySelected ? 'Desmarcar prontas' : 'Selecionar prontas'}
              </button>
              <Button type="button" variant="primary" loading={busy === 'import'} disabled={busy !== null || selected.size === 0} onClick={() => void runImport()}>
                <Check className="h-4 w-4" />
                Importar {selected.size} nota(s)
              </Button>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead className="text-xs text-ink-500">
                <tr>
                  <th className="w-10 py-2">Sel.</th>
                  <th className="py-2">Bloco</th>
                  <th className="py-2">Situação</th>
                  <th className="py-2">Fornecedor / NFC-e</th>
                  <th className="py-2">UF</th>
                  <th className="py-2 text-right">Itens</th>
                  <th className="py-2 text-right">Total</th>
                  <th className="py-2">Observação</th>
                  <th className="py-2">Detalhes</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((row) => {
                  const purchase = row.purchase;
                  const canSelect = row.status === 'ready';
                  return (
                    <tr key={row.block} className="border-t border-ink-100 align-top dark:border-ink-800">
                      <td className="py-2">
                        <input
                          type="checkbox"
                          aria-label={'Selecionar bloco ' + row.block}
                          checked={selected.has(row.block)}
                          disabled={!canSelect || busy !== null}
                          onChange={() => toggleBlock(row.block)}
                        />
                      </td>
                      <td className="py-2">{row.block}</td>
                      <td className="py-2"><span className={'inline-flex rounded-full px-2 py-0.5 text-xs font-medium ' + statusClass(row.status)}>{statusLabel(row)}</span></td>
                      <td className="py-2">
                        {purchase ? (
                          <>
                            <div className="font-medium">{purchase.supplierName}</div>
                            <div className="text-xs text-ink-500">NFC-e {purchase.invoiceNumber} · {formatDateTimeBR(purchase.issuedAt)}</div>
                          </>
                        ) : row.purchaseId !== null ? (
                          <a href={'/compras/' + row.purchaseId} className="inline-flex items-center gap-1 text-blue-600 hover:underline dark:text-blue-400">
                            Abrir compra <ExternalLink className="h-3 w-3" />
                          </a>
                        ) : '—'}
                      </td>
                      <td className="py-2">{row.state ?? '—'}</td>
                      <td className="py-2 text-right">{purchase?.items?.length ?? '—'}</td>
                      <td className="py-2 text-right">{purchase ? formatBRL(purchase.totalCents) : '—'}</td>
                      <td className="py-2 text-xs text-ink-500">{row.message ?? '—'}</td>
                      <td className="py-2">
                        {purchase?.items && (
                          <details>
                            <summary className="cursor-pointer text-xs text-blue-600 hover:underline dark:text-blue-400">Ver itens</summary>
                            <div className="max-h-72 overflow-auto">
                              {purchase.items.map((item, itemIndex) => (
                                <div key={itemIndex} className="border-t border-ink-100 py-1 dark:border-ink-800">
                                  <div>{item.description}</div>
                                  <div className="text-xs text-ink-500">{item.quantity} {item.unit} × {formatBRL(item.unitPriceCents)} = {formatBRL(item.totalCents)}</div>
                                </div>
                              ))}
                            </div>
                          </details>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {result && (
        <div role="status" className="mt-4 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-200">
          Importadas: {result.summary.imported} · Já existentes: {result.summary.duplicate} · Erros: {result.summary.error}
          <ul className="mt-2 space-y-1">
            {result.rows.map((row) => (
              <li key={row.block}>
                Bloco {row.block}: {row.message ?? (row.status === 'imported' ? 'Importada.' : 'Já existia.')}
                {row.purchaseId !== null && <a href={'/compras/' + row.purchaseId} className="ml-2 underline">Abrir compra</a>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
