import type { ImportBatch, Purchase } from './types';

export type ImportHistoryKind = 'transactions' | 'purchase';
export type ImportHistoryStatus = 'success' | 'partial' | 'warning';

export interface ImportHistoryEntry {
  id: string;
  kind: ImportHistoryKind;
  kindLabel: string;
  date: string;
  title: string;
  subtitle: string;
  quantityLabel: string;
  status: ImportHistoryStatus;
  statusLabel: string;
  statusDetail: string;
  href?: string;
}

function transactionStatus(batch: ImportBatch): {
  status: ImportHistoryStatus;
  label: string;
  detail: string;
} {
  if (batch.importedRows === 0 && batch.totalRows > 0) {
    return {
      status: 'warning',
      label: 'Sem importação',
      detail: 'Nenhuma linha importada',
    };
  }
  if (batch.rejectedRows > 0) {
    return {
      status: 'partial',
      label: 'Parcial',
      detail: `${batch.importedRows} importada(s), ${batch.rejectedRows} rejeitada(s)`,
    };
  }
  return {
    status: 'success',
    label: 'Concluída',
    detail: `${batch.importedRows} linha(s) importada(s)`,
  };
}

/**
 * Combina os lotes de movimentações e as compras já persistidas em uma única
 * linha do tempo. Não cria eventos: cada linha corresponde a um registro que
 * o backend realmente gravou.
 */
export function buildImportHistory(
  batches: ImportBatch[],
  purchases: Purchase[],
): ImportHistoryEntry[] {
  const entries: ImportHistoryEntry[] = batches.map((batch) => {
    const status = transactionStatus(batch);
    return {
      id: `transactions-${batch.id}`,
      kind: 'transactions',
      kindLabel: 'Movimentações',
      date: batch.importedAt,
      title: batch.filename,
      subtitle: `Lote #${batch.id}${batch.templateName ? ` · ${batch.templateName}` : ''}`,
      quantityLabel: `${batch.totalRows} linha(s)`,
      status: status.status,
      statusLabel: status.label,
      statusDetail: status.detail,
    };
  });

  for (const purchase of purchases) {
    if (purchase.id === undefined) continue;
    const itemCount = purchase.itemCount ?? 0;
    entries.push({
      id: `purchase-${purchase.id}`,
      kind: 'purchase',
      kindLabel: 'Compras',
      date: purchase.importedAt ?? '',
      title: purchase.supplierName,
      subtitle: `NFC-e ${purchase.invoiceNumber} · Série ${purchase.series}`,
      quantityLabel: `${itemCount} item(ns)`,
      status: 'success',
      statusLabel: 'Importada',
      statusDetail: 'Documento e itens gravados',
      href: `/compras/${purchase.id}`,
    });
  }

  return entries.sort((left, right) => {
    const leftTime = Date.parse(left.date);
    const rightTime = Date.parse(right.date);
    const timeDiff =
      (Number.isNaN(rightTime) ? 0 : rightTime) - (Number.isNaN(leftTime) ? 0 : leftTime);
    return timeDiff !== 0 ? timeDiff : right.id.localeCompare(left.id);
  });
}
