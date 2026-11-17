/**
 * Importação de contas a pagar por planilha: campos, rótulos e a contagem do
 * que será gravado (lógica sem React).
 */
import type { BillImportField, BillImportPreview } from './types';

export const BILL_IMPORT_FIELDS: { field: BillImportField; label: string; required: boolean; hint: string }[] = [
  { field: 'description', label: 'Despesa', required: true, hint: 'Descrição da conta' },
  { field: 'amount', label: 'Valor', required: true, hint: 'R$ 1.250,50; o sinal é ignorado' },
  { field: 'dueDate', label: 'Vencimento', required: true, hint: 'DD/MM/AAAA' },
  { field: 'category', label: 'Categoria', required: false, hint: 'Vazia vira "Sem categoria"' },
  { field: 'status', label: 'Situação', required: false, hint: 'AG = agendada · PG = paga (só avulsa)' },
  { field: 'repeat', label: 'Repetição', required: false, hint: 'Mensal, Trimestral 4x, Mensal, último dia útil…' },
];

export const BILL_STATUS_LABELS: Record<'' | 'AG' | 'PG', string> = { '': 'Em aberto', AG: 'Agendada', PG: 'Paga' };

/** Linhas que a importação vai gravar com as escolhas atuais. */
export function importableRows(
  preview: Pick<BillImportPreview, 'rows'> | null,
  rejected: ReadonlySet<number>,
  skipDuplicates: boolean,
): { total: number; recurring: number } {
  const rows = (preview?.rows ?? []).filter(
    (row) => row.errors.length === 0 && !rejected.has(row.rowNumber) && !(skipDuplicates && row.duplicate),
  );
  return { total: rows.length, recurring: rows.filter((row) => row.values.recurrence !== null).length };
}
