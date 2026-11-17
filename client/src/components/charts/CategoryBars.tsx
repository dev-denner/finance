import { useState } from 'react';
import type { CategoryShare } from '../../lib/charts';
import { formatBRL } from '../../lib/format';

function percent(share: number): string {
  return `${(share * 100).toFixed(share < 0.1 ? 1 : 0).replace('.', ',')}%`;
}

/**
 * Barras horizontais ordenadas, uma série só (uma cor; a legenda é o título).
 * O valor fica na ponta de cada barra; passar o mouse ou focar mostra a
 * participação no total. "Outras" usa o cinza neutro.
 */
export function CategoryBars({
  items,
  onSelect,
}: {
  items: CategoryShare[];
  /** Abrir a categoria (ex.: os lançamentos do ano); "Outras" não abre. */
  onSelect?: (item: CategoryShare) => void;
}) {
  const [active, setActive] = useState<string | null>(null);
  const max = Math.max(...items.map((item) => item.cents), 1);
  return (
    <ul className="space-y-1.5" onPointerLeave={() => setActive(null)}>
      {items.map((item) => {
        const clickable = Boolean(onSelect && item.categoryId !== null);
        const content = (
          <>
            <span className="w-[34%] min-w-0 shrink-0 truncate text-left text-[12px] text-ink-600 dark:text-ink-300">{item.label}</span>
            <span className="relative flex h-5 min-w-0 flex-1 items-center">
              <span
                aria-hidden="true"
                className="h-3 rounded-r transition-opacity"
                style={{
                  width: `${Math.max((item.cents / max) * 100, 0.5)}%`,
                  maxWidth: 'calc(100% - 92px)',
                  background: item.categoryId === null ? 'var(--chart-other)' : 'var(--chart-series-1)',
                  opacity: active === null || active === item.key ? 1 : 0.55,
                }}
              />
              <span className="ml-1.5 whitespace-nowrap text-[11px] tabular-nums text-ink-700 dark:text-ink-200">
                {formatBRL(item.cents)}
                {active === item.key && <span className="ml-1 text-ink-400">· {percent(item.share)}</span>}
              </span>
            </span>
          </>
        );
        const common = {
          className: `flex w-full items-center gap-2 rounded-md px-1 py-0.5 ${clickable ? 'hover:bg-ink-50 dark:hover:bg-ink-800/40' : ''}`,
          onPointerEnter: () => setActive(item.key),
          onFocus: () => setActive(item.key),
          onBlur: () => setActive(null),
          'aria-label': `${item.label}: ${formatBRL(item.cents)}, ${percent(item.share)} do total`,
        };
        return (
          <li key={item.key}>
            {clickable ? (
              <button type="button" {...common} onClick={() => onSelect?.(item)}>
                {content}
              </button>
            ) : (
              <div tabIndex={0} {...common}>
                {content}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
