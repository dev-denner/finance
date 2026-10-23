import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowLeft,
  CheckCircle2,
  ExternalLink,
  Search,
  ShoppingCart,
} from 'lucide-react';
import { ApiError, api } from '../lib/api';
import { formatBRL, formatDateTimeBR } from '../lib/format';
import type { Purchase } from '../lib/types';
import { Button } from '../components/ui/Button';
import { PageHeader } from '../components/ui/Page';

function errorText(error: unknown): string {
  return error instanceof ApiError ? error.message : 'Não foi possível concluir a operação.';
}

export function NfceImportPage() {
  const [url, setUrl] = useState('');
  const [previewedUrl, setPreviewedUrl] = useState('');
  const [preview, setPreview] = useState<Purchase | null>(null);
  const [alreadyImported, setAlreadyImported] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [importedId, setImportedId] = useState<number | null>(null);

  async function previewUrl(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = url.trim();
    setLoading(true);
    setError('');
    setNotice('');
    setImportedId(null);
    setPreview(null);
    setPreviewedUrl('');
    try {
      const result = await api.previewPurchase(trimmed);
      setPreview(result.purchase);
      setAlreadyImported(result.alreadyImported);
      setPreviewedUrl(trimmed);
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setLoading(false);
    }
  }

  async function importCurrent() {
    if (!previewedUrl) return;
    setLoading(true);
    setError('');
    setNotice('');
    try {
      const result = await api.importPurchase(previewedUrl);
      setNotice(
        result.duplicate
          ? 'Esta NFC-e já estava na lista de compras.'
          : 'Compra importada com sucesso.',
      );
      setImportedId(result.id);
      setPreview(null);
      setUrl('');
      setPreviewedUrl('');
      setAlreadyImported(false);
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Importar NFC-e"
        subtitle="Consulte a NFC-e do RJ pelo QR Code, revise os itens e confirme a compra."
        actions={
          <>
            <Link to="/compras" className="btn-secondary">
              <ShoppingCart className="h-3.5 w-3.5" />
              Ver compras
            </Link>
            <Link to="/importacoes" className="btn-secondary">
              <ArrowLeft className="h-3.5 w-3.5" />
              Voltar para Importações
            </Link>
          </>
        }
      />

      <form onSubmit={previewUrl} className="card mb-2 flex flex-col gap-3 p-4 sm:flex-row">
        <label className="sr-only" htmlFor="nfce-url">
          URL do QR Code da NFC-e
        </label>
        <input
          id="nfce-url"
          type="url"
          required
          maxLength={2048}
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="Cole a URL do QR Code da NFC-e do RJ"
          className="input min-w-0 flex-1"
        />
        <Button type="submit" variant="primary" loading={loading}>
          <Search className="h-4 w-4" />
          Buscar prévia
        </Button>
      </form>
      <p className="mb-5 text-xs text-ink-400">
        A consulta usa o portal oficial da SEFAZ-RJ. Nenhuma movimentação financeira é criada
        ou alterada.
      </p>

      {error && (
        <p
          role="alert"
          className="mb-4 rounded-lg bg-rose-50 p-3 text-sm text-rose-700 dark:bg-rose-950/30 dark:text-rose-300"
        >
          {error}
        </p>
      )}
      {notice && (
        <div
          role="status"
          className="mb-4 flex flex-wrap items-center gap-2 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300"
        >
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          <span className="flex-1">{notice}</span>
          {importedId !== null && (
            <Link
              to={`/compras/${importedId}`}
              className="inline-flex items-center gap-1 font-medium text-emerald-800 hover:text-emerald-700 dark:text-emerald-200 dark:hover:text-emerald-100"
            >
              Abrir compra
              <ExternalLink className="h-3.5 w-3.5" />
            </Link>
          )}
        </div>
      )}

      {preview && (
        <section className="card mb-6 p-4" aria-labelledby="nfce-preview-title">
          <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 id="nfce-preview-title" className="text-base font-semibold">
                Prévia da compra
              </h2>
              <p className="mt-1 text-sm text-ink-500">
                {preview.supplierName} · NFC-e {preview.invoiceNumber} ·{' '}
                {formatDateTimeBR(preview.issuedAt)}
              </p>
            </div>
            <Button
              variant="primary"
              loading={loading}
              disabled={alreadyImported}
              onClick={() => void importCurrent()}
            >
              {alreadyImported ? 'Já importada' : 'Importar compra'}
            </Button>
          </div>
          <div className="mb-4 flex flex-wrap gap-x-6 gap-y-2 text-sm">
            <span>CNPJ: {preview.supplierCnpj}</span>
            <span>
              Total: <strong>{formatBRL(preview.totalCents)}</strong>
            </span>
            <span>Pagamento: {preview.paymentMethod ?? 'Não informado'}</span>
            <span>{preview.items?.length ?? 0} itens</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-ink-500">
                <tr>
                  <th className="py-2">Descrição</th>
                  <th className="py-2">Qtd.</th>
                  <th className="py-2">Un.</th>
                  <th className="py-2 text-right">Unitário</th>
                  <th className="py-2 text-right">Desconto</th>
                  <th className="py-2 text-right">Total</th>
                </tr>
              </thead>
              <tbody>
                {preview.items?.map((item, index) => (
                  <tr
                    key={item.id ?? index}
                    className="border-t border-ink-100 dark:border-ink-800"
                  >
                    <td className="py-2">{item.description}</td>
                    <td className="py-2">{item.quantity}</td>
                    <td className="py-2">{item.unit}</td>
                    <td className="py-2 text-right">{formatBRL(item.unitPriceCents)}</td>
                    <td className="py-2 text-right">
                      {item.discountCents === null ? '—' : formatBRL(item.discountCents)}
                    </td>
                    <td className="py-2 text-right">{formatBRL(item.totalCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {alreadyImported && (
            <p className="mt-3 text-xs text-amber-600">
              A chave de acesso já consta nas compras salvas.
            </p>
          )}
        </section>
      )}
    </div>
  );
}
