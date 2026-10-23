import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowRight,
  FileSpreadsheet,
  History,
  Loader2,
  RefreshCw,
  ShoppingCart,
  UploadCloud,
} from 'lucide-react';
import { Button } from '../components/ui/Button';
import { EmptyState, PageHeader } from '../components/ui/Page';
import { api, errorMessage } from '../lib/api';
import { formatDateTimeBR } from '../lib/format';
import {
  buildImportHistory,
  type ImportHistoryEntry,
  type ImportHistoryStatus,
} from '../lib/import-history';
import type { ImportBatch, Purchase } from '../lib/types';

const STATUS_STYLES: Record<ImportHistoryStatus, string> = {
  success:
    'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300',
  partial: 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300',
  warning: 'bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300',
};

async function settle<T>(
  promise: Promise<T>,
): Promise<{ data: T | null; error: unknown }> {
  try {
    return { data: await promise, error: null };
  } catch (error) {
    return { data: null, error };
  }
}

function FlowCard({
  icon: Icon,
  title,
  description,
  details,
  primaryLabel,
  primaryTo,
  secondaryLabel,
  secondaryTo,
  tone,
}: {
  icon: typeof FileSpreadsheet;
  title: string;
  description: string;
  details: string[];
  primaryLabel: string;
  primaryTo: string;
  secondaryLabel: string;
  secondaryTo: string;
  tone: 'blue' | 'violet';
}) {
  const iconStyle =
    tone === 'blue'
      ? 'bg-blue-50 text-blue-600 dark:bg-blue-950/50 dark:text-blue-400'
      : 'bg-violet-50 text-violet-600 dark:bg-violet-950/50 dark:text-violet-400';

  return (
    <article className="card flex flex-col p-5">
      <div className={`mb-4 flex h-11 w-11 items-center justify-center rounded-xl ${iconStyle}`}>
        <Icon className="h-5 w-5" />
      </div>
      <h2 className="text-base font-semibold text-ink-900 dark:text-white">{title}</h2>
      <p className="mt-1 text-[13px] leading-relaxed text-ink-500 dark:text-ink-400">
        {description}
      </p>
      <ul className="mt-3 space-y-1 text-[12px] text-ink-500 dark:text-ink-400">
        {details.map((detail) => (
          <li key={detail} className="flex items-start gap-1.5">
            <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-ink-300 dark:bg-ink-600" />
            {detail}
          </li>
        ))}
      </ul>
      <div className="mt-auto flex flex-wrap gap-2 pt-5">
        <Link to={primaryTo} className="btn-primary">
          <UploadCloud className="h-4 w-4" />
          {primaryLabel}
        </Link>
        <Link to={secondaryTo} className="btn-secondary">
          {secondaryLabel}
          <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </div>
    </article>
  );
}

function KindBadge({ entry }: { entry: ImportHistoryEntry }) {
  const Icon = entry.kind === 'purchase' ? ShoppingCart : FileSpreadsheet;
  return (
    <span
      className={`badge ${
        entry.kind === 'purchase'
          ? 'bg-violet-50 text-violet-700 dark:bg-violet-950/40 dark:text-violet-300'
          : 'bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300'
      }`}
    >
      <Icon className="h-3 w-3" />
      {entry.kindLabel}
    </span>
  );
}

