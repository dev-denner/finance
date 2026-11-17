import { TrendingUp } from 'lucide-react';
import type { ForecastCard } from '../../lib/bills-view';
import { formatBRL } from '../../lib/format';

interface ForecastStripProps {
  cards: ForecastCard[];
  onSelect: (year: number, month: number) => void;
}

/**
 * Previsão do mês corrente e dos seguintes: total previsto, em aberto e pago.
 * Cada cartão abre o mês correspondente na lista.
 */
export function ForecastStrip({ cards, onSelect }: ForecastStripProps) {
  if (cards.length === 0) return null;
  return (
    <section aria-labelledby="bills-forecast-title" className="space-y-2">
      <h2
        id="bills-forecast-title"
        className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-ink-500 dark:text-ink-400"
      >
        <TrendingUp className="h-3.5 w-3.5 text-blue-600 dark:text-blue-400" aria-hidden="true" />
        Próximos meses
      </h2>
      <div className="grid gap-3 sm:grid-cols-3">
        {cards.map((card) => (
          <button
            key={`${card.year}-${card.month}`}
            type="button"
            aria-pressed={card.selected}
            aria-label={`Abrir ${card.label}: previsto ${formatBRL(card.totalCents)}, em aberto ${formatBRL(card.openCents)}`}
            onClick={() => onSelect(card.year, card.month)}
            className={`card px-4 py-3 text-left transition hover:border-blue-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:hover:border-blue-700 ${
              card.selected ? 'border-blue-400 ring-1 ring-blue-400 dark:border-blue-600 dark:ring-blue-600' : ''
            }`}
          >
            <span className="block text-[13px] font-medium text-ink-700 dark:text-ink-200">{card.label}</span>
            <span className="mt-1 block text-lg font-semibold tabular-nums text-ink-900 dark:text-white">
              {formatBRL(card.totalCents)}
            </span>
            <span className="mt-2 block h-1.5 overflow-hidden rounded-full bg-ink-100 dark:bg-ink-800" aria-hidden="true">
              <span className="block h-full rounded-full bg-emerald-500" style={{ width: `${Math.round(card.paidShare * 100)}%` }} />
            </span>
            <span className="mt-2 flex flex-wrap gap-x-3 gap-y-0.5 text-[12px] tabular-nums text-ink-500 dark:text-ink-400">
              <span>Em aberto {formatBRL(card.openCents)}</span>
              <span>Pago {formatBRL(card.paidCents)}</span>
              {card.overdueCents > 0 && (
                <span className="text-rose-600 dark:text-rose-400">Atrasado {formatBRL(card.overdueCents)}</span>
              )}
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}
