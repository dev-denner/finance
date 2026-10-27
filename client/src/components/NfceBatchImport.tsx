import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ExternalLink, FileSpreadsheet, UploadCloud } from 'lucide-react';
import { ApiError, api } from '../lib/api';
import { formatBRL, formatFileSize } from '../lib/format';
import type {
  NfceBatchImportResult,
  NfceBatchInspection,
  NfceBatchPreview,
  NfceBatchRow,
  NfceBatchRowStatus,
} from '../lib/types';
import { Button } from './ui/Button';

type Busy = 'inspect' | 'preview' | 'import' | null;

interface StatusStyle {
  label: string;
  tone: string;
}

const ROW_STATUS: Record<NfceBatchRowStatus, StatusStyle> = {
  valid: {
    label: 'Pronta',
    tone: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300',
  },
  error: {
    label: 'Falha na consulta',
    tone: 'bg-rose-50 text-rose-700 dark:bg-rose-950/30 dark:text-rose-300',
  },
  invalid: {
    label: 'URL inválida',
    tone: 'bg-rose-50 text-rose-700 dark:bg-rose-950/30 dark:text-rose-300',
  },
  blank: {
    label: 'Vazia',
    tone: 'bg-ink-100 text-ink-500 dark:bg-ink-800 dark:text-ink-400',
  },
  'duplicate-file': {
    label: 'Duplicada no arquivo',
    tone: 'bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300',
  },
  'already-imported': {
    label: 'Já existe',
    tone: 'bg-sky-50 text-sky-700 dark:bg-sky-950/30 dark:text-sky-300',
  },
  'not-queried': {
    label: 'Não consultada',
    tone: 'bg-ink-100 text-ink-500 dark:bg-ink-800 dark:text-ink-400',
  },
};

const IMPORT_STATUS: Record<string, StatusStyle> = {
  imported: {
    label: 'Importada',
    tone: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300',
  },
  duplicate: {
    label: 'Já existia',
    tone: 'bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300',
  },
  error: {
    label: 'Erro',
    tone: 'bg-rose-50 text-rose-700 dark:bg-rose-950/30 dark:text-rose-300',
  },
  'not-queried': {
    label: 'Não consultada',
    tone: 'bg-ink-100 text-ink-500 dark:bg-ink-800 dark:text-ink-400',
  },
};

function errorText(error: unknown): string {
  return error instanceof ApiError ? error.message : 'Não foi possível concluir a operação.';
}

/** Linhas prontas e com falha podem ser importadas; a importação reconsulta as falhas. */
function isSelectable(row: NfceBatchRow): boolean {
  return row.status === 'valid' || row.status === 'error';
}

