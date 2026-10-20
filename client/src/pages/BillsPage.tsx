import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Pencil,
  Plus,
  Trash2,
  AlertTriangle,
} from 'lucide-react';
import { Button } from '../components/ui/Button';
import { Field } from '../components/ui/Field';
import { Modal } from '../components/ui/Modal';
import { PageHeader } from '../components/ui/Page';
import { useMeta } from '../context/MetaContext';
import { useToast } from '../context/ToastContext';
import { api, errorMessage } from '../lib/api';
import { formatBRL, formatDateBR, isoToParts } from '../lib/format';
import type { Bill, BillSummary, Lookup } from '../lib/types';

function todayParts() {
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() + 1 };
}

function monthLabel(year: number, month: number) {
  const date = new Date(year, month - 1, 1);
  return date.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
}

function shiftMonth(year: number, month: number, delta: number) {
  const total = year * 12 + (month - 1) + delta;
  return { year: Math.floor(total / 12), month: (total % 12) + 1 };
}

function toCents(value: string) {
  // aceita "R$ 1.234,56" ou "1234.56" ou "1234,56"
  const cleaned = value
    .replace(/R\$/gi, '')
    .replace(/\s/g, '')
    .replace(/\./g, '')
    .replace(',', '.');
  const number = Number(cleaned);
  if (!Number.isFinite(number)) return null;
  return Math.round(number * 100);
}

