import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

interface SelectionContextValue {
  selectedIds: Set<number>;
  selectedCount: number;
  toggle: (id: number) => void;
  setSelected: (id: number, selected: boolean) => void;
  setMany: (ids: number[], selected: boolean) => void;
  remove: (ids: number[]) => void;
  clear: () => void;
}

const SelectionContext = createContext<SelectionContextValue | null>(null);

export function SelectionProvider({ children }: { children: ReactNode }) {
  const [selectedIds, setSelectedIds] = useState<Set<number>>(() => new Set());

  const toggle = useCallback((id: number) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const setSelected = useCallback((id: number, selected: boolean) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (selected) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const setMany = useCallback((ids: number[], selected: boolean) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      for (const id of ids) {
        if (selected) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }, []);

  const remove = useCallback((ids: number[]) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      for (const id of ids) next.delete(id);
      return next;
    });
  }, []);

  const clear = useCallback(() => setSelectedIds(new Set()), []);

  const value = useMemo(
    () => ({
      selectedIds,
      selectedCount: selectedIds.size,
      toggle,
      setSelected,
      setMany,
      remove,
      clear,
    }),
    [selectedIds, toggle, setSelected, setMany, remove, clear],
  );

  return <SelectionContext.Provider value={value}>{children}</SelectionContext.Provider>;
}

export function useSelection(): SelectionContextValue {
  const context = useContext(SelectionContext);
  if (!context) throw new Error('useSelection deve ser usado dentro de SelectionProvider.');
  return context;
}