function StatusBadge({ status }: { status: StatusStyle }) {
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${status.tone}`}>
      {status.label}
    </span>
  );
}

export function NfceBatchImport() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [inspection, setInspection] = useState<NfceBatchInspection | null>(null);
  const [column, setColumn] = useState<number | null>(null);
  const [preview, setPreview] = useState<NfceBatchPreview | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [result, setResult] = useState<NfceBatchImportResult | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState('');
  const [dragActive, setDragActive] = useState(false);

  function reset() {
    setFile(null);
    setInspection(null);
    setColumn(null);
    setPreview(null);
    setSelected(new Set());
    setResult(null);
    setError('');
    setBusy(null);
    if (inputRef.current) inputRef.current.value = '';
  }

  async function inspectFile(chosen: File) {
    setFile(chosen);
    setInspection(null);
    setColumn(null);
    setPreview(null);
    setSelected(new Set());
    setResult(null);
    setError('');
    setBusy('inspect');
    try {
      const next = await api.inspectNfceBatch(chosen);
      setInspection(next.inspection);
      setColumn(next.inspection.suggestedColumn);
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(null);
    }
  }

  async function runPreview() {
    if (!file) return;
    setBusy('preview');
    setError('');
    setResult(null);
    try {
      const next = await api.previewNfceBatch(file, column);
      setPreview(next);
      setSelected(new Set(next.rows.filter((row) => row.status === 'valid').map((row) => row.line)));
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(null);
    }
  }

  async function runImport() {
    if (!file || selected.size === 0) return;
    setBusy('import');
    setError('');
    try {
      const next = await api.importNfceBatch(
        file,
        column,
        [...selected].sort((left, right) => left - right),
      );
      setResult(next);
      setSelected(new Set());
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(null);
    }
  }

  function toggleLine(line: number) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(line)) next.delete(line);
      else next.add(line);
      return next;
    });
  }

  function chooseColumn(value: string) {
    setColumn(value === '' ? null : Number(value));
    setPreview(null);
    setSelected(new Set());
    setResult(null);
  }

  const selectableLines = preview
    ? preview.rows.filter(isSelectable).map((row) => row.line)
    : [];
  const allSelected =
    selectableLines.length > 0 && selectableLines.every((line) => selected.has(line));

  return (
    <section className="card p-4" aria-labelledby="nfce-batch-title">
      <div className="mb-4">
        <h2 id="nfce-batch-title" className="text-base font-semibold">
          Importar várias NFC-e (CSV ou TXT)
        </h2>
        <p className="mt-1 text-sm text-ink-500">
          Uma URL de QR Code por linha ou em uma coluna do arquivo. Cada linha tem prévia
          individual e nenhuma movimentação financeira é criada ou alterada.
        </p>
      </div>

      <input
        ref={inputRef}
        type="file"
        accept=".csv,.txt,text/csv,text/plain"
        className="hidden"
        onChange={(event) => {
          const chosen = event.target.files?.[0];
          if (chosen) void inspectFile(chosen);
        }}
      />

      {error && (
        <p
          role="alert"
          className="mb-4 rounded-lg bg-rose-50 p-3 text-sm text-rose-700 dark:bg-rose-950/30 dark:text-rose-300"
        >
          {error}
        </p>
      )}

      {!file ? (
        <div
          role="button"
          tabIndex={0}
          onClick={() => inputRef.current?.click()}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') inputRef.current?.click();
          }}
          onDragOver={(event) => {
            event.preventDefault();
            setDragActive(true);
          }}
          onDragLeave={() => setDragActive(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragActive(false);
            const dropped = event.dataTransfer.files?.[0];
            if (dropped) void inspectFile(dropped);
          }}
          className={`flex cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed px-6 py-10 text-center transition ${
            dragActive
              ? 'border-blue-400 bg-blue-50/60 dark:border-blue-500 dark:bg-blue-950/20'
              : 'border-ink-200 hover:border-blue-300 hover:bg-ink-50/50 dark:border-ink-700 dark:hover:border-blue-800 dark:hover:bg-ink-800/20'
          }`}
        >
          <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-blue-50 text-blue-600 dark:bg-blue-950/50 dark:text-blue-400">
            <UploadCloud className="h-6 w-6" />
          </div>
          <p className="text-[15px] font-semibold text-ink-900 dark:text-white">
            Arraste o arquivo aqui ou clique para selecionar
          </p>
          <p className="mt-1 text-[13px] text-ink-500 dark:text-ink-400">
            CSV ou TXT · até 1 MB · 200 linhas · 50 consultas por lote
          </p>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3 rounded-xl border border-ink-200 px-4 py-3.5 dark:border-ink-700">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-emerald-50 text-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-400">
              <FileSpreadsheet className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-semibold text-ink-900 dark:text-white">
                {file.name}
              </p>
              {inspection ? (
                <p className="text-xs text-ink-500">
                  {inspection.dataLines} linha(s)
                  {inspection.blankLines > 0 ? ` · ${inspection.blankLines} vazia(s)` : ''}
                  {inspection.tooLongLines > 0
                    ? ` · ${inspection.tooLongLines} acima de ${inspection.limits.lineChars} caracteres`
                    : ''}{' '}
                  · {formatFileSize(file.size)}
                </p>
              ) : (
                <p className="text-xs text-ink-500">{formatFileSize(file.size)}</p>
              )}
            </div>
            <Button size="sm" loading={busy === 'inspect'} onClick={() => inputRef.current?.click()}>
              Trocar arquivo
            </Button>
            <Button size="sm" variant="ghost" onClick={reset}>
              Remover
            </Button>
          </div>

          {inspection && (
            <div className="mt-4 flex flex-wrap items-end gap-3">
              <label className="flex min-w-56 flex-col gap-1 text-xs font-medium text-ink-500">
                Coluna com as URLs
                <select
                  className="input"
                  value={column === null ? '' : String(column)}
                  onChange={(event) => chooseColumn(event.target.value)}
                >
                  <option value="">Selecione…</option>
                  {inspection.columns.map((info) => (
                    <option key={info.index} value={info.index}>
                      {info.label} · {info.validCount} URL(s) válida(s)
                    </option>
                  ))}
                </select>
              </label>
              <Button
                variant="primary"
                loading={busy === 'preview'}
                disabled={column === null}
                onClick={() => void runPreview()}
              >
                Conferir prévias
              </Button>
            </div>
          )}

          {inspection && (
            <p className="mt-2 text-xs text-ink-400">
              {inspection.headers
                ? `Cabeçalho detectado: ${inspection.headers.join(' · ')}`
                : 'Arquivo sem cabeçalho: uma URL por linha.'}
            </p>
          )}
        </>
      )}

      {preview && (
        <div className="mt-5">
          <div className="mb-3 flex flex-wrap gap-2 text-xs">
            <span className="rounded-full bg-emerald-50 px-2 py-0.5 font-medium text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300">
              {preview.summary.valid} pronta(s)
            </span>
            <span className="rounded-full bg-amber-50 px-2 py-0.5 font-medium text-amber-700 dark:bg-amber-950/30 dark:text-amber-300">
              {preview.summary.alreadyImported} já existente(s)
            </span>
            <span className="rounded-full bg-amber-50 px-2 py-0.5 font-medium text-amber-700 dark:bg-amber-950/30 dark:text-amber-300">
              {preview.summary.duplicateFile} duplicada(s) no arquivo
            </span>
            <span className="rounded-full bg-rose-50 px-2 py-0.5 font-medium text-rose-700 dark:bg-rose-950/30 dark:text-rose-300">
              {preview.summary.error} com falha
            </span>
            {preview.summary.notQueried > 0 && (
              <span className="rounded-full bg-ink-100 px-2 py-0.5 font-medium text-ink-500 dark:bg-ink-800 dark:text-ink-400">
                {preview.summary.notQueried} não consultada(s)
              </span>
            )}
            <span className="rounded-full bg-rose-50 px-2 py-0.5 font-medium text-rose-700 dark:bg-rose-950/30 dark:text-rose-300">
              {preview.summary.invalid} inválida(s)
            </span>
            <span className="rounded-full bg-ink-100 px-2 py-0.5 font-medium text-ink-500 dark:bg-ink-800 dark:text-ink-400">
              {preview.summary.blank} vazia(s)
            </span>
          </div>

          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <button
              type="button"
              className="text-xs font-medium text-blue-600 hover:text-blue-500 dark:text-blue-400"
              onClick={() => setSelected(allSelected ? new Set() : new Set(selectableLines))}
            >
              {allSelected ? 'Limpar seleção' : 'Selecionar prontas e falhas'}
            </button>
            <Button
              variant="primary"
              loading={busy === 'import'}
              disabled={selected.size === 0}
              onClick={() => void runImport()}
            >
              Importar {selected.size} selecionada(s)
            </Button>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-ink-500">
                <tr>
                  <th className="w-10 py-2">
                    <span className="sr-only">Seleção</span>
                  </th>
                  <th className="py-2">Linha</th>
                  <th className="py-2">Situação</th>
                  <th className="py-2">Fornecedor</th>
                  <th className="py-2">NFC-e</th>
                  <th className="py-2 text-right">Itens</th>
                  <th className="py-2 text-right">Desconto</th>
                  <th className="py-2 text-right">Total</th>
                  <th className="py-2">Observação</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((row) => (
                  <tr key={row.line} className="border-t border-ink-100 dark:border-ink-800">
                    <td className="py-2">
                      <input
                        type="checkbox"
                        aria-label={`Selecionar linha ${row.line}`}
                        checked={selected.has(row.line)}
                        disabled={!isSelectable(row)}
                        onChange={() => toggleLine(row.line)}
                      />
                    </td>
                    <td className="py-2 tabular-nums">{row.line}</td>
                    <td className="py-2">
                      <StatusBadge status={ROW_STATUS[row.status]} />
                      {row.state && <span className="ml-2 text-xs text-ink-500">SEFAZ-{row.state}</span>}
                    </td>
                    <td className="py-2">{row.supplierName ?? '—'}</td>
                    <td className="py-2">
                      {row.invoiceNumber
                        ? `Nº ${row.invoiceNumber} · Série ${row.series ?? '—'}`
                        : '—'}
                    </td>
                    <td className="py-2 text-right tabular-nums">{row.itemCount ?? '—'}</td>
                    <td className="py-2 text-right tabular-nums">
                      {row.invoiceDiscountCents === null ? '—' : formatBRL(row.invoiceDiscountCents)}
                    </td>
                    <td className="py-2 text-right tabular-nums">
                      {row.totalCents === null ? '—' : formatBRL(row.totalCents)}
                    </td>
                    <td className="py-2 text-xs text-ink-500">{row.message ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {result && (
        <div
          role="status"
          className="mt-5 rounded-xl border border-ink-200 p-4 dark:border-ink-700"
        >
          <h3 className="text-sm font-semibold">Resumo da importação</h3>
          <div className="mt-2 flex flex-wrap gap-2 text-xs">
            <span className="rounded-full bg-emerald-50 px-2 py-0.5 font-medium text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300">
              {result.summary.imported} importada(s)
            </span>
            <span className="rounded-full bg-amber-50 px-2 py-0.5 font-medium text-amber-700 dark:bg-amber-950/30 dark:text-amber-300">
              {result.summary.duplicate} já existente(s)
            </span>
            <span className="rounded-full bg-rose-50 px-2 py-0.5 font-medium text-rose-700 dark:bg-rose-950/30 dark:text-rose-300">
              {result.summary.error} com erro
            </span>
            {result.summary.notQueried > 0 && (
              <span className="rounded-full bg-ink-100 px-2 py-0.5 font-medium text-ink-500 dark:bg-ink-800 dark:text-ink-400">
                {result.summary.notQueried} não consultada(s)
              </span>
            )}
          </div>
          <p className="mt-2 text-xs text-ink-400">
            Nenhuma movimentação financeira foi criada ou alterada por esta importação.
          </p>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-ink-500">
                <tr>
                  <th className="py-2">Linha</th>
                  <th className="py-2">Resultado</th>
                  <th className="py-2">Detalhe</th>
                  <th className="py-2 text-right">Compra</th>
                </tr>
              </thead>
              <tbody>
                {result.rows.map((row) => (
                  <tr key={row.line} className="border-t border-ink-100 dark:border-ink-800">
                    <td className="py-2 tabular-nums">{row.line}</td>
                    <td className="py-2">
                      <StatusBadge status={IMPORT_STATUS[row.status]} />
                    </td>
                    <td className="py-2 text-xs text-ink-500">{row.message ?? '—'}</td>
                    <td className="py-2 text-right">
                      {row.purchaseId !== null ? (
                        <Link
                          to={`/compras/${row.purchaseId}`}
                          className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-500 dark:text-blue-400"
                        >
                          Abrir compra
                          <ExternalLink className="h-3 w-3" />
                        </Link>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-3">
            <Button size="sm" onClick={reset}>
              Importar outro arquivo
            </Button>
          </div>
        </div>
      )}

      {!file && (
        <p className="mt-3 text-xs text-ink-400">
          Linhas vazias, URLs inválidas e notas repetidas aparecem na prévia e nunca são
          descartadas em silêncio.
        </p>
      )}
    </section>
  );
}
