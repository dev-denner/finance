import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft,
  CalendarDays,
  Check,
  ExternalLink,
  FileUp,
  PackageSearch,
  Plus,
  RefreshCw,
  Search,
  RotateCcw,
} from 'lucide-react';
import { ApiError, api } from '../lib/api';
import type { Lookup, Purchase, PurchaseReconciliationCandidates } from '../lib/types';
import { categoryColorHex, formatBRL, formatDateBR, formatDateTimeBR, isoToParts, MONTHS_LONG } from '../lib/format';
import { useMeta } from '../context/MetaContext';
import { useToast } from '../context/ToastContext';
import { Button } from '../components/ui/Button';
import { EmptyState, PageHeader, Spinner } from '../components/ui/Page';
import { Modal } from '../components/ui/Modal';

function errorText(error: unknown): string {
  return error instanceof ApiError ? error.message : 'Não foi possível concluir a operação.';
}

function purchaseMatches(purchase: Purchase, query: string): boolean {
  const normalized = query.trim().toLocaleLowerCase('pt-BR');
  if (!normalized) return true;
  return [
    purchase.supplierName,
    purchase.supplierCnpj,
    purchase.invoiceNumber,
    purchase.series,
    purchase.paymentMethod,
    purchase.accessKey,
  ]
    .filter((value): value is string => Boolean(value))
    .some((value) => value.toLocaleLowerCase('pt-BR').includes(normalized));
}