export function BillsPage() {
  const { meta } = useMeta();
  const { showToast } = useToast();

  const initial = todayParts();
  const [year, setYear] = useState(initial.year);
  const [month, setMonth] = useState(initial.month);
  const [bills, setBills] = useState<Bill[]>([]);
  const [summary, setSummary] = useState<BillSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [sortKey, setSortKey] = useState<'dueDate' | 'description' | 'amountCents' | 'status' | 'categoryName'>('dueDate');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Bill | null>(null);
  const [form, setForm] = useState({
    description: '',
    amount: '',
    dueDate: '',
    categoryId: 0,
    status: '' as '' | 'AG' | 'PG',
  });
  const [saving, setSaving] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<Bill | null>(null);
  const [deleting, setDeleting] = useState(false);

  const [repeatPrompt, setRepeatPrompt] = useState<{ bill: Bill; existingRepeatId: number | null } | null>(null);
  const [repeating, setRepeating] = useState(false);

  const load = useCallback(async (y: number, m: number) => {
    setLoading(true);
    setError(null);
    try {
      const response = await api.getBills(y, m);
      setBills(response.bills);
      setSummary(response.summary);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  // Sempre volta ao mês corrente ao montar/recarregar.
  useEffect(() => {
    const current = todayParts();
    setYear(current.year);
    setMonth(current.month);
    void load(current.year, current.month);
  }, [load]);

  const reload = useCallback(() => void load(year, month), [load, year, month]);

  const changeMonth = (delta: number) => {
    const next = shiftMonth(year, month, delta);
    setYear(next.year);
    setMonth(next.month);
    void load(next.year, next.month);
  };

  const goCurrent = () => {
    const current = todayParts();
    setYear(current.year);
    setMonth(current.month);
    void load(current.year, current.month);
  };

  const sorted = useMemo(() => {
    const list = [...bills];
    list.sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (av === bv) return 0;
      const cmp = av < bv ? -1 : 1;
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return list;
  }, [bills, sortKey, sortDir]);

  const toggleSort = (key: typeof sortKey) => {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortKey(key);
      setSortDir('asc');
    }
  };

  const openCreate = () => {
    const today = new Date();
    const due = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    setEditing(null);
    setForm({
      description: '',
      amount: '',
      dueDate: due,
      categoryId: meta?.categories[0]?.id ?? 0,
      status: '',
    });
    setModalOpen(true);
  };

  const openEdit = (bill: Bill) => {
    setEditing(bill);
    setForm({
      description: bill.description,
      amount: (bill.amountCents / 100).toFixed(2).replace('.', ','),
      dueDate: bill.dueDate,
      categoryId: bill.categoryId,
      status: bill.status,
    });
    setModalOpen(true);
  };

  const handleSave = async () => {
    const cents = toCents(form.amount);
    if (!form.description.trim()) {
      showToast('Informe a descrição.', 'error');
      return;
    }
    if (cents === null || cents <= 0) {
      showToast('Informe um valor válido e positivo.', 'error');
      return;
    }
    if (!form.dueDate) {
      showToast('Informe o vencimento.', 'error');
      return;
    }
    if (!form.categoryId) {
      showToast('Selecione a categoria.', 'error');
      return;
    }
    setSaving(true);
    try {
      const payload = {
        description: form.description.trim(),
        amountCents: cents,
        dueDate: form.dueDate,
        categoryId: form.categoryId,
        status: form.status,
      };
      if (editing) {
        await api.updateBill(editing.id, payload);
        showToast('Conta atualizada.', 'success');
      } else {
        await api.createBill(payload);
        showToast('Conta criada.', 'success');
      }
      setModalOpen(false);
      await reload();
    } catch (err) {
      showToast(errorMessage(err), 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleStatusChange = async (bill: Bill, status: '' | 'AG' | 'PG') => {
    if (status === bill.status) return;
    try {
      const result = await api.setBillStatus(bill.id, status);
      setBills((prev) => prev.map((b) => (b.id === bill.id ? result.bill : b)));
      if (result.promptRepeat) {
        if (result.existingRepeatId) {
          showToast('Já existe uma repetição vinculada a esta conta.', 'info');
        } else {
          setRepeatPrompt({ bill: result.bill, existingRepeatId: result.existingRepeatId });
        }
      }
      // atualiza resumo
      await reload();
    } catch (err) {
      showToast(errorMessage(err), 'error');
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api.deleteBill(deleteTarget.id);
      showToast('Conta excluída.', 'success');
      setDeleteTarget(null);
      await reload();
    } catch (err) {
      showToast(errorMessage(err), 'error');
    } finally {
      setDeleting(false);
    }
  };

  const handleRepeat = async (answer: boolean) => {
    if (!repeatPrompt) return;
    if (!answer) {
      setRepeatPrompt(null);
      return;
    }
    setRepeating(true);
    try {
      const result = await api.repeatBill(repeatPrompt.bill.id);
      if (result.created) {
        showToast(`Conta repetida para ${formatDateBR(result.bill.dueDate)}.`, 'success');
      } else {
        showToast('Já existia uma conta repetida; exibindo o registro existente.', 'info');
      }
      setRepeatPrompt(null);
      // navega para o mês da nova conta
      const parts = isoToParts(result.bill.dueDate);
      if (parts) {
        setYear(parts.year);
        setMonth(parts.month);
        await load(parts.year, parts.month);
      }
    } catch (err) {
      showToast(errorMessage(err), 'error');
    } finally {
      setRepeating(false);
    }
  };

  const isPastDue = (bill: Bill) =>
    bill.status !== 'PG' && bill.dueDate < new Date().toISOString().slice(0, 10);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Contas a pagar"
        subtitle="Módulo 1 — compromissos mensais. Cadastrar uma conta não cria transação financeira."
      />

      {/* Navegação de mês */}
      <div className="card flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => changeMonth(-1)}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <div className="min-w-[180px] text-center">
            <p className="text-sm font-semibold capitalize text-ink-900 dark:text-white">
              {monthLabel(year, month)}
            </p>
          </div>
          <Button variant="secondary" size="sm" onClick={() => changeMonth(1)}>
            <ChevronRight className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="sm" onClick={goCurrent}>
            Mês atual
          </Button>
        </div>
        <Button size="sm" onClick={openCreate}>
          <Plus className="h-4 w-4" />
          Nova conta
        </Button>
      </div>

      {/* Resumo */}
      {summary && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="card px-4 py-3">
            <p className="text-[11px] uppercase tracking-wide text-ink-400">Total previsto</p>
            <p className="mt-1 text-lg font-semibold text-ink-900 dark:text-white">
              {formatBRL(summary.totalCents)}
            </p>
          </div>
          <div className="card px-4 py-3">
            <p className="text-[11px] uppercase tracking-wide text-ink-400">Ainda não pago</p>
            <p className="mt-1 text-lg font-semibold text-amber-700 dark:text-amber-300">
              {formatBRL(summary.unpaidCents)}
            </p>
            <p className="text-[10px] text-ink-400">
              {summary.counts[''] + summary.counts.AG} conta(s)
            </p>
          </div>
          <div className="card px-4 py-3">
            <p className="text-[11px] uppercase tracking-wide text-ink-400">Pago</p>
            <p className="mt-1 text-lg font-semibold text-emerald-700 dark:text-emerald-300">
              {formatBRL(summary.paidCents)}
            </p>
            <p className="text-[10px] text-ink-400">{summary.counts.PG} conta(s)</p>
          </div>
          <div className="card px-4 py-3">
            <p className="text-[11px] uppercase tracking-wide text-ink-400">Quantidade</p>
            <p className="mt-1 text-lg font-semibold text-ink-900 dark:text-white">{bills.length}</p>
            <p className="text-[10px] text-ink-400">
              AG {summary.counts.AG} · PG {summary.counts.PG} · — {summary.counts['']}
            </p>
          </div>
        </div>
      )}

      {error && (
        <div className="flex items-center gap-2 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-[13px] text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/30 dark:text-rose-300">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      <div className="card overflow-hidden">
        <div className="table-shell max-h-[520px]">
          <table className="w-full min-w-[720px] border-collapse">
            <thead className="sticky top-0 z-10">
              <tr>
                <th className="th cursor-pointer" onClick={() => toggleSort('description')}>Despesa</th>
                <th className="th cursor-pointer text-right" onClick={() => toggleSort('amountCents')}>Valor</th>
                <th className="th cursor-pointer" onClick={() => toggleSort('dueDate')}>Vencimento</th>
                <th className="th">Situação</th>
                <th className="th cursor-pointer" onClick={() => toggleSort('categoryName')}>Categoria</th>
                <th className="th w-[100px] text-right">Ações</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr>
                  <td colSpan={6} className="td text-center text-ink-400">
                    Carregando...
                  </td>
                </tr>
              )}
              {!loading && sorted.length === 0 && (
                <tr>
                  <td colSpan={6} className="td text-center text-ink-400">
                    Nenhuma conta neste mês.
                  </td>
                </tr>
              )}
              {sorted.map((bill) => (
                <tr
                  key={bill.id}
                  className={`transition hover:bg-ink-50/70 dark:hover:bg-ink-800/30 ${
                    isPastDue(bill) ? 'bg-rose-50/40 dark:bg-rose-950/10' : ''
                  }`}
                >
                  <td className="td">
                    <span className="font-medium text-ink-900 dark:text-white">{bill.description}</span>
                    {isPastDue(bill) && (
                      <span className="ml-2 rounded bg-rose-100 px-1 text-[9px] font-semibold uppercase text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">
                        vencida
                      </span>
                    )}
                  </td>
                  <td className="td text-right font-medium">{formatBRL(bill.amountCents)}</td>
                  <td className="td whitespace-nowrap">{formatDateBR(bill.dueDate)}</td>
                  <td className="td">
                    <select
                      className="select h-8 text-[12px]"
                      value={bill.status}
                      onChange={(e) => void handleStatusChange(bill, e.target.value as '' | 'AG' | 'PG')}
                    >
                      <option value="">—</option>
                      <option value="AG">AG</option>
                      <option value="PG">PG</option>
                    </select>
                  </td>
                  <td className="td text-[12px] text-ink-500 dark:text-ink-400">{bill.categoryName}</td>
                  <td className="td text-right">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="sm" onClick={() => openEdit(bill)}>
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setDeleteTarget(bill)}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Modal de cadastro/edição */}
      {modalOpen && (
      <Modal
        title={editing ? 'Editar conta a pagar' : 'Nova conta a pagar'}
        onClose={() => setModalOpen(false)}
      >
        <div className="space-y-3">
          <Field label="Despesa">
            <input
              className="input"
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
            />
          </Field>
          <Field label="Valor (R$)">
            <input
              className="input"
              value={form.amount}
              onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))}
              placeholder="0,00"
            />
          </Field>
          <Field label="Vencimento">
            <input
              type="date"
              className="input"
              value={form.dueDate}
              onChange={(e) => setForm((f) => ({ ...f, dueDate: e.target.value }))}
            />
          </Field>
          <Field label="Categoria">
            <select
              className="select"
              value={form.categoryId}
              onChange={(e) => setForm((f) => ({ ...f, categoryId: Number(e.target.value) }))}
            >
              {(meta?.categories ?? []).map((c: Lookup) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Situação">
            <select
              className="select"
              value={form.status}
              onChange={(e) => setForm((f) => ({ ...f, status: e.target.value as '' | 'AG' | 'PG' }))}
            >
              <option value="">—</option>
              <option value="AG">AG</option>
              <option value="PG">PG</option>
            </select>
          </Field>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" onClick={() => setModalOpen(false)}>
              Cancelar
            </Button>
            <Button onClick={() => void handleSave()} disabled={saving}>
              {saving ? 'Salvando...' : 'Salvar'}
            </Button>
          </div>
        </div>
      </Modal>
      )}

      {deleteTarget && (
      <Modal
        title="Excluir conta"
        onClose={() => setDeleteTarget(null)}
      >
        <p className="text-sm text-ink-600 dark:text-ink-300">
          Excluir "{deleteTarget?.description}"? Esta ação não pode ser desfeita.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setDeleteTarget(null)}>
            Cancelar
          </Button>
          <Button variant="danger" onClick={() => void handleDelete()} disabled={deleting}>
            {deleting ? 'Excluindo...' : 'Excluir'}
          </Button>
        </div>
      </Modal>
      )}

      {repeatPrompt && (
      <Modal
        title="Repetir conta no próximo mês?"
        onClose={() => setRepeatPrompt(null)}
      >
        <p className="text-sm text-ink-600 dark:text-ink-300">
          Deseja repetir "{repeatPrompt?.bill.description}" no mês seguinte?
        </p>
        <p className="mt-1 text-[12px] text-ink-400">
          Será criada uma nova conta com a mesma descrição, valor e categoria, com
          vencimento avançado um mês e situação em branco.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => void handleRepeat(false)} disabled={repeating}>
            Não
          </Button>
          <Button onClick={() => void handleRepeat(true)} disabled={repeating}>
            {repeating ? 'Repetindo...' : 'Sim, repetir'}
          </Button>
        </div>
      </Modal>
      )}

    </div>
  );
}
