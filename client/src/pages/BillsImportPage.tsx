import { useCallback, useRef, useState, type DragEvent } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, CheckCircle2, FileSpreadsheet, Repeat, UploadCloud, X } from 'lucide-react';
import { Button } from '../components/ui/Button';
import { PageHeader, Spinner } from '../components/ui/Page';
import { useBillsBadge } from '../context/BillsBadgeContext';
import { api, errorMessage } from '../lib/api';
import { BILL_IMPORT_FIELDS, BILL_STATUS_LABELS, importableRows } from '../lib/bills-import';
import { formatBRL, formatDateBR } from '../lib/format';
import type { BillImportField, BillImportMapping, BillImportPreview, BillImportSummary } from '../lib/types';

function plural(count: number, one: string, many: string) {
  return `${count} ${count === 1 ? one : many}`;
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'rose' | 'amber' | 'emerald' }) {
  const tones = {
    rose: 'text-rose-600 dark:text-rose-400',
    amber: 'text-amber-600 dark:text-amber-400',
    emerald: 'text-emerald-600 dark:text-emerald-400',
  };
  return (
    <div className="card px-4 py-3">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-500 dark:text-ink-400">{label}</p>
      <p className={`mt-1 text-lg font-semibold tabular-nums ${tone ? tones[tone] : 'text-ink-900 dark:text-white'}`}>{value}</p>
    </div>
  );
}

/**
 * Importação de contas a pagar por planilha (CSV/Excel): mapeamento das
 * colunas, prévia com erros, duplicadas e repetição, e gravação tudo ou nada.
 */