function PurchaseDetail({ rawId }: { rawId: string }) {
  const id = Number(rawId);
  const valid = Number.isInteger(id) && id > 0;
  const { meta, refresh: refreshMeta } = useMeta();
  const { showToast } = useToast();
  const [purchase, setPurchase] = useState<Purchase | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedItemIds, setSelectedItemIds] = useState<Set<number>>(new Set());
  const [bulkCategoryId, setBulkCategoryId] = useState('');
  const [savingItemsCategory, setSavingItemsCategory] = useState(false);
  const [categoryModalOpen, setCategoryModalOpen] = useState(false);
  const [categoryName, setCategoryName] = useState('');
  const [categoryColor, setCategoryColor] = useState('#3b82f6');
  const [creatingCategory, setCreatingCategory] = useState(false);
  const [reconciliation, setReconciliation] = useState<PurchaseReconciliationCandidates | null>(null);
  const [reconciliationLoading, setReconciliationLoading] = useState(false);
  const [reconciliationError, setReconciliationError] = useState('');
  const [pendingReconciliation, setPendingReconciliation] = useState(false);
  const [selectedTransactionIds, setSelectedTransactionIds] = useState<Set<number>>(new Set());
  const [walletAmounts, setWalletAmounts] = useState<Record<number, string>>({});
  const [walletAdjustments, setWalletAdjustments] = useState<Record<number, boolean>>({});
  const [debitAdjustmentsConfirmed, setDebitAdjustmentsConfirmed] = useState<Set<number>>(new Set());
  const [walletAdjustmentDate, setWalletAdjustmentDate] = useState('');
  const [reconciliationCategoryId, setReconciliationCategoryId] = useState('');
  const [reconciling, setReconciling] = useState(false);
  const [undoReconciliationOpen, setUndoReconciliationOpen] = useState(false);
  const [undoingReconciliation, setUndoingReconciliation] = useState(false);

  const refreshReconciliation = useCallback(async () => {
    setReconciliationLoading(true);
    setReconciliationError('');
    try {
      setReconciliation(await api.getPurchaseReconciliationCandidates(id));
    } catch (reason) {
      setReconciliationError(errorText(reason));
    } finally {
      setReconciliationLoading(false);
    }
  }, [id]);

  const confirmReconciliation = async () => {
    if (!pendingReconciliation || reconciling || !reconciliation || !purchase) return;
    const walletPayments = reconciliation.wallets.flatMap((wallet) => {
      const amountCents = Math.round(Number(walletAmounts[wallet.id] ?? 0) * 100);
      if (!Number.isSafeInteger(amountCents) || amountCents <= 0) return [];
      const missing = Math.max(0, amountCents - Math.max(0, wallet.balanceCents), -wallet.minimumBalanceCents);
      if (missing > 0 && !walletAdjustments[wallet.id]) return [];
      return [{ paymentMethodId: wallet.id, amountCents, ...(missing > 0 ? { adjustment: {
        amountCents: missing,
        effectiveDate: walletAdjustmentDate || wallet.minimumBalanceDate || purchase.issuedAt.slice(0, 10),
        reason: 'opening_balance' as const,
        description: 'Saldo inicial retroativo para liquidação de compra',
      } } : {}) }];
    });
    const debitShortfalls = new Map<number, { amountCents: number; effectiveDate: string }>();
    for (const candidate of reconciliation.candidates) {
      if (selectedTransactionIds.has(candidate.transactionId) && candidate.balanceShortfallCents && candidate.balanceShortfallCents > 0 && candidate.paymentMethodId && debitAdjustmentsConfirmed.has(candidate.paymentMethodId)) {
        const current = debitShortfalls.get(candidate.paymentMethodId);
        debitShortfalls.set(candidate.paymentMethodId, {
          amountCents: Math.max(current?.amountCents ?? 0, candidate.balanceShortfallCents),
          effectiveDate: [current?.effectiveDate, candidate.balanceShortfallDate, purchase.issuedAt.slice(0, 10)].filter((date): date is string => Boolean(date)).sort()[0]!,
        });
      }
    }
    setReconciling(true);
    try {
      const updated = await api.reconcilePurchase(id, {
        transactionIds: [...selectedTransactionIds],
        walletPayments,
        balanceAdjustments: [...debitShortfalls].map(([paymentMethodId, adjustment]) => ({ paymentMethodId, ...adjustment, reason: 'opening_balance' as const, description: 'Saldo inicial retroativo para liquidação de compra' })),
        categoryId: reconciliationCategoryId ? Number(reconciliationCategoryId) : null,
      });
      setPurchase(updated);
      setPendingReconciliation(false);
      await refreshReconciliation();
      showToast('Compra conciliada; as movimentações originais foram preservadas.');
    } catch (reason) {
      showToast(errorText(reason), 'error');
    } finally {
      setReconciling(false);
    }
  };

  const undoReconciliation = async () => {
    if (undoingReconciliation) return;
    setUndoingReconciliation(true);
    try {
      const updated = await api.undoPurchaseReconciliation(id);
      setPurchase(updated);
      setReconciliation(null);
      setUndoReconciliationOpen(false);
      showToast('Conciliação desfeita; as categorias anteriores foram restauradas.');
    } catch (reason) {
      showToast(errorText(reason), 'error');
    } finally {
      setUndoingReconciliation(false);
    }
  };

  useEffect(() => {
    if (!valid) {
      setError('Compra não encontrada.');
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    setError('');
    void api
      .getPurchase(id)
      .then((result) => {
        if (active) {
          setPurchase(result);
          if (result.reconciledAt) void refreshReconciliation();
        }
      })
      .catch((reason: unknown) => {
        if (active) setError(errorText(reason));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [id, refreshReconciliation, valid]);

  const saveItemsCategory = async (itemIds: number[], categoryId: number | null) => {
    if (!itemIds.length || savingItemsCategory) return;
    setSavingItemsCategory(true);
    try {
      await api.updatePurchaseItemsCategory(id, itemIds, categoryId);
      const idSet = new Set(itemIds);
      setPurchase((current) => current ? {
        ...current,
        items: current.items?.map((item) => item.id && idSet.has(item.id) ? { ...item, categoryId } : item),
      } : current);
      setSelectedItemIds((current) => new Set([...current].filter((itemId) => !idSet.has(itemId))));
      setBulkCategoryId('');
      showToast(itemIds.length === 1 ? 'Categoria do item atualizada.' : `Categoria aplicada a ${itemIds.length} itens.`);
    } catch (reason) {
      showToast(errorText(reason), 'error');
    } finally {
      setSavingItemsCategory(false);
    }
  };

  const createCategory = async () => {
    if (!categoryName.trim() || creatingCategory) return;
    setCreatingCategory(true);
    try {
      const created = await api.createLookup('category', categoryName.trim(), categoryColor);
      await refreshMeta();
      setCategoryModalOpen(false);
      setCategoryName('');
      setBulkCategoryId(String(created.id));
      if (selectedItemIds.size > 0) await saveItemsCategory([...selectedItemIds], created.id);
      else showToast('Categoria criada. Ela já está disponível para classificar os itens.');
    } catch (reason) {
      showToast(errorText(reason), 'error');
    } finally {
      setCreatingCategory(false);
    }
  };

  const backAction = (
    <Link to="/compras" className="btn-secondary"><ArrowLeft className="h-4 w-4" />Voltar às compras</Link>
  );
  const importAction = (
    <Link to="/importacoes/nfce" className="btn-primary"><FileUp className="h-4 w-4" />Importar NFC-e</Link>
  );

  if (loading) return <><PageHeader title="Compra" actions={<>{backAction}{importAction}</>} /><Spinner label="Carregando compra..." /></>;
  if (error || !purchase) {
    return <><PageHeader title="Compra" actions={<>{backAction}{importAction}</>} /><div className="card p-4"><p role="alert" className="rounded-lg bg-rose-50 p-3 text-sm text-rose-700 dark:bg-rose-950/30 dark:text-rose-300">{error || 'Compra não encontrada.'}</p></div></>;
  }

  const items = purchase.items ?? [];
  const itemIds = items.map((item) => item.id).filter((itemId): itemId is number => itemId !== undefined);
  const allSelected = itemIds.length > 0 && itemIds.every((itemId) => selectedItemIds.has(itemId));
  const categories = meta?.categories ?? [];
  const selectedMovementCents = reconciliation ? [...selectedTransactionIds].reduce((sum, transactionId) => sum + Math.abs(reconciliation.candidates.find((candidate) => candidate.transactionId === transactionId)?.amountCents ?? 0), 0) : 0;
  const selectedWalletCents = Object.values(walletAmounts).reduce((sum, amount) => sum + Math.round(Number(amount || 0) * 100), 0);
  const missingBalanceConfirmation = Boolean(reconciliation?.candidates.some((candidate) => selectedTransactionIds.has(candidate.transactionId) && (candidate.balanceShortfallCents ?? 0) > 0 && candidate.paymentMethodId && !debitAdjustmentsConfirmed.has(candidate.paymentMethodId)));
  const missingWalletConfirmation = Boolean(reconciliation?.wallets.some((wallet) => {
    const amountCents = Math.round(Number(walletAmounts[wallet.id] ?? 0) * 100);
    if (amountCents <= 0) return false;
    const shortfall = Math.max(0, amountCents - Math.max(0, wallet.balanceCents), -wallet.minimumBalanceCents);
    return shortfall > 0 && !walletAdjustments[wallet.id];
  }));
  const toggleItem = (itemId: number) => setSelectedItemIds((current) => {
    const next = new Set(current);
    if (next.has(itemId)) next.delete(itemId);
    else next.add(itemId);
    return next;
  });

  return (
    <>
      <PageHeader title={purchase.supplierName} subtitle={`NFC-e ${purchase.invoiceNumber} • Série ${purchase.series} • ${formatDateTimeBR(purchase.issuedAt)}`} actions={<>{backAction}{importAction}</>} />
      <section className="card mb-5 grid gap-4 p-4 sm:grid-cols-2 xl:grid-cols-4">
        <div><p className="text-xs text-ink-400">CNPJ do fornecedor</p><p className="mt-1 text-sm font-medium">{purchase.supplierCnpj}</p></div>
        <div><p className="text-xs text-ink-400">Total</p><p className="mt-1 text-sm font-semibold">{formatBRL(purchase.totalCents)}</p></div>
        {purchase.invoiceDiscountCents > 0 && <div><p className="text-xs text-ink-400">Desconto na nota</p><p className="mt-1 text-sm">{formatBRL(purchase.invoiceDiscountCents)}</p></div>}
        <div><p className="text-xs text-ink-400">Forma de pagamento</p><p className="mt-1 text-sm">{purchase.paymentMethod ?? 'Não informada'}</p></div>
        <div><p className="text-xs text-ink-400">Importada em</p><p className="mt-1 text-sm">{purchase.importedAt ? formatDateTimeBR(purchase.importedAt) : '—'}</p></div>
        <div className="sm:col-span-2 xl:col-span-4"><p className="text-xs text-ink-400">Chave de acesso</p><p className="mt-1 break-all font-mono text-xs">{purchase.accessKey}</p></div>
      </section>

      <section className="card mb-5 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div><h2 className="text-sm font-semibold">Conciliação de pagamentos</h2><p className="mt-1 text-xs text-ink-400">Selecione movimentações e carteiras. Nada é vinculado sem confirmação; o total precisa fechar exatamente.</p></div>
          {purchase.reconciledAt ? <Button size="sm" variant="secondary" onClick={() => setUndoReconciliationOpen(true)}>Desfazer conciliação</Button> : <Button size="sm" variant="primary" onClick={() => void refreshReconciliation()} loading={reconciliationLoading}>Buscar pagamentos</Button>}
        </div>
        {reconciliationError && <p role="alert" className="mt-3 rounded-lg bg-rose-50 p-3 text-sm text-rose-700 dark:bg-rose-950/30 dark:text-rose-300">{reconciliationError}</p>}
        {reconciliation?.settlements.length ? <div className="mt-4 space-y-2">{reconciliation.settlements.map((settlement) => <div key={settlement.id} className="flex justify-between rounded-lg border border-emerald-200 p-3 text-sm dark:border-emerald-900/50"><span>{settlement.settlementType === 'movement' ? `Movimentação #${settlement.transactionId}` : 'Carteira'} · {settlement.paymentMethodName}</span><strong>{formatBRL(settlement.amountCents)}</strong></div>)}<p className="text-xs text-ink-500">Total liquidado: {formatBRL(reconciliation.settledCents)} de {formatBRL(reconciliation.totalCents)}.</p></div> : null}
        {reconciliation && !purchase.reconciledAt && <div className="mt-4 space-y-3">
          <p className="text-sm font-medium">Movimentações sugeridas · {formatBRL([...selectedTransactionIds].reduce((sum, id) => sum + Math.abs(reconciliation.candidates.find((candidate) => candidate.transactionId === id)?.amountCents ?? 0), 0))} selecionados</p>
          {reconciliation.candidates.length === 0 && <p className="text-sm text-ink-500">Nenhuma movimentação compatível foi encontrada em até {reconciliation.toleranceDays} dias.</p>}
          {reconciliation.candidates.map((candidate) => <div key={candidate.transactionId} className="rounded-lg border border-ink-200 p-3 text-sm dark:border-ink-700"><label className="flex cursor-pointer items-center justify-between gap-3"><span className="flex items-start gap-3"><input type="checkbox" checked={selectedTransactionIds.has(candidate.transactionId)} onChange={() => setSelectedTransactionIds((current) => { const next = new Set(current); if (next.has(candidate.transactionId)) next.delete(candidate.transactionId); else next.add(candidate.transactionId); return next; })} /><span><strong>{candidate.description}</strong><small className="block text-ink-500">{formatDateBR(candidate.purchaseDate)} · {candidate.dayDistance === 0 ? 'mesmo dia' : `${Math.abs(candidate.dayDistance)} dia(s) ${candidate.dayDistance < 0 ? 'antes' : 'depois'}`} · {candidate.paymentMethodName} · {candidate.categoryName}</small></span></span><strong>{formatBRL(candidate.amountCents, { absolute: true })}</strong></label>{selectedTransactionIds.has(candidate.transactionId) && (candidate.balanceShortfallCents ?? 0) > 0 && candidate.paymentMethodId && <label className="mt-2 block rounded bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-950/30 dark:text-amber-200"><input type="checkbox" checked={debitAdjustmentsConfirmed.has(candidate.paymentMethodId ?? -1)} onChange={(event) => setDebitAdjustmentsConfirmed((current) => { const next = new Set(current); if (event.target.checked) next.add(candidate.paymentMethodId ?? -1); else next.delete(candidate.paymentMethodId ?? -1); return next; })} /> Saldo histórico insuficiente em {candidate.paymentMethodName}: faltam {formatBRL(candidate.balanceShortfallCents ?? 0)}. Confirmo registrar crédito retroativo em {formatDateBR(purchase.issuedAt.slice(0, 10))}.</label>}</div>)}
          {reconciliation.wallets.map((wallet) => { const amountCents = Math.round(Number(walletAmounts[wallet.id] ?? 0) * 100); const missing = Math.max(0, amountCents - Math.max(0, wallet.balanceCents), -wallet.minimumBalanceCents); return <div key={wallet.id} className="grid gap-2 rounded-lg border border-ink-200 p-3 text-sm dark:border-ink-700 sm:grid-cols-[1fr_150px]"><div><strong>{wallet.name}</strong><p className="text-xs text-ink-500">Saldo calculado: {formatBRL(wallet.balanceCents)}</p></div><label className="text-xs">Pagamento (R$)<input className="input mt-1" type="number" min="0" step="0.01" value={walletAmounts[wallet.id] ?? ''} onChange={(event) => setWalletAmounts({ ...walletAmounts, [wallet.id]: event.target.value })} /></label>{missing > 0 && <div className="sm:col-span-2 rounded bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">Faltam {formatBRL(missing)}. <label className="ml-2"><input type="checkbox" checked={Boolean(walletAdjustments[wallet.id])} onChange={(event) => setWalletAdjustments({ ...walletAdjustments, [wallet.id]: event.target.checked })} /> Confirmo registrar crédito inicial retroativo</label>{walletAdjustments[wallet.id] && <input className="input mt-2 max-w-[180px]" aria-label="Data do crédito retroativo" type="date" max={purchase.issuedAt.slice(0, 10)} value={walletAdjustmentDate || wallet.minimumBalanceDate || purchase.issuedAt.slice(0, 10)} onChange={(event) => setWalletAdjustmentDate(event.target.value)} />}</div>}</div>; })}
          <p className="text-sm font-semibold">Restante a liquidar: {formatBRL(reconciliation.totalCents - selectedMovementCents - selectedWalletCents)}</p>
          <Button size="sm" variant="primary" disabled={selectedMovementCents + selectedWalletCents !== reconciliation.totalCents || missingBalanceConfirmation || missingWalletConfirmation} onClick={() => { setWalletAdjustmentDate(reconciliation.wallets.find((wallet) => wallet.minimumBalanceDate)?.minimumBalanceDate ?? purchase.issuedAt.slice(0, 10)); setPendingReconciliation(true); }}>Revisar pagamentos</Button>
        </div>}
      </section>

      <section className="card overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-ink-200 px-4 py-3 dark:border-ink-800">
          <div><h2 className="text-sm font-semibold">Itens da compra</h2><p className="mt-1 text-xs text-ink-400">Classifique os produtos sem alterar os dados originais da NFC-e.</p></div>
          <Button size="sm" variant="secondary" onClick={() => setCategoryModalOpen(true)}><Plus className="h-3.5 w-3.5" />Nova categoria</Button>
        </div>
        {selectedItemIds.size > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-b border-blue-200 bg-blue-50/70 px-4 py-3 dark:border-blue-900/50 dark:bg-blue-950/20">
            <span className="mr-1 text-xs font-medium">{selectedItemIds.size} item(ns) selecionado(s)</span>
            <select className="select min-w-[180px]" value={bulkCategoryId} onChange={(event) => event.target.value === '__new__' ? (setBulkCategoryId(''), setCategoryModalOpen(true)) : setBulkCategoryId(event.target.value)} aria-label="Categoria para os itens selecionados">
              <option value="">Escolha uma categoria</option>
              <option value="none">Sem categoria</option>
              {categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
              <option value="__new__">＋ Criar nova categoria…</option>
            </select>
            <Button size="sm" variant="primary" disabled={!bulkCategoryId || bulkCategoryId === '__new__' || savingItemsCategory} loading={savingItemsCategory} onClick={() => void saveItemsCategory([...selectedItemIds], bulkCategoryId === 'none' ? null : Number(bulkCategoryId))}><Check className="h-3.5 w-3.5" />Aplicar categoria</Button>
            <Button size="sm" variant="ghost" onClick={() => setSelectedItemIds(new Set())}>Limpar seleção</Button>
          </div>
        )}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[940px] text-left text-sm">
            <thead className="bg-ink-50 text-xs text-ink-500 dark:bg-ink-900"><tr>
              <th className="w-10 px-4 py-3"><input type="checkbox" aria-label="Selecionar todos os itens" checked={allSelected} onChange={() => setSelectedItemIds(allSelected ? new Set() : new Set(itemIds))} /></th>
              <th className="px-4 py-3">Descrição</th><th className="px-4 py-3">Qtd.</th><th className="px-4 py-3">Un.</th><th className="px-4 py-3 text-right">Unitário</th><th className="px-4 py-3 text-right">Desconto</th><th className="px-4 py-3 text-right">Total</th><th className="px-4 py-3">Categoria</th>
            </tr></thead>
            <tbody>
              {items.map((item, index) => {
                const category = categories.find((candidate) => candidate.id === item.categoryId);
                return <tr key={item.id ?? index} className="border-t border-ink-100 dark:border-ink-800">
                  <td className="px-4 py-3"><input type="checkbox" aria-label={`Selecionar ${item.description}`} checked={item.id ? selectedItemIds.has(item.id) : false} disabled={!item.id || savingItemsCategory} onChange={() => item.id && toggleItem(item.id)} /></td>
                  <td className="px-4 py-3">{item.description}</td><td className="px-4 py-3">{item.quantity}</td><td className="px-4 py-3">{item.unit}</td><td className="px-4 py-3 text-right">{formatBRL(item.unitPriceCents)}</td><td className="px-4 py-3 text-right">{item.discountCents === null ? '—' : formatBRL(item.discountCents)}</td><td className="px-4 py-3 text-right font-medium">{formatBRL(item.totalCents)}</td>
                  <td className="px-4 py-2"><select className="select min-w-[160px] py-1.5 text-xs" aria-label={`Categoria de ${item.description}`} value={item.categoryId ?? ''} disabled={!item.id || savingItemsCategory} onChange={(event) => item.id && void saveItemsCategory([item.id], event.target.value ? Number(event.target.value) : null)}><option value="">Sem categoria</option>{categories.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}</select>{category && <span className="sr-only">Categoria atual: {category.name}</span>}</td>
                </tr>;
              })}
              {items.length === 0 && <tr><td className="px-4 py-6 text-center text-ink-400" colSpan={8}>Nenhum item registrado.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      {pendingReconciliation && (
        <Modal
          title="Revisar conciliação"
          description="Confira o total, pagamentos e categoria antes de confirmar."
          onClose={() => setPendingReconciliation(false)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setPendingReconciliation(false)} disabled={reconciling}>Voltar</Button>
              <Button variant="primary" onClick={() => void confirmReconciliation()} disabled={reconciling || !reconciliationCategoryId} loading={reconciling}>Confirmar conciliação</Button>
            </>
          }
        >
          <div className="space-y-3 text-sm">
            <p>Total da compra: <strong>{formatBRL(purchase.totalCents)}</strong></p>
            <p>Movimentações selecionadas: {selectedTransactionIds.size}; carteiras: {Object.values(walletAmounts).filter((amount) => Number(amount) > 0).length}</p>
            <label className="block">Categoria a aplicar na compra e nos itens
              <select className="select mt-1" value={reconciliationCategoryId} onChange={(event) => setReconciliationCategoryId(event.target.value)}>
                <option value="">Selecione explicitamente</option>
                {categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
              </select>
            </label>
            <p className="rounded-lg bg-blue-50 p-3 text-xs text-blue-800 dark:bg-blue-950/30 dark:text-blue-200">As movimentações originais permanecem intactas. Ajustes retroativos confirmados permanecem no histórico mesmo se a conciliação for desfeita.</p>
          </div>
        </Modal>
      )}
      {undoReconciliationOpen && <Modal title="Desfazer conciliação?" description="O vínculo será removido e as categorias anteriores da compra e dos itens serão restauradas." onClose={() => setUndoReconciliationOpen(false)} footer={<><Button variant="secondary" onClick={() => setUndoReconciliationOpen(false)} disabled={undoingReconciliation}>Manter conciliação</Button><Button variant="danger" onClick={() => void undoReconciliation()} loading={undoingReconciliation}>Desfazer conciliação</Button></>}><p className="text-sm text-ink-600 dark:text-ink-300">A movimentação permanece intacta.</p></Modal>}

      {categoryModalOpen && <Modal title="Nova categoria" description="Crie uma categoria para classificar um ou vários itens desta compra." onClose={() => setCategoryModalOpen(false)} footer={<><Button variant="secondary" onClick={() => setCategoryModalOpen(false)} disabled={creatingCategory}>Cancelar</Button><Button variant="primary" onClick={() => void createCategory()} loading={creatingCategory} disabled={!categoryName.trim()}>Criar categoria</Button></>}>
        <div className="space-y-4"><label className="block"><span className="mb-1 block text-sm font-medium">Nome</span><input className="input" autoFocus maxLength={120} value={categoryName} onChange={(event) => setCategoryName(event.target.value)} placeholder="Ex.: Higiene pessoal" /></label><label className="flex items-center gap-3"><input type="color" value={categoryColor} onChange={(event) => setCategoryColor(event.target.value)} className="h-10 w-14 cursor-pointer rounded border border-ink-200 bg-transparent p-1 dark:border-ink-700" /><span><span className="block text-sm font-medium">Cor</span><span className="text-xs text-ink-400">Pode manter a cor sugerida.</span></span></label>{selectedItemIds.size > 0 && <p className="text-xs text-ink-500">Depois de criada, a categoria será aplicada aos {selectedItemIds.size} itens selecionados.</p>}</div>
      </Modal>}
    </>
  );
}
function PurchaseList() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { meta } = useMeta();
  const { showToast } = useToast();
  const [purchases, setPurchases] = useState<Purchase[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [error, setError] = useState('');
  const [savingCategoryId, setSavingCategoryId] = useState<number | null>(null);
  const query = searchParams.get('search') ?? '';
  const latestParts = isoToParts(purchases[0]?.issuedAt);
  const fallback = latestParts ?? { year: new Date().getFullYear(), month: new Date().getMonth() + 1 };
  const yearValue = Number(searchParams.get('year'));
  const year = Number.isInteger(yearValue) && yearValue > 0 ? yearValue : fallback.year;
  const monthValue = searchParams.get('month');
  const month = monthValue === 'all'
    ? undefined
    : Number.isInteger(Number(monthValue)) && Number(monthValue) >= 1 && Number(monthValue) <= 12
      ? Number(monthValue)
      : fallback.month;
  const categoryFilter = searchParams.get('categoryId') ?? '';
  const categories = meta?.categories ?? [];

  const refresh = useCallback(async () => {
    setListLoading(true);
    setError('');
    try {
      setPurchases(await api.listPurchases());
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setListLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const updateParams = useCallback((updates: Record<string, string | number | null>) => {
    setSearchParams((previous) => {
      const next = new URLSearchParams(previous);
      for (const [key, value] of Object.entries(updates)) {
        if (value === null || value === '') next.delete(key);
        else next.set(key, String(value));
      }
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  useEffect(() => {
    if (listLoading || searchParams.has('year') || searchParams.has('month')) return;
    updateParams({ year: fallback.year, month: fallback.month });
  }, [fallback.month, fallback.year, listLoading, searchParams, updateParams]);

  const yearOptions = useMemo(() => {
    const values = new Set(purchases.map((purchase) => isoToParts(purchase.issuedAt)?.year).filter((value): value is number => Boolean(value)));
    values.add(year);
    values.add(new Date().getFullYear());
    return [...values].sort((left, right) => right - left);
  }, [purchases, year]);

  const filteredPurchases = useMemo(() => purchases.filter((purchase) => {
    const parts = isoToParts(purchase.issuedAt);
    if (!parts || parts.year !== year || (month !== undefined && parts.month !== month)) return false;
    if (categoryFilter === 'none' && purchase.categoryId !== null && purchase.categoryId !== undefined) return false;
    if (categoryFilter && categoryFilter !== 'none' && purchase.categoryId !== Number(categoryFilter)) return false;
    return purchaseMatches(purchase, query);
  }), [purchases, year, month, categoryFilter, query]);

  const groups = useMemo(() => {
    const byMonth = new Map<string, { label: string; purchases: Purchase[] }>();
    for (const purchase of filteredPurchases) {
      const parts = isoToParts(purchase.issuedAt);
      if (!parts) continue;
      const key = `${parts.year}-${String(parts.month).padStart(2, '0')}`;
      const group = byMonth.get(key) ?? { label: `${MONTHS_LONG[parts.month - 1]} de ${parts.year}`, purchases: [] };
      group.purchases.push(purchase);
      byMonth.set(key, group);
    }
    return [...byMonth.entries()].map(([key, group]) => ({ key, ...group }));
  }, [filteredPurchases]);

  const totalCents = filteredPurchases.reduce((sum, purchase) => sum + purchase.totalCents, 0);
  const itemCount = filteredPurchases.reduce((sum, purchase) => sum + (purchase.itemCount ?? 0), 0);
  const hasActiveFilters = Boolean(query || categoryFilter || month !== fallback.month || year !== fallback.year);

  const saveCategory = async (purchaseId: number, categoryId: number | null) => {
    setSavingCategoryId(purchaseId);
    try {
      const updated = await api.updatePurchaseCategory(purchaseId, categoryId);
      setPurchases((current) => current.map((purchase) => purchase.id === purchaseId ? { ...purchase, ...updated } : purchase));
      showToast('Categoria da compra atualizada.');
    } catch (reason) {
      showToast(errorText(reason), 'error');
    } finally {
      setSavingCategoryId(null);
    }
  };

  return (
    <>
      <PageHeader
        title="Compras"
        subtitle="Acompanhe as compras por data, fornecedor e categoria; os dados fiscais originais permanecem preservados."
        actions={
          <>
            <Link to="/importacoes" className="btn-secondary"><ArrowLeft className="h-4 w-4" />Importações</Link>
            <Link to="/importacoes/nfce" className="btn-primary"><FileUp className="h-4 w-4" />Importar NFC-e</Link>
          </>
        }
      />

      {error && (
        <div role="alert" className="mb-4 flex flex-wrap items-center gap-2 rounded-lg bg-rose-50 p-3 text-sm text-rose-700 dark:bg-rose-950/30 dark:text-rose-300">
          <span className="min-w-[200px] flex-1">{error}</span>
          <Button size="sm" variant="secondary" onClick={() => void refresh()}><RefreshCw className="h-3.5 w-3.5" />Tentar novamente</Button>
        </div>
      )}

      {!listLoading && purchases.length > 0 && (
        <>
          <section className="mb-4 grid gap-3 sm:grid-cols-3" aria-label="Resumo das compras filtradas">
            <div className="card px-4 py-3"><p className="text-xs text-ink-400">Compras no período</p><p className="mt-1 text-lg font-semibold">{filteredPurchases.length}</p></div>
            <div className="card px-4 py-3"><p className="text-xs text-ink-400">Total das compras</p><p className="num mt-1 text-lg font-semibold">{formatBRL(totalCents)}</p></div>
            <div className="card px-4 py-3"><p className="text-xs text-ink-400">Itens nas notas</p><p className="mt-1 text-lg font-semibold">{itemCount}</p></div>
          </section>
          <section className="card mb-4 flex flex-col gap-2 p-3 sm:flex-row sm:flex-wrap sm:items-center" aria-label="Filtros de compras">
            <div className="relative min-w-0 flex-1 sm:min-w-[220px]">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400" />
              <input className="input pl-9" type="search" value={query} onChange={(event) => updateParams({ search: event.target.value || null })} placeholder="Fornecedor, CNPJ, NFC-e ou pagamento" aria-label="Pesquisar compras" />
            </div>
            <select className="select w-auto min-w-[100px]" value={year} onChange={(event) => updateParams({ year: Number(event.target.value) })} aria-label="Ano das compras">
              {yearOptions.map((option) => <option key={option} value={option}>{option}</option>)}
            </select>
            <select className="select w-auto min-w-[140px]" value={month ?? 'all'} onChange={(event) => updateParams({ month: event.target.value === 'all' ? 'all' : Number(event.target.value) })} aria-label="Mês das compras">
              <option value="all">Todos os meses</option>
              {MONTHS_LONG.map((name, index) => <option key={name} value={index + 1}>{name}</option>)}
            </select>
            <select className="select w-auto min-w-[170px]" value={categoryFilter} onChange={(event) => updateParams({ categoryId: event.target.value || null })} aria-label="Categoria das compras">
              <option value="">Todas as categorias</option>
              <option value="none">Sem categoria</option>
              {categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
            </select>
            {hasActiveFilters && <Button variant="ghost" size="sm" onClick={() => { setSearchParams({}, { replace: true }); }}><RotateCcw className="h-3.5 w-3.5" />Limpar</Button>}
            <span className="text-[11px] text-ink-400">{filteredPurchases.length} de {purchases.length} compra(s)</span>
          </section>
        </>
      )}

      {listLoading ? <Spinner label="Carregando compras..." /> : purchases.length === 0 ? (
        error ? null : <div className="card"><EmptyState icon={PackageSearch} title="Nenhuma compra importada" description="Use a área de Importações para consultar e revisar a primeira NFC-e." action={<Link to="/importacoes/nfce" className="btn-primary"><FileUp className="h-4 w-4" />Importar NFC-e</Link>} /></div>
      ) : filteredPurchases.length === 0 ? (
        <div className="card"><EmptyState icon={Search} title="Nenhuma compra encontrada" description="Ajuste o período, a categoria ou a busca para encontrar uma compra." action={<Button variant="secondary" onClick={() => setSearchParams({}, { replace: true })}>Limpar filtros</Button>} /></div>
      ) : (
        <div className="space-y-4">
          {groups.map((group) => (
            <section key={group.key} className="card overflow-hidden">
              <header className="flex items-center justify-between gap-3 border-b border-ink-200 px-4 py-3 dark:border-ink-800">
                <div className="flex items-center gap-2"><CalendarDays className="h-4 w-4 text-ink-400" /><h2 className="text-sm font-semibold">{group.label}</h2></div>
                <span className="text-xs text-ink-400">{group.purchases.length} compra(s) · {formatBRL(group.purchases.reduce((sum, purchase) => sum + purchase.totalCents, 0))}</span>
              </header>
              <div className="divide-y divide-ink-100 dark:divide-ink-800">
                {group.purchases.map((purchase) => {
                  const categoryId = purchase.categoryId ?? null;
                  const category = categories.find((item) => item.id === categoryId);
                  return (
                    <article key={purchase.id} className="flex flex-col gap-3 p-4 transition hover:bg-ink-50/70 dark:hover:bg-ink-900/40 sm:flex-row sm:items-center sm:justify-between">
                      <Link to={`/compras/${purchase.id}`} className="min-w-0 flex-1 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">
                        <p className="truncate text-sm font-semibold text-ink-900 dark:text-white">{purchase.supplierName}</p>
                        <p className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-ink-500">
                          <span>{formatDateTimeBR(purchase.issuedAt)}</span><span>·</span><span>NFC-e {purchase.invoiceNumber} · Série {purchase.series}</span><span>·</span><span>{purchase.itemCount ?? 0} itens</span>
                        </p>
                        <p className="mt-1 text-xs text-ink-400">{purchase.paymentMethod ?? 'Pagamento não informado'} · {purchase.supplierCnpj}</p>
                      </Link>
                      <div className="flex flex-wrap items-center gap-3 sm:justify-end">
                        {category ? <span className="rounded-full px-2.5 py-1 text-xs font-medium" style={{ backgroundColor: `${categoryColorHex(category.id, category.color)}22`, color: categoryColorHex(category.id, category.color) }}>{category.name}</span> : <span className="text-xs text-ink-400">Sem categoria</span>}
                        <label className="sr-only" htmlFor={`purchase-category-${purchase.id}`}>Categoria de {purchase.supplierName}</label>
                        <select id={`purchase-category-${purchase.id}`} className="select min-w-[150px] py-1.5 text-xs" value={categoryId ?? ''} disabled={savingCategoryId === purchase.id} onChange={(event) => void saveCategory(purchase.id ?? 0, event.target.value ? Number(event.target.value) : null)}>
                          <option value="">Definir categoria</option>
                          {categories.map((item: Lookup) => <option key={item.id} value={item.id}>{item.name}</option>)}
                        </select>
                        <span className="num min-w-[100px] text-right text-sm font-semibold">{formatBRL(purchase.totalCents)}</span>
                        <Link to={`/compras/${purchase.id}`} aria-label={`Ver compra ${purchase.invoiceNumber}`} className="rounded p-1 text-ink-400 hover:text-ink-800 dark:hover:text-white"><ExternalLink className="h-4 w-4" /></Link>
                      </div>
                    </article>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}
    </>
  );
}
export function PurchasesPage() {
  const { id } = useParams();
  if (id !== undefined) return <PurchaseDetail rawId={id} />;
  return <PurchaseList />;
}
