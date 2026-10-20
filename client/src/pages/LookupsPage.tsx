import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  AlertTriangle,
  Check,
  CreditCard,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Tags,
  Trash2,
  X,
} from 'lucide-react';
import { Button } from '../components/ui/Button';
import { Field } from '../components/ui/Field';
import { Modal } from '../components/ui/Modal';
import { EmptyState, PageHeader } from '../components/ui/Page';
import { useMeta } from '../context/MetaContext';
import { useToast } from '../context/ToastContext';
import { api, errorMessage } from '../lib/api';
import { CATEGORY_PALETTE, categoryColorHex, formatDateBR } from '../lib/format';
import type { CategoryClassification, Lookup } from '../lib/types';

type Kind = 'category' | 'payment';

const CLASSIFICATION_OPTIONS: {
  value: CategoryClassification;
  label: string;
  description: string;
}[] = [
  { value: 'expense', label: 'Despesa', description: 'Entra nas despesas do consolidado.' },
  { value: 'income', label: 'Receita', description: 'Entra nas receitas do consolidado.' },
  {
    value: 'transfer',
    label: 'Transferência interna',
    description: 'Não infla receitas/despesas; aparece em transferências.',
  },
  {
    value: 'card_settlement',
    label: 'Pagamento de cartão',
    description: 'Sai do caixa, mas não duplica as compras já lançadas.',
  },
  {
    value: 'mixed',
    label: 'Mista / ambígua',
    description: 'Mantém o comportamento padrão por sinal do valor.',
  },
];

const CLASSIFICATION_LABELS: Record<CategoryClassification, string> = {
  expense: 'Despesa',
  income: 'Receita',
  transfer: 'Transferência interna',
  card_settlement: 'Pagamento de cartão',
  mixed: 'Mista / ambígua',
};

const KIND_INFO: Record<
  Kind,
  { title: string; singular: string; description: string; placeholder: string }
> = {
  category: {
    title: 'Categorias',
    singular: 'categoria',
    description:
      'Agrupam os lançamentos no consolidado anual. Categorias novas também são criadas automaticamente durante a importação.',
    placeholder: 'Ex.: Mercado, Moradia, Saúde',
  },
  payment: {
    title: 'Contas e meios de pagamento',
    singular: 'forma de pagamento',
    description:
      'Identificam como cada lançamento foi pago. Novas formas também são criadas automaticamente durante a importação.',
    placeholder: 'Ex.: Cartão Nubank, Pix, Conta corrente',
  },
};

