import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import {
  ArrowRightLeft,
  CalendarClock,
  Database,
  FileUp,
  LayoutGrid,
  Menu,
  Moon,
  ReceiptText,
  ShoppingCart,
  Sun,
  Tags,
  Wallet,
  X,
} from 'lucide-react';
import { useTheme } from '../context/ThemeContext';
import { useSelection } from '../context/SelectionContext';

const NAV_ITEMS = [
  { to: '/lancamentos', label: 'Movimentações', icon: ReceiptText },
  { to: '/contas', label: 'Contas a pagar', icon: CalendarClock },
  { to: '/consolidado', label: 'Consolidado', icon: LayoutGrid },
  { to: '/importacoes', label: 'Importações', icon: FileUp },
  { to: '/compras', label: 'Compras', icon: ShoppingCart },
  { to: '/conciliacao', label: 'Conciliação', icon: ArrowRightLeft },
  { to: '/cadastros', label: 'Cadastros', icon: Tags },
];

function Brand() {
  return (
    <div className="flex items-center gap-2.5 px-1">
      <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-blue-600 to-indigo-600 shadow-sm shadow-blue-600/20">
        <Wallet className="h-[18px] w-[18px] text-white" />
      </div>
      <div className="leading-tight">
        <p className="text-[15px] font-semibold tracking-tight text-ink-900 dark:text-white">
          Fluxo
        </p>
        <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-ink-400">
          Financeiro local
        </p>
      </div>
    </div>
  );
}

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const { theme, toggleTheme } = useTheme();
  const { selectedCount } = useSelection();

  return (
    <div className="flex h-full flex-col">
      <div className="px-3 pb-5 pt-2">
        <Brand />
      </div>

      <p className="px-4 pb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-400">
        Principal
      </p>
      <nav className="flex flex-col gap-0.5 px-2">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          return (
            <NavLink
              key={item.to}
              to={item.to}
              onClick={onNavigate}
              className={({ isActive }) =>
                `group flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] font-medium transition ${
                  isActive
                    ? 'bg-blue-50 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300'
                    : 'text-ink-600 hover:bg-ink-100/80 hover:text-ink-900 dark:text-ink-300 dark:hover:bg-ink-800/70 dark:hover:text-white'
                }`
              }
            >
              <Icon className="h-4 w-4 shrink-0" strokeWidth={1.8} />
              <span className="flex-1">{item.label}</span>
              {item.to === '/lancamentos' && selectedCount > 0 && (
                <span className="rounded-full bg-blue-600 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                  {selectedCount > 99 ? '99+' : selectedCount}
                </span>
              )}
            </NavLink>
          );
        })}
      </nav>

      <div className="mt-auto space-y-3 px-3 pb-3">
        <div className="rounded-lg border border-ink-200 bg-ink-50/70 p-3 dark:border-ink-800 dark:bg-ink-950/40">
          <div className="flex items-center gap-2 text-[11px] font-medium text-ink-600 dark:text-ink-300">
            <Database className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
            Banco local
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-ink-400 dark:text-ink-500">
            SQLite persistente. Seus dados ficam somente neste computador.
          </p>
        </div>
        <button
          type="button"
          onClick={toggleTheme}
          className="flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-[12px] font-medium text-ink-500 transition hover:bg-ink-100 hover:text-ink-800 dark:text-ink-400 dark:hover:bg-ink-800 dark:hover:text-white"
        >
          <span className="flex items-center gap-2">
            {theme === 'dark' ? <Moon className="h-3.5 w-3.5" /> : <Sun className="h-3.5 w-3.5" />}
            Tema {theme === 'dark' ? 'escuro' : 'claro'}
          </span>
          <span
            className={`relative h-4 w-7 rounded-full transition ${
              theme === 'dark' ? 'bg-blue-600' : 'bg-ink-300'
            }`}
          >
            <span
              className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all ${
                theme === 'dark' ? 'left-3.5' : 'left-0.5'
              }`}
            />
          </span>
        </button>
      </div>
    </div>
  );
}

export function Layout() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();

  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

  return (
    <div className="min-h-full">
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-60 border-r border-ink-200 bg-white px-2 py-4 dark:border-ink-800 dark:bg-ink-900 lg:block">
        <SidebarContent />
      </aside>

      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div
            className="absolute inset-0 bg-ink-950/40 backdrop-blur-[2px]"
            onClick={() => setMobileOpen(false)}
            aria-hidden="true"
          />
          <aside className="relative h-full w-64 animate-fade-in border-r border-ink-200 bg-white px-2 py-4 shadow-pop dark:border-ink-800 dark:bg-ink-900">
            <button
              type="button"
              onClick={() => setMobileOpen(false)}
              className="icon-btn absolute right-2 top-2"
              aria-label="Fechar menu"
            >
              <X className="h-4 w-4" />
            </button>
            <SidebarContent onNavigate={() => setMobileOpen(false)} />
          </aside>
        </div>
      )}

      <div className="lg:pl-60">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-ink-200 bg-white/90 px-4 backdrop-blur dark:border-ink-800 dark:bg-ink-900/90 lg:hidden">
          <button
            type="button"
            onClick={() => setMobileOpen(true)}
            className="icon-btn -ml-1"
            aria-label="Abrir menu"
          >
            <Menu className="h-5 w-5" />
          </button>
          <Brand />
        </header>

        <main className="mx-auto w-full max-w-[1560px] px-4 py-5 sm:px-6 lg:px-8 lg:py-7">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
