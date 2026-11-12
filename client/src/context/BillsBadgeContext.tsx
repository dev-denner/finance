import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from '../lib/api';
import { badgeCount } from '../lib/bills-view';

/** Intervalo de atualização do contador do menu. */
const REFRESH_MS = 60_000;

interface BillsBadgeValue {
  /** Contas atrasadas + vencendo hoje. */
  count: number;
  refresh: () => Promise<void>;
}

const BillsBadgeContext = createContext<BillsBadgeValue | null>(null);

export function BillsBadgeProvider({ children }: { children: ReactNode }) {
  const [count, setCount] = useState(0);

  const refresh = useCallback(async () => {
    try {
      setCount(badgeCount(await api.getBillAgenda(7)));
    } catch {
      // O contador é auxiliar: sem servidor, o menu só não mostra o número.
      setCount(0);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const value = useMemo(() => ({ count, refresh }), [count, refresh]);
  return <BillsBadgeContext.Provider value={value}>{children}</BillsBadgeContext.Provider>;
}

export function useBillsBadge(): BillsBadgeValue {
  const context = useContext(BillsBadgeContext);
  if (!context) throw new Error('useBillsBadge deve ser usado dentro de BillsBadgeProvider.');
  return context;
}