export function BillsImportPage() {
  const { refresh: refreshBadge } = useBillsBadge();
  const fileInput = useRef<HTMLInputElement>(null);
  const previewRequest = useRef(0);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<BillImportPreview | null>(null);
  const [mapping, setMapping] = useState<BillImportMapping>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rejected, setRejected] = useState<Set<number>>(() => new Set());
  const [skipDuplicates, setSkipDuplicates] = useState(true);
  const [importing, setImporting] = useState(false);
  const [summary, setSummary] = useState<BillImportSummary | null>(null);
  const [dragActive, setDragActive] = useState(false);

  const loadPreview = useCallback(async (selected: File, nextMapping?: BillImportMapping) => {
    const requestId = ++previewRequest.current;
    setLoading(true);
    setError(null);
    try {
      const result = await api.previewBillsImport(selected, nextMapping);
      if (requestId !== previewRequest.current) return;
      setPreview(result);
      setMapping(result.mapping);
    } catch (err) {
      if (requestId === previewRequest.current) setError(errorMessage(err));
    } finally {
      if (requestId === previewRequest.current) setLoading(false);
    }
  }, []);

  const selectFile = (selected: File) => {
    setFile(selected);
    setPreview(null);
    setSummary(null);
    setRejected(new Set());
    void loadPreview(selected);
  };

  const reset = () => {
    previewRequest.current += 1;
    setFile(null);
    setPreview(null);
    setMapping({});
    setRejected(new Set());
    setSummary(null);
    setError(null);
    setLoading(false);
    if (fileInput.current) fileInput.current.value = '';
  };

  const changeMapping = (field: BillImportField, value: string) => {
    if (!file) return;
    const next = { ...mapping, [field]: value === '' ? null : Number(value) };
    setMapping(next);
    void loadPreview(file, next);
  };

  const toggleRow = (rowNumber: number, include: boolean) =>
    setRejected((current) => {
      const next = new Set(current);
      if (include) next.delete(rowNumber);
      else next.add(rowNumber);
      return next;
    });

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragActive(false);
    const dropped = event.dataTransfer.files?.[0];
    if (dropped) selectFile(dropped);
  };

  const counts = importableRows(preview, rejected, skipDuplicates);
  const canImport = Boolean(file && preview && preview.mappingErrors.length === 0 && counts.total > 0 && !loading);

  const runImport = async () => {
    if (!file || !preview) return;
    setImporting(true);
    setError(null);
    try {
      const result = await api.importBills(file, { mapping, skipDuplicates, rejectedRows: [...rejected] });
      setSummary(result);
      await refreshBadge();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Importar contas a pagar"
        subtitle="Traga contas de uma planilha CSV ou Excel. Nada é gravado antes de você confirmar."
        actions={
          <Link to="/contas" className="btn-secondary">
            <ArrowLeft className="h-4 w-4" />
            Contas a pagar
          </Link>
        }
      />

      <input
        ref={fileInput}
        type="file"
        accept=".csv,.xls,.xlsx,.xlsm"
        className="hidden"
        aria-label="Arquivo da planilha"
        onChange={(event) => {
          const selected = event.target.files?.[0];
          if (selected) selectFile(selected);
        }}
      />

      {error && (
        <div role="alert" className="flex items-center gap-2 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-[13px] text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/30 dark:text-rose-300">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      {summary ? (
        <section className="card px-6 py-8 text-center" aria-labelledby="bills-import-done">
          <CheckCircle2 className="mx-auto h-10 w-10 text-emerald-500" aria-hidden="true" />
          <h2 id="bills-import-done" className="mt-3 text-base font-semibold text-ink-900 dark:text-white">
            {plural(summary.importedRows, 'conta importada', 'contas importadas')}
          </h2>
          <p className="mt-1 text-[13px] text-ink-500 dark:text-ink-400">
            {[
              summary.createdTemplates > 0 && plural(summary.createdTemplates, 'recorrência criada', 'recorrências criadas'),
              summary.skippedDuplicates > 0 && plural(summary.skippedDuplicates, 'duplicada pulada', 'duplicadas puladas'),
              summary.rejectedRows > 0 && plural(summary.rejectedRows, 'linha deixada de fora', 'linhas deixadas de fora'),
              summary.invalidRows > 0 && plural(summary.invalidRows, 'linha com erro', 'linhas com erro'),
            ]
              .filter(Boolean)
              .join(' · ') || summary.filename}
          </p>
          <div className="mt-5 flex justify-center gap-2">
            <Link to="/contas" className="btn-primary">
              Ver contas a pagar
            </Link>
            <Button variant="secondary" onClick={reset}>
              Importar outro arquivo
            </Button>
          </div>
        </section>
      ) : !file ? (
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
              ? 'border-emerald-400 bg-emerald-50/60 dark:border-emerald-500 dark:bg-emerald-950/20'
              : 'hover:border-emerald-300 hover:bg-ink-50/50 dark:hover:border-emerald-800 dark:hover:bg-ink-800/20'
          }`}
        >
          <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-50 text-emerald-600 dark:bg-emerald-950/50 dark:text-emerald-400">
            <UploadCloud className="h-6 w-6" />
          </div>
          <p className="text-[15px] font-semibold text-ink-900 dark:text-white">Arraste o arquivo aqui ou clique para selecionar</p>
          <p className="mt-1 text-[13px] text-ink-500 dark:text-ink-400">CSV, XLS ou XLSX · a planilha original não é alterada</p>
          <div className="mt-5 grid max-w-2xl gap-2 text-left text-[11px] text-ink-400 sm:grid-cols-2">
            {BILL_IMPORT_FIELDS.map((item) => (
              <p key={item.field} className="rounded-lg bg-ink-50 px-3 py-2 dark:bg-ink-800/50">
                <strong className="text-ink-600 dark:text-ink-300">
                  {item.label}
                  {item.required ? '*' : ''}:
                </strong>{' '}
                {item.hint}
              </p>
            ))}
          </div>
        </div>
      ) : (
        <>
          <section className="card px-4 py-3" aria-labelledby="bills-import-mapping">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h2 id="bills-import-mapping" className="flex min-w-0 items-center gap-2 text-sm font-semibold text-ink-900 dark:text-white">
                <FileSpreadsheet className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
                <span className="truncate">{file.name}</span>
                {preview && <span className="font-normal text-ink-400">· {preview.sheetName}</span>}
              </h2>
              <Button variant="ghost" size="sm" onClick={reset}>
                <X className="h-3.5 w-3.5" />
                Trocar arquivo
              </Button>
            </div>
            {preview && (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {BILL_IMPORT_FIELDS.map((item) => (
                  <label key={item.field} className="block">
                    <span className="label">
                      {item.label}
                      {item.required ? '*' : ''}
                    </span>
                    <select
                      className="select h-9 text-[13px]"
                      value={mapping[item.field] ?? ''}
                      onChange={(event) => changeMapping(item.field, event.target.value)}
                      aria-label={`Coluna de ${item.label}`}
                    >
                      <option value="">{item.required ? 'Selecione…' : 'Não usar'}</option>
                      {preview.headers.map((header, index) => (
                        <option key={index} value={index}>
                          {header || `Coluna ${index + 1}`}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
            )}
            {preview && (preview.mappingErrors.length > 0 || preview.mappingWarnings.length > 0) && (
              <ul className="mt-3 space-y-1 text-[12px]">
                {preview.mappingErrors.map((message) => (
                  <li key={message} className="text-rose-600 dark:text-rose-400">
                    {message}
                  </li>
                ))}
                {preview.mappingWarnings.map((message) => (
                  <li key={message} className="text-ink-500 dark:text-ink-400">
                    {message}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {loading && !preview ? (
            <Spinner />
          ) : (
            preview && (
              <>
                <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                  <Stat label="Linhas" value={preview.totalRows} />
                  <Stat label="Válidas" value={preview.validRows} tone="emerald" />
                  <Stat label="Com erro" value={preview.invalidRows} tone="rose" />
                  <Stat label="Duplicadas" value={preview.duplicateRows} tone="amber" />
                </div>

                <section className="card overflow-hidden" aria-label="Prévia das linhas">
                  <div className="table-shell">
                    <table className="w-full min-w-[860px] border-collapse">
                      <thead className="sticky top-0 z-10">
                        <tr>
                          <th className="th w-10">
                            <span className="sr-only">Importar</span>
                          </th>
                          <th className="th w-12">Linha</th>
                          <th className="th">Despesa</th>
                          <th className="th text-right">Valor</th>
                          <th className="th">Vencimento</th>
                          <th className="th">Categoria</th>
                          <th className="th">Situação</th>
                          <th className="th">Repetição</th>
                        </tr>
                      </thead>
                      <tbody>
                        {preview.rows.map((row) => {
                          const invalid = row.errors.length > 0;
                          const skipped = rejected.has(row.rowNumber) || (skipDuplicates && row.duplicate);
                          return (
                            <tr key={row.rowNumber} className={invalid ? 'bg-rose-50/50 dark:bg-rose-950/10' : skipped ? 'opacity-60' : ''}>
                              <td className="td align-top">
                                {!invalid && (
                                  <input
                                    type="checkbox"
                                    className="h-4 w-4 cursor-pointer rounded border-ink-300 accent-emerald-600"
                                    checked={!rejected.has(row.rowNumber)}
                                    onChange={(event) => toggleRow(row.rowNumber, event.target.checked)}
                                    aria-label={`Importar linha ${row.rowNumber}`}
                                  />
                                )}
                              </td>
                              <td className="td align-top tabular-nums text-ink-400">{row.rowNumber}</td>
                              <td className="td max-w-[280px] align-top">
                                <span className="block truncate font-medium text-ink-900 dark:text-white">{row.values.description || '—'}</span>
                                {row.duplicate && !invalid && (
                                  <span className="text-[11px] text-amber-700 dark:text-amber-300">
                                    Duplicada{skipDuplicates ? ' · será pulada' : ''}
                                  </span>
                                )}
                                {invalid && (
                                  <ul className="mt-0.5 space-y-0.5 text-[11px] text-rose-600 dark:text-rose-400">
                                    {row.errors.map((message) => (
                                      <li key={message}>{message}</li>
                                    ))}
                                  </ul>
                                )}
                              </td>
                              <td className="td whitespace-nowrap text-right align-top tabular-nums">
                                {row.values.amountCents !== null ? formatBRL(row.values.amountCents) : '—'}
                              </td>
                              <td className="td whitespace-nowrap align-top tabular-nums">
                                {row.values.dueDate ? formatDateBR(row.values.dueDate) : '—'}
                              </td>
                              <td className="td align-top text-[12px] text-ink-500 dark:text-ink-400">{row.values.category}</td>
                              <td className="td align-top text-[12px]">{BILL_STATUS_LABELS[row.values.status]}</td>
                              <td className="td align-top text-[12px]">
                                {row.values.recurrence ? (
                                  <span className="inline-flex items-center gap-1 text-blue-700 dark:text-blue-300">
                                    <Repeat className="h-3 w-3" aria-hidden="true" />
                                    {row.values.recurrence.label}
                                    {row.values.recurrence.occurrenceCount ? ` · ${row.values.recurrence.occurrenceCount}x` : ''}
                                  </span>
                                ) : (
                                  <span className="text-ink-400">Avulsa</span>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </section>

                <div className="card flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                  <label className="flex items-center gap-2 text-[13px] text-ink-700 dark:text-ink-200">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-emerald-600"
                      checked={skipDuplicates}
                      onChange={(event) => setSkipDuplicates(event.target.checked)}
                    />
                    Pular duplicadas (mesma descrição, valor, vencimento e categoria)
                  </label>
                  <div className="flex items-center gap-3">
                    <p className="text-[12px] text-ink-500 dark:text-ink-400">
                      {counts.recurring > 0 && `${plural(counts.recurring, 'vira recorrência', 'viram recorrência')} · `}
                      Linhas com erro ficam de fora
                    </p>
                    <Button variant="primary" onClick={() => void runImport()} disabled={!canImport} loading={importing}>
                      {counts.total === 0 ? 'Nada a importar' : `Importar ${plural(counts.total, 'conta', 'contas')}`}
                    </Button>
                  </div>
                </div>
              </>
            )
          )}
        </>
      )}
    </div>
  );
}
