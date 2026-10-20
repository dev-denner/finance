import { Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { BillsPage } from './pages/BillsPage';
import { ConsolidatedPage } from './pages/ConsolidatedPage';
import { ImportsPage } from './pages/ImportsPage';
import { LookupsPage } from './pages/LookupsPage';
import { ReconciliationPage } from './pages/ReconciliationPage';
import { TransactionsPage } from './pages/TransactionsPage';

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Navigate to="/lancamentos" replace />} />
        <Route path="/lancamentos" element={<TransactionsPage />} />
        <Route path="/contas" element={<BillsPage />} />
        <Route path="/consolidado" element={<ConsolidatedPage />} />
        <Route path="/importacoes" element={<ImportsPage />} />
        <Route path="/conciliacao" element={<ReconciliationPage />} />
        <Route path="/cadastros" element={<LookupsPage />} />
        <Route path="*" element={<Navigate to="/lancamentos" replace />} />
      </Route>
    </Routes>
  );
}
