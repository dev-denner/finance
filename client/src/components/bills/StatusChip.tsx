import { AlertTriangle, CalendarCheck, CheckCircle2, Clock, MinusCircle, CircleDot } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { statusInfo, type StatusTone } from '../../lib/bills-view';
import type { Bill } from '../../lib/types';

const TONES: Record<StatusTone, { className: string; icon: LucideIcon }> = {
  danger: {
    className: 'bg-rose-50 text-rose-700 ring-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:ring-rose-900/60',
    icon: AlertTriangle,
  },
  warning: {
    className: 'bg-amber-50 text-amber-800 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-900/60',
    icon: Clock,
  },
  info: {
    className: 'bg-blue-50 text-blue-700 ring-blue-200 dark:bg-blue-950/40 dark:text-blue-300 dark:ring-blue-900/60',
    icon: CalendarCheck,
  },
  neutral: {
    className: 'bg-ink-50 text-ink-600 ring-ink-200 dark:bg-ink-800/60 dark:text-ink-300 dark:ring-ink-700',
    icon: CircleDot,
  },
  success: {
    className: 'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-900/60',
    icon: CheckCircle2,
  },
  muted: {
    className: 'bg-ink-50 text-ink-400 ring-ink-200 line-through dark:bg-ink-900 dark:text-ink-500 dark:ring-ink-800',
    icon: MinusCircle,
  },
};

export function StatusChip({ bill, today }: { bill: Bill; today: string }) {
  const info = statusInfo(bill, today);
  const tone = TONES[info.tone];
  const Icon = tone.icon;
  return (
    <span className={`badge whitespace-nowrap ring-1 ring-inset ${tone.className}`} data-status={bill.displayStatus}>
      <Icon className="h-3 w-3" aria-hidden="true" />
      {info.label}
    </span>
  );
}
