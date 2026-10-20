import { Loader2, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-[22px] font-semibold tracking-tight text-ink-900 dark:text-white">
          {title}
        </h1>
        {subtitle && (
          <p className="mt-1 text-[13px] text-ink-500 dark:text-ink-400">{subtitle}</p>
        )}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-10 text-[13px] text-ink-400">
      <Loader2 className="h-4 w-4 animate-spin" />
      {label ?? 'Carregando...'}
    </div>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl border border-ink-200 bg-ink-50 text-ink-400 dark:border-ink-700 dark:bg-ink-800/60 dark:text-ink-400">
        <Icon className="h-5 w-5" />
      </div>
      <p className="text-sm font-medium text-ink-800 dark:text-ink-100">{title}</p>
      {description && (
        <p className="mt-1 max-w-sm text-[13px] leading-relaxed text-ink-500 dark:text-ink-400">
          {description}
        </p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
