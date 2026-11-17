import { WEEKDAYS_SHORT, type CalendarDay, type CalendarWeek, type StatusTone } from '../../lib/bills-view';
import { formatBRL } from '../../lib/format';

/** Marcador do dia: o tom mais urgente entre as contas que vencem nele. */
const DOT: Record<StatusTone, string> = {
  danger: 'bg-rose-500',
  warning: 'bg-amber-500',
  info: 'bg-blue-500',
  neutral: 'bg-ink-400',
  success: 'bg-emerald-500',
  muted: 'bg-ink-300 dark:bg-ink-600',
};

/** Nomes visíveis por célula antes de "+N" (telas largas). */
const NAMES_PER_DAY = 2;

function dayLabel(cell: CalendarDay): string {
  const count = cell.bills.length;
  if (count === 0) return `Dia ${cell.day}: sem contas`;
  const parts = [`Dia ${cell.day}: ${count} ${count === 1 ? 'conta' : 'contas'}`, `previsto ${formatBRL(cell.totalCents)}`];
  if (cell.openCents > 0) parts.push(`em aberto ${formatBRL(cell.openCents)}`);
  return parts.join(', ');
}

/**
 * Calendário do mês pelo vencimento. Cada dia é um botão que abre, abaixo, as
 * contas daquele dia com as mesmas ações da lista.
 */
export function BillsCalendar({
  weeks,
  selectedDay,
  onSelectDay,
  label,
}: {
  weeks: CalendarWeek[];
  selectedDay: string | null;
  onSelectDay: (date: string) => void;
  label: string;
}) {
  return (
    <table className="w-full table-fixed border-collapse">
      <caption className="sr-only">{label}</caption>
      <thead>
        <tr>
          {WEEKDAYS_SHORT.map((weekday) => (
            <th
              key={weekday}
              scope="col"
              className="border-b border-ink-200 py-2 text-center text-[11px] font-semibold uppercase tracking-wider text-ink-500 dark:border-ink-800 dark:text-ink-400"
            >
              {weekday}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {weeks.map((week, weekIndex) => (
          <tr key={weekIndex}>
            {week.map((cell, dayIndex) => (
              <td
                key={cell?.date ?? `empty-${weekIndex}-${dayIndex}`}
                className="h-16 border-b border-r border-ink-100 p-0 align-top last:border-r-0 sm:h-24 dark:border-ink-800/70"
              >
                {cell && (
                  <button
                    type="button"
                    aria-pressed={cell.date === selectedDay}
                    aria-label={dayLabel(cell)}
                    onClick={() => onSelectDay(cell.date)}
                    className={`flex h-full w-full flex-col items-stretch gap-0.5 p-1.5 text-left transition hover:bg-ink-50/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500 sm:p-2 dark:hover:bg-ink-800/30 ${
                      cell.date === selectedDay ? 'bg-blue-50/80 ring-2 ring-inset ring-blue-400 dark:bg-blue-950/30 dark:ring-blue-600' : ''
                    }`}
                  >
                    <span className="flex items-center justify-between gap-1">
                      <span
                        className={`flex h-6 w-6 items-center justify-center rounded-full text-[12px] tabular-nums ${
                          cell.isToday
                            ? 'bg-blue-600 font-semibold text-white'
                            : 'text-ink-700 dark:text-ink-200'
                        }`}
                      >
                        {cell.day}
                      </span>
                      {cell.tone && <span className={`h-2 w-2 shrink-0 rounded-full ${DOT[cell.tone]}`} aria-hidden="true" />}
                    </span>
                    {cell.bills.length > 0 && (
                      <>
                        <span className="hidden truncate text-[11px] font-medium tabular-nums text-ink-800 sm:block dark:text-ink-100">
                          {formatBRL(cell.totalCents)}
                        </span>
                        <span className="hidden min-w-0 flex-col text-[11px] text-ink-500 lg:flex dark:text-ink-400">
                          {cell.bills.slice(0, NAMES_PER_DAY).map((bill) => (
                            <span key={bill.id} className={`truncate ${bill.state === 'skipped' ? 'line-through opacity-70' : bill.state === 'paid' ? 'opacity-70' : ''}`}>
                              {bill.description}
                            </span>
                          ))}
                          {cell.bills.length > NAMES_PER_DAY && <span>+{cell.bills.length - NAMES_PER_DAY}</span>}
                        </span>
                        <span className="text-[10px] text-ink-400 sm:hidden">{cell.bills.length}</span>
                      </>
                    )}
                  </button>
                )}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
