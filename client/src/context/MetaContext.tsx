import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { api, errorMessage } from '../lib/api';
import type { Meta } from '../lib/types';

interface MetaContextValue {
  meta: Meta | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

const MetaContext = createContext<MetaContextValue | null>(null);

export function MetaProvider({ children }: { children: ReactNode }) {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const data = await api.getMeta();
      setMeta(data);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo(
    () => ({ meta, loading, error, refresh }),
    [meta, loading, error, refresh],
  );

  return <MetaContext.Provider value={value}>{children}</MetaContext.Provider>;
}

export function useMeta(): MetaContextValue {
  const context = useContext(MetaContext);
  if (!context) throw new Error('useMeta deve ser usado dentro de MetaProvider.');
  return context;
}
