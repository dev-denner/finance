import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  ExternalLink,
  FileUp,
  PackageSearch,
  RefreshCw,
  Search,
} from 'lucide-react';
import { ApiError, api } from '../lib/api';
import type { Purchase } from '../lib/types';
import { formatBRL, formatDateTimeBR } from '../lib/format';
import { Button } from '../components/ui/Button';
import { EmptyState, PageHeader, Spinner } from '../components/ui/Page';

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
  const [purchase, setPurchase] = useState<Purchase | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

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
        if (active) setPurchase(result);
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
  }, [id, valid]);

  const backAction = (
    <Link to="/compras" className="btn-secondary">
      <ArrowLeft className="h-4 w-4" />
      Voltar às compras
    </Link>
  );
  const importAction = (
    <Link to="/importacoes/nfce" className="btn-primary">
      <FileUp className="h-4 w-4" />
      Importar NFC-e
    </Link>
  );

  if (loading) {
    return (
      <>
        <PageHeader title="Compra" actions={<>{backAction}{importAction}</>} />
        <Spinner label="Carregando compra..." />
      </>
    );
  }

  if (error || !purchase) {
    return (
      <>
        <PageHeader title="Compra" actions={<>{backAction}{importAction}</>} />
        <div className="card p-4">
          <p
            role="alert"
            className="rounded-lg bg-rose-50 p-3 text-sm text-rose-700 dark:bg-rose-950/30 dark:text-rose-300"
          >
            {error || 'Compra não encontrada.'}
          </p>
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={purchase.supplierName}
        subtitle={`NFC-e ${purchase.invoiceNumber} • Série ${purchase.series} • ${formatDateTimeBR(purchase.issuedAt)}`}
        actions={<>{backAction}{importAction}</>}
      />

      <section className="card mb-5 grid gap-4 p-4 sm:grid-cols-2 xl:grid-cols-4">
        <div>
          <p className="text-xs text-ink-400">CNPJ do fornecedor</p>
          <p className="mt-1 text-sm font-medium">{purchase.supplierCnpj}</p>
        </div>
        <div>
          <p className="text-xs text-ink-400">Total</p>
          <p className="mt-1 text-sm font-semibold">{formatBRL(purchase.totalCents)}</p>
        </div>
        <div>
          <p className="text-xs text-ink-400">Forma de pagamento</p>
          <p className="mt-1 text-sm">{purchase.paymentMethod ?? 'Não informada'}</p>
        </div>
        <div>
          <p className="text-xs text-ink-400">Importada em</p>
          <p className="mt-1 text-sm">
            {purchase.importedAt ? formatDateTimeBR(purchase.importedAt) : '—'}
          </p>
        </div>
        <div className="sm:col-span-2 xl:col-span-4">
          <p className="text-xs text-ink-400">Chave de acesso</p>
          <p className="mt-1 break-all font-mono text-xs">{purchase.accessKey}</p>
        </div>
      </section>

      <section className="card overflow-hidden">
        <div className="border-b border-ink-200 px-4 py-3 dark:border-ink-800">
          <h2 className="text-sm font-semibold">Itens da compra</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="bg-ink-50 text-xs text-ink-500 dark:bg-ink-900">
              <tr>
                <th className="px-4 py-3">Descrição</th>
                <th className="px-4 py-3">Qtd.</th>
                <th className="px-4 py-3">Un.</th>
                <th className="px-4 py-3 text-right">Unitário</th>
                <th className="px-4 py-3 text-right">Desconto</th>
                <th className="px-4 py-3 text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {purchase.items?.map((item, index) => (
                <tr
                  key={item.id ?? index}
                  className="border-t border-ink-100 dark:border-ink-800"
                >
                  <td className="px-4 py-3">{item.description}</td>
                  <td className="px-4 py-3">{item.quantity}</td>
                  <td className="px-4 py-3">{item.unit}</td>
                  <td className="px-4 py-3 text-right">{formatBRL(item.unitPriceCents)}</td>
                  <td className="px-4 py-3 text-right">
                    {item.discountCents === null ? '—' : formatBRL(item.discountCents)}
                  </td>
                  <td className="px-4 py-3 text-right font-medium">
                    {formatBRL(item.totalCents)}
                  </td>
                </tr>
              ))}
              {(purchase.items?.length ?? 0) === 0 && (
                <tr>
                  <td className="px-4 py-6 text-center text-ink-400" colSpan={6}>
                    Nenhum item registrado.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

function PurchaseList() {
  const [query, setQuery] = useState('');
  const [purchases, setPurchases] = useState<Purchase[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [error, setError] = useState('');

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

  const filteredPurchases = useMemo(
    () => purchases.filter((purchase) => purchaseMatches(purchase, query)),
    [purchases, query],
  );

  return (
    <>
      <PageHeader
        title="Compras"
        subtitle="Consulte as compras importadas, filtre por fornecedor ou nota e abra os detalhes."
        actions={
          <>
            <Link to="/importacoes" className="btn-secondary">
              <ArrowLeft className="h-4 w-4" />
              Importações
            </Link>
            <Link to="/importacoes/nfce" className="btn-primary">
              <FileUp className="h-4 w-4" />
              Importar NFC-e
            </Link>
          </>
        }
      />

      {error && (
        <div
          role="alert"
          className="mb-4 flex flex-wrap items-center gap-2 rounded-lg bg-rose-50 p-3 text-sm text-rose-700 dark:bg-rose-950/30 dark:text-rose-300"
        >
          <span className="min-w-[200px] flex-1">{error}</span>
          <Button size="sm" variant="secondary" onClick={() => void refresh()}>
            <RefreshCw className="h-3.5 w-3.5" />
            Tentar novamente
          </Button>
        </div>
      )}

      {!listLoading && purchases.length > 0 && (
        <div className="card mb-4 flex flex-col gap-2 p-3 sm:flex-row sm:items-center">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400" />
            <input
              className="input pl-9"
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Buscar por fornecedor, CNPJ, nota ou série"
              aria-label="Filtrar compras"
            />
          </div>
          <span className="text-[11px] text-ink-400">
            {filteredPurchases.length} de {purchases.length} compra(s)
          </span>
        </div>
      )}

      {listLoading ? (
        <Spinner label="Carregando compras..." />
      ) : purchases.length === 0 ? (
        error ? null : (
          <div className="card">
            <EmptyState
              icon={PackageSearch}
              title="Nenhuma compra importada"
              description="Use a área de Importações para consultar e revisar a primeira NFC-e."
              action={
                <Link to="/importacoes/nfce" className="btn-primary">
                  <FileUp className="h-4 w-4" />
                  Importar NFC-e
                </Link>
              }
            />
          </div>
        )
      ) : filteredPurchases.length === 0 ? (
        <div className="card">
          <EmptyState
            icon={Search}
            title="Nenhuma compra encontrada"
            description="Ajuste a busca para encontrar a compra pelo fornecedor, CNPJ, número ou série da nota."
            action={
              <Button variant="secondary" onClick={() => setQuery('')}>
                Limpar busca
              </Button>
            }
          />
        </div>
      ) : (
        <div className="card divide-y divide-ink-100 dark:divide-ink-800">
          {filteredPurchases.map((purchase) => (
            <Link
              key={purchase.id}
              to={`/compras/${purchase.id}`}
              className="flex flex-wrap items-center justify-between gap-3 p-4 transition hover:bg-ink-50 dark:hover:bg-ink-900/60"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{purchase.supplierName}</p>
                <p className="mt-1 text-xs text-ink-500">
                  NFC-e {purchase.invoiceNumber} · {formatDateTimeBR(purchase.issuedAt)} ·{' '}
                  {purchase.itemCount ?? 0} itens
                </p>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-sm font-semibold">{formatBRL(purchase.totalCents)}</span>
                <ExternalLink className="h-4 w-4 text-ink-400" />
              </div>
            </Link>
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