export function LookupsPage() {
  const { meta, loading, error: metaError, refresh } = useMeta();
  const { showToast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const kind: Kind = searchParams.get('tipo') === 'pagamento' ? 'payment' : 'category';
  const info = KIND_INFO[kind];

  const items = useMemo(
    () => (kind === 'category' ? meta?.categories : meta?.paymentMethods) ?? [],
    [kind, meta],
  );

  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState('');
  const [newClassification, setNewClassification] = useState<CategoryClassification | ''>('');
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<{
    id: number;
    name: string;
    color: string;
    classification: CategoryClassification | '';
  } | null>(null);
  const [savingRename, setSavingRename] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Lookup | null>(null);
  const [reassignTo, setReassignTo] = useState<number>(0);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    setEditing(null);
    setNewName('');
    setNewColor('');
    setNewClassification('');
    setDeleteTarget(null);
  }, [kind]);

  const otherItems = useMemo(
    () => (deleteTarget ? items.filter((item) => item.id !== deleteTarget.id) : []),
    [deleteTarget, items],
  );

  const changeKind = (next: Kind) => {
    setSearchParams(next === 'payment' ? { tipo: 'pagamento' } : {}, { replace: true });
  };

  const addItem = async () => {
    const name = newName.trim();
    if (!name) return;
    setAdding(true);
    try {
      await api.createLookup(
        kind,
        name,
        kind === 'category' ? newColor || null : undefined,
        kind === 'category' ? newClassification || null : undefined,
      );
      setNewName('');
      setNewColor('');
      setNewClassification('');
      await refresh();
      showToast(`${kind === 'category' ? 'Categoria' : 'Forma de pagamento'} criada.`);
    } catch (err) {
      showToast(errorMessage(err), 'error');
    } finally {
      setAdding(false);
    }
  };

  const saveRename = async () => {
    if (!editing) return;
    const name = editing.name.trim();
    if (!name) return;
    setSavingRename(true);
    try {
      await api.renameLookup(
        kind,
        editing.id,
        name,
        kind === 'category' ? editing.color || null : undefined,
        kind === 'category' ? editing.classification || null : undefined,
      );
      setEditing(null);
      await refresh();
      showToast('Registro atualizado.');
    } catch (err) {
      showToast(errorMessage(err), 'error');
    } finally {
      setSavingRename(false);
    }
  };

  const openDelete = (item: Lookup) => {
    setDeleteTarget(item);
    const firstOther = items.find((entry) => entry.id !== item.id);
    setReassignTo(firstOther?.id ?? 0);
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    if (deleteTarget.usageCount > 0 && !reassignTo) {
      showToast('Escolha um registro de destino para reatribuir os lançamentos.', 'error');
      return;
    }
    setDeleting(true);
    try {
      const response = await api.deleteLookup(
        kind,
        deleteTarget.id,
        deleteTarget.usageCount > 0 ? reassignTo : undefined,
      );
      setDeleteTarget(null);
      await refresh();
      showToast(
        response.reassigned > 0
          ? `Registro excluído. ${response.reassigned} lançamento(s) reatribuído(s).`
          : 'Registro excluído.',
      );
    } catch (err) {
      showToast(errorMessage(err), 'error');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="Cadastros"
        subtitle="Gerencie as categorias e formas de pagamento usadas nos lançamentos."
        actions={
          <Button variant="secondary" onClick={() => void refresh()} disabled={loading}>
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            Atualizar
          </Button>
        }
      />

      <div className="mb-4 inline-flex rounded-lg border border-ink-200 bg-ink-50 p-0.5 dark:border-ink-700 dark:bg-ink-950/50">
        <button
          type="button"
          onClick={() => changeKind('category')}
          className={`flex items-center gap-2 rounded-md px-3 py-1.5 text-[12px] font-medium transition ${
            kind === 'category'
              ? 'bg-white text-ink-900 shadow-sm dark:bg-ink-800 dark:text-white'
              : 'text-ink-500 hover:text-ink-800 dark:text-ink-400 dark:hover:text-white'
          }`}
        >
          <Tags className="h-3.5 w-3.5" />
          Categorias
          <span className="rounded-full bg-ink-100 px-1.5 text-[10px] text-ink-500 dark:bg-ink-700 dark:text-ink-300">
            {meta?.categories.length ?? 0}
          </span>
        </button>
        <button
          type="button"
          onClick={() => changeKind('payment')}
          className={`flex items-center gap-2 rounded-md px-3 py-1.5 text-[12px] font-medium transition ${
            kind === 'payment'
              ? 'bg-white text-ink-900 shadow-sm dark:bg-ink-800 dark:text-white'
              : 'text-ink-500 hover:text-ink-800 dark:text-ink-400 dark:hover:text-white'
          }`}
        >
          <CreditCard className="h-3.5 w-3.5" />
          Contas e pagamentos
          <span className="rounded-full bg-ink-100 px-1.5 text-[10px] text-ink-500 dark:bg-ink-700 dark:text-ink-300">
            {meta?.paymentMethods.length ?? 0}
          </span>
        </button>
      </div>

      {metaError && (
        <div className="mb-4 flex items-center gap-2 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-[13px] text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/30 dark:text-rose-300">
          <AlertTriangle className="h-4 w-4" />
          {metaError}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="card overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-ink-200 px-4 py-3.5 dark:border-ink-800">
            <div>
              <h2 className="text-sm font-semibold text-ink-900 dark:text-white">{info.title}</h2>
              <p className="text-[11px] text-ink-400">
                {items.length} registro(s) · renomeie sem perder os vínculos existentes
              </p>
            </div>
          </div>

          {loading && !meta ? (
            <div className="flex items-center justify-center gap-2 py-14 text-[13px] text-ink-400">
              <Loader2 className="h-4 w-4 animate-spin" />
              Carregando cadastros...
            </div>
          ) : items.length === 0 ? (
            <EmptyState
              icon={kind === 'category' ? Tags : CreditCard}
              title={`Nenhuma ${kind === 'category' ? 'categoria' : 'forma de pagamento'} cadastrada`}
              description="Use o formulário ao lado ou importe uma planilha para criar os registros automaticamente."
            />
          ) : (
            <table className="w-full">
              <thead>
                <tr>
                  <th className="th">Nome</th>
                  <th className="th w-[130px] text-right">Em uso</th>
                  <th className="th w-[130px]">Criado em</th>
                  <th className="th w-[110px] text-right">Ações</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => {
                  const isEditing = editing?.id === item.id;
                  return (
                    <tr
                      key={item.id}
                      className="group hover:bg-ink-50/70 dark:hover:bg-ink-800/30"
                    >
                      <td className="td">
                        {isEditing && editing ? (
                          <div className="flex items-center gap-2">
                            {kind === 'category' && (
                              <input
                                type="color"
                                className="h-8 w-9 shrink-0 cursor-pointer rounded border border-ink-200 bg-transparent p-0.5 dark:border-ink-700"
                                value={editing.color || CATEGORY_PALETTE[0]}
                                onChange={(event) =>
                                  setEditing({ ...editing, color: event.target.value })
                                }
                                aria-label="Cor da categoria"
                              />
                            )}
                            <input
                              className="input h-8 max-w-sm text-[13px]"
                              value={editing.name}
                              onChange={(event) =>
                                setEditing({ ...editing, name: event.target.value })
                              }
                              onKeyDown={(event) => {
                                if (event.key === 'Enter') void saveRename();
                                if (event.key === 'Escape') setEditing(null);
                              }}
                              autoFocus
                            />
                            {kind === 'category' && (
                              <select
                                className="select h-8 max-w-[155px] text-[12px]"
                                value={editing.classification}
                                onChange={(event) =>
                                  setEditing({
                                    ...editing,
                                    classification: event.target.value as
                                      | CategoryClassification
                                      | '',
                                  })
                                }
                                aria-label="Classificação da categoria"
                              >
                                <option value="">Não classificada</option>
                                {CLASSIFICATION_OPTIONS.map((option) => (
                                  <option key={option.value} value={option.value}>
                                    {option.label}
                                  </option>
                                ))}
                              </select>
                            )}
                            {kind === 'category' && editing.color && (
                              <button
                                type="button"
                                className="text-[11px] font-medium text-ink-400 underline-offset-2 hover:text-ink-700 hover:underline dark:hover:text-ink-200"
                                onClick={() => setEditing({ ...editing, color: '' })}
                              >
                                Automática
                              </button>
                            )}
                            <button
                              type="button"
                              className="icon-btn text-emerald-600"
                              onClick={() => void saveRename()}
                              disabled={savingRename}
                              aria-label="Salvar nome"
                            >
                              {savingRename ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : (
                                <Check className="h-4 w-4" />
                              )}
                            </button>
                            <button
                              type="button"
                              className="icon-btn"
                              onClick={() => setEditing(null)}
                              disabled={savingRename}
                              aria-label="Cancelar"
                            >
                              <X className="h-4 w-4" />
                            </button>
                          </div>
                        ) : (
                          <div className="flex items-center gap-2">
                            {kind === 'category' && (
                              <span
                                className="h-2.5 w-2.5 shrink-0 rounded-full"
                                style={{ backgroundColor: categoryColorHex(item.id, item.color) }}
                              />
                            )}
                            <div>
                              <p className="font-medium text-ink-800 dark:text-ink-100">
                                {item.name}
                              </p>
                              <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                                <p className="text-[10px] text-ink-400">{item.normalizedName}</p>
                                {kind === 'category' && item.classification && (
                                  <span
                                    className={`rounded px-1.5 py-0.5 text-[9px] font-medium ${
                                      item.classification === 'transfer'
                                        ? 'bg-violet-50 text-violet-700 dark:bg-violet-950/40 dark:text-violet-300'
                                        : item.classification === 'card_settlement'
                                          ? 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300'
                                          : 'bg-ink-100 text-ink-500 dark:bg-ink-800 dark:text-ink-300'
                                    }`}
                                  >
                                    {CLASSIFICATION_LABELS[item.classification]}
                                  </span>
                                )}
                              </div>
                            </div>
                          </div>
                        )}
                      </td>
                      <td className="td text-right">
                        <span
                          className={`badge ${
                            item.usageCount > 0
                              ? 'bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300'
                              : 'bg-ink-100 text-ink-500 dark:bg-ink-800 dark:text-ink-400'
                          }`}
                        >
                          {item.usageCount} lançamento(s)
                        </span>
                      </td>
                      <td className="td whitespace-nowrap text-ink-500 dark:text-ink-400">
                        {formatDateBR(item.createdAt)}
                      </td>
                      <td className="td">
                        <div className="flex justify-end gap-0.5 opacity-60 transition group-hover:opacity-100">
                          <button
                            type="button"
                            className="icon-btn"
                            onClick={() =>
                              setEditing({
                                id: item.id,
                                name: item.name,
                                color: item.color ?? '',
                                classification: item.classification ?? '',
                              })
                            }
                            aria-label={`Renomear ${item.name}`}
                            title="Renomear"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            className="icon-btn hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-950/40"
                            onClick={() => openDelete(item)}
                            aria-label={`Excluir ${item.name}`}
                            title="Excluir"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        <div className="space-y-4">
          <div className="card p-4">
            <h2 className="text-sm font-semibold text-ink-900 dark:text-white">
              Nova {kind === 'category' ? 'categoria' : 'forma de pagamento'}
            </h2>
            <p className="mt-1 text-[11px] leading-relaxed text-ink-400">{info.description}</p>
            <div className="mt-3">
              <Field label="Nome">
                <input
                  className="input"
                  value={newName}
                  placeholder={info.placeholder}
                  onChange={(event) => setNewName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void addItem();
                  }}
                  maxLength={120}
                />
              </Field>
              {kind === 'category' && (
                <>
                  <Field
                    label="Cor da categoria"
                    hint="Opcional. Sem cor definida, uma cor padrão é aplicada automaticamente."
                  >
                    <div className="flex items-center gap-2">
                      <input
                        type="color"
                        className="h-9 w-11 shrink-0 cursor-pointer rounded border border-ink-200 bg-transparent p-0.5 dark:border-ink-700"
                        value={newColor || CATEGORY_PALETTE[0]}
                        onChange={(event) => setNewColor(event.target.value)}
                        aria-label="Cor da nova categoria"
                      />
                      <span className="text-[11px] text-ink-400">
                        {newColor ? newColor : 'Automática'}
                      </span>
                      {newColor && (
                        <button
                          type="button"
                          className="ml-auto text-[11px] font-medium text-ink-400 underline-offset-2 hover:text-ink-700 hover:underline dark:hover:text-ink-200"
                          onClick={() => setNewColor('')}
                        >
                          Usar automática
                        </button>
                      )}
                    </div>
                  </Field>
                  <Field
                    label="Classificação (opcional)"
                    hint={
                      CLASSIFICATION_OPTIONS.find(
                        (option) => option.value === newClassification,
                      )?.description ??
                      'Sem classificação, o consolidado continua usando o sinal do valor.'
                    }
                  >
                    <select
                      className="select"
                      value={newClassification}
                      onChange={(event) =>
                        setNewClassification(event.target.value as CategoryClassification | '')
                      }
                    >
                      <option value="">Não classificada</option>
                      {CLASSIFICATION_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </Field>
                </>
              )}
              <Button
                variant="primary"
                className="mt-3 w-full"
                onClick={() => void addItem()}
                loading={adding}
                disabled={!newName.trim()}
              >
                <Plus className="h-4 w-4" />
                Cadastrar
              </Button>
            </div>
          </div>

          <div className="rounded-xl border border-ink-200 bg-ink-50/60 p-3.5 text-[11px] leading-relaxed text-ink-500 dark:border-ink-800 dark:bg-ink-950/30 dark:text-ink-400">
            <p className="mb-1 font-semibold text-ink-700 dark:text-ink-200">
              Sobre a exclusão
            </p>
            <p>
              Registros em uso não podem ser excluídos sem reatribuição. Ao excluir, escolha um
              destino para que nenhum lançamento fique com referência inválida.
            </p>
          </div>
        </div>
      </div>

      {deleteTarget && (
        <Modal
          title={`Excluir ${info.singular}`}
          description={deleteTarget.name}
          size="sm"
          onClose={() => setDeleteTarget(null)}
          footer={
            <>
              <Button onClick={() => setDeleteTarget(null)} disabled={deleting}>
                Cancelar
              </Button>
              <Button
                variant="danger"
                onClick={() => void confirmDelete()}
                loading={deleting}
                disabled={deleteTarget.usageCount > 0 && !reassignTo}
              >
                Excluir
              </Button>
            </>
          }
        >
          <div className="space-y-3 text-[13px] leading-relaxed text-ink-600 dark:text-ink-300">
            {deleteTarget.usageCount === 0 ? (
              <p>
                Este registro não está em uso. Deseja realmente excluí-lo? Esta ação não pode ser
                desfeita.
              </p>
            ) : (
              <>
                <p>
                  Este registro está em uso por{' '}
                  <strong className="text-ink-900 dark:text-white">
                    {deleteTarget.usageCount}
                  </strong>{' '}
                  lançamento(s). Escolha um registro de destino para reatribuí-los antes de
                  excluir.
                </p>
                {otherItems.length === 0 ? (
                  <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
                    Não há outro registro cadastrado. Cadastre um novo destino antes de excluir
                    este.
                  </p>
                ) : (
                  <Field label="Reatribuir lançamentos para" required>
                    <select
                      className="select"
                      value={reassignTo}
                      onChange={(event) => setReassignTo(Number(event.target.value))}
                    >
                      <option value={0}>Selecione...</option>
                      {otherItems.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                )}
                <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
                  Os {deleteTarget.usageCount} lançamento(s) serão movidos para o destino escolhido
                  e o registro atual será excluído.
                </p>
              </>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}