export function ImportsPage() {
  const [entries, setEntries] = useState<ImportHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const loadHistory = useCallback(async () => {
    setLoading(true);
    setError('');
    const [imports, purchases] = await Promise.all([
      settle(api.getImports()),
      settle(api.listPurchases()),
    ]);

    const batches: ImportBatch[] = imports.data?.batches ?? [];
    const purchaseList: Purchase[] = purchases.data ?? [];
    setEntries(buildImportHistory(batches, purchaseList));

    const failures: string[] = [];
    if (imports.error) failures.push('movimentações');
    if (purchases.error) failures.push('compras');
    if (failures.length === 1) {
      setError(
        `Não foi possível carregar o histórico de ${failures[0]}. Os demais registros continuam disponíveis.`,
      );
    } else if (failures.length > 1) {
      setError(errorMessage(imports.error ?? purchases.error));
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  return (
    <div>
      <PageHeader
        title="Importações"
        subtitle="Comece uma importação de movimentações ou de compras e acompanhe o histórico em um só lugar."
        actions={
          <Button variant="secondary" onClick={() => void loadHistory()} disabled={loading}>
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            Atualizar histórico
          </Button>
        }
      />

      <section className="grid gap-4 md:grid-cols-2" aria-label="Fluxos de importação">
        <FlowCard
          icon={FileSpreadsheet}
          title="Importar movimentações"
          description="Traga despesas, receitas e transferências de uma planilha CSV ou Excel."
          details={[
            'Prévia com mapeamento de colunas e correção de linhas',
            'Detecção de duplicidades e revisão de categorias',
            'Grava os lançamentos somente após a confirmação',
          ]}
          primaryLabel="Importar movimentações"
          primaryTo="/importacoes/movimentacoes"
          secondaryLabel="Ver movimentações"
          secondaryTo="/lancamentos"
          tone="blue"
        />
        <FlowCard
          icon={ShoppingCart}
          title="Importar NFC-e/compras"
          description="Consulte uma NFC-e do RJ pelo QR Code, revise os itens e salve a compra."
          details={[
            'Prévia do fornecedor, total e itens antes de gravar',
            'Deduplicação pela chave de acesso da nota',
            'Não cria nem altera movimentações financeiras',
          ]}
          primaryLabel="Importar NFC-e"
          primaryTo="/importacoes/nfce"
          secondaryLabel="Ver compras"
          secondaryTo="/compras"
          tone="violet"
        />
      </section>

      <section className="card mt-4 overflow-hidden" aria-labelledby="import-history-title">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-ink-200 px-4 py-3 dark:border-ink-800">
          <div>
            <h2
              id="import-history-title"
              className="text-sm font-semibold text-ink-900 dark:text-white"
            >
              Histórico de importações
            </h2>
            <p className="text-[11px] text-ink-400">
              Movimentações e compras, ordenadas da mais recente para a mais antiga.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {!loading && <span className="text-[11px] text-ink-400">{entries.length} registro(s)</span>}
            {loading && <Loader2 className="h-4 w-4 animate-spin text-ink-400" />}
          </div>
        </div>

        {error && (
          <div
            role="alert"
            className="flex flex-wrap items-center gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2.5 text-[12px] text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/25 dark:text-amber-200"
          >
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            <p className="min-w-[200px] flex-1">{error}</p>
            <Button size="sm" variant="ghost" onClick={() => void loadHistory()}>
              Tentar novamente
            </Button>
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-[13px] text-ink-400">
            <Loader2 className="h-4 w-4 animate-spin" />
            Carregando histórico...
          </div>
        ) : entries.length === 0 ? (
          <EmptyState
            icon={History}
            title="Nenhuma importação realizada ainda"
            description="Escolha um dos fluxos acima para importar movimentações ou uma NFC-e."
          />
        ) : (
          <div className="table-shell max-h-[440px]">
            <table className="w-full min-w-[860px]">
              <thead className="sticky top-0">
                <tr>
                  <th className="th">Tipo</th>
                  <th className="th">Origem</th>
                  <th className="th">Data</th>
                  <th className="th">Processado</th>
                  <th className="th">Resultado</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr
                    key={entry.id}
                    className="hover:bg-ink-50/70 dark:hover:bg-ink-800/30"
                  >
                    <td className="td">
                      <KindBadge entry={entry} />
                    </td>
                    <td className="td">
                      {entry.href ? (
                        <Link
                          to={entry.href}
                          className="block max-w-[360px] truncate font-medium text-ink-700 hover:text-blue-700 dark:text-ink-200 dark:hover:text-blue-300"
                        >
                          {entry.title}
                        </Link>
                      ) : (
                        <span className="block max-w-[360px] truncate font-medium text-ink-700 dark:text-ink-200">
                          {entry.title}
                        </span>
                      )}
                      <p className="mt-0.5 text-[11px] text-ink-400">{entry.subtitle}</p>
                    </td>
                    <td className="td whitespace-nowrap text-ink-500 dark:text-ink-400">
                      {formatDateTimeBR(entry.date)}
                    </td>
                    <td className="td num whitespace-nowrap text-ink-500 dark:text-ink-400">
                      {entry.quantityLabel}
                    </td>
                    <td className="td">
                      <span className={`badge ${STATUS_STYLES[entry.status]}`}>
                        {entry.statusLabel}
                      </span>
                      <p className="mt-0.5 text-[11px] text-ink-400">{entry.statusDetail}</p>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
