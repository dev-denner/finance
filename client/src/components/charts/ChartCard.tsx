import { useState, type ReactNode } from 'react';
import { BarChart3, Table2 } from 'lucide-react';

export interface LegendItem {
  label: string;
  /** Cor da série (variável CSS). */
  color: string;
  /** Barras e áreas usam quadrado; linhas, um traço. */
  shape: 'box' | 'line';
}

/**
 * Moldura comum dos gráficos: título, legenda (só com duas ou mais séries) e
 * a alternância para a tabela com os mesmos números, que mantém tudo legível
 * sem depender da cor nem do mouse.
 */
export function ChartCard({
  title,
  subtitle,
  legend = [],
  table,
  children,
}: {
  title: string;
  subtitle?: string;
  legend?: LegendItem[];
  table: ReactNode;
  children: ReactNode;
}) {
  const [showTable, setShowTable] = useState(false);
  return (
    <section className="card overflow-hidden" aria-label={title}>
      <div className="flex flex-wrap items-start justify-between gap-2 border-b border-ink-200 px-4 py-3 dark:border-ink-800">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-ink-900 dark:text-white">{title}</h2>
          {subtitle && <p className="mt-0.5 text-[11px] text-ink-500 dark:text-ink-400">{subtitle}</p>}
        </div>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] font-medium text-ink-600 hover:bg-ink-100 dark:text-ink-300 dark:hover:bg-ink-800"
          aria-pressed={showTable}
          onClick={() => setShowTable((value) => !value)}
        >
          {showTable ? <BarChart3 className="h-3.5 w-3.5" /> : <Table2 className="h-3.5 w-3.5" />}
          {showTable ? 'Ver gráfico' : 'Ver tabela'}
        </button>
      </div>
      {legend.length > 1 && !showTable && (
        <ul className="flex flex-wrap gap-x-4 gap-y-1 px-4 pt-3 text-[12px] text-ink-600 dark:text-ink-300">
          {legend.map((item) => (
            <li key={item.label} className="inline-flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className={item.shape === 'line' ? 'h-0.5 w-3.5 rounded-full' : 'h-2.5 w-2.5 rounded-sm'}
                style={{ background: item.color }}
              />
              {item.label}
            </li>
          ))}
        </ul>
      )}
      <div className="px-4 pb-4 pt-3">{showTable ? table : children}</div>
    </section>
  );
}
