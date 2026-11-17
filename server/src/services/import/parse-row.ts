/** Interpretação de cada linha: datas, valor, parcelas, transferência e sugestões de categoria. */
import { parseDateValue, type DueDateSource } from '../../lib/dates';
import { deriveDueDateFromPurchase, estimateFirstInstallmentDate, isCashPurchaseText, normalizeTransfer, parseInstallments } from '../../lib/installments';
import { parseAmountToCents } from '../../lib/money';
import { displayName, EMPTY_CATEGORY_NAME } from '../../lib/normalize';
import { type CellMeta, type ColumnMapping, FIELD_LABELS, type FieldIssue, IMPORT_FIELDS, type ImportField, type ParsedImportValues, type PurchaseDateSource, type RowSuggestion, type SheetRow } from './types';
import { cellText } from './workbook';

function rawValue(row: SheetRow, mapping: ColumnMapping, field: ImportField): unknown {
  const index = mapping[field];
  if (index === null || index === undefined || index < 0) return null;
  return row.cells[index] ?? null;
}

export function rawMap(row: SheetRow, mapping: ColumnMapping): Record<ImportField, string> {
  const result = {} as Record<ImportField, string>;
  for (const field of IMPORT_FIELDS) {
    result[field] = cellText(rawValue(row, mapping, field));
  }
  return result;
}

export function parseRowFields(
  fields: {
    purchaseDate: unknown;
    dueDate: unknown;
    description: unknown;
    amount: unknown;
    paymentMethod: unknown;
    installments: unknown;
    category: unknown;
    transfer: unknown;
  },
  options: { installmentsMeta?: CellMeta | null } = {},
): {
  values: ParsedImportValues;
  errors: string[];
  issues: FieldIssue[];
  suggestions: RowSuggestion[];
  installmentNote: string | null;
} {
  const issues: FieldIssue[] = [];
  const errors: string[] = [];
  const push = (field: ImportField, message: string) => {
    issues.push({ field, message });
    errors.push(`${FIELD_LABELS[field]}: ${message}`);
  };

  const purchaseEmpty =
    fields.purchaseDate === null ||
    fields.purchaseDate === undefined ||
    String(fields.purchaseDate).trim() === '';
  const dueEmpty =
    fields.dueDate === null ||
    fields.dueDate === undefined ||
    String(fields.dueDate).trim() === '';

  const purchase = parseDateValue(fields.purchaseDate);
  const due = parseDateValue(fields.dueDate);

  // Data de compra: quando o arquivo não traz valor (coluna ausente ou célula
  // vazia), aplica-se o fallback já usado pela aplicação (vencimento), com
  // origem identificável. Valor presente, porém inválido, continua sendo erro.
  // O fallback só ocorre quando o vencimento veio do arquivo (due.ok).
  let purchaseDate: string | null = null;
  let purchaseDateSource: PurchaseDateSource | null = null;
  if (purchase.ok) {
    purchaseDate = purchase.value;
    purchaseDateSource = 'file';
  } else if (!purchaseEmpty && purchase.error !== 'Data não informada.') {
    push('purchaseDate', purchase.error);
  } else if (due.ok) {
    purchaseDate = due.value;
    purchaseDateSource = 'due_date_fallback';
  }

  const description = displayName(String(fields.description ?? ''));
  if (!description) push('description', 'descrição obrigatória.');
  if (description.length > 500) push('description', 'descrição muito longa (máximo 500).');

  const amount = parseAmountToCents(fields.amount);
  if (!amount.ok) push('amount', amount.error);

  const installments = parseInstallments(fields.installments, {
    meta: options.installmentsMeta ?? null,
    description,
  });
  if (installments.error) push('installments', installments.error);

  const cashPurchase = installments.cashPurchase || isCashPurchaseText(fields.description);
  if (cashPurchase) {
    installments.value = { number: null, total: null };
    installments.source = null;
  }

  // Precedência do vencimento:
  // 1. vencimento informado no arquivo;
  // 2. derivado da data de compra + parcela (ou da própria compra, à vista);
  // 3. caso contrário, ausente (erro).
  let dueDate: string | null = null;
  let dueDateSource: DueDateSource | null = null;

  if (due.ok) {
    dueDate = due.value;
    dueDateSource = 'file';
  } else if (!dueEmpty && due.error !== 'Data não informada.') {
    push('dueDate', due.error);
  } else if (purchase.ok) {
    const installmentNumber = installments.value.number;
    if (cashPurchase) {
      dueDate = purchase.value;
      dueDateSource = 'derived_from_cash_purchase';
    } else {
      const derived = deriveDueDateFromPurchase(purchase.value, installmentNumber);
      dueDate = derived ?? purchase.value;
      dueDateSource =
        installmentNumber !== null
          ? 'estimated_from_installment'
          : 'derived_from_purchase_fallback';
    }
  } else if (dueEmpty && purchaseEmpty) {
    push('dueDate', 'Data de vencimento não informada.');
  }

  // Se vencimento inválido (não vazio) já reportado; se ausente e sem compra, reportado acima.

  const paymentMethodRaw = displayName(String(fields.paymentMethod ?? ''));
  const paymentMethod = paymentMethodRaw ? paymentMethodRaw : null;
  const category = displayName(String(fields.category ?? '')) || EMPTY_CATEGORY_NAME;

  // estimatedFirstInstallmentDate
  let estimatedFirstInstallmentDate: string | null = null;
  if (!cashPurchase) {
    if (dueDateSource === 'file' && due.ok) {
      estimatedFirstInstallmentDate = estimateFirstInstallmentDate(
        due.value,
        installments.value.number,
        installments.value.total,
      );
    } else if (
      (dueDateSource === 'estimated_from_installment' ||
        dueDateSource === 'derived_from_cash_purchase') &&
      purchaseDate
    ) {
      estimatedFirstInstallmentDate = purchaseDate;
    }
  }

  return {
    values: {
      purchaseDate,
      purchaseDateSource,
      dueDate,
      dueDateSource,
      description,
      amountCents: amount.ok ? amount.value : null,
      paymentMethod,
      category,
      installmentNumber: installments.value.number,
      installmentTotal: installments.value.total,
      installmentSource: installments.source,
      installmentOriginal:
        installments.source === 'description' ? (installments.original ?? null) : null,
      estimatedFirstInstallmentDate,
      cashPurchase,
      transfer: normalizeTransfer(fields.transfer),
    },
    errors,
    issues,
    suggestions: installments.suggestions.map((suggestion) => ({
      field: 'installments' as const,
      ...suggestion,
    })),
    installmentNote: installments.note ?? null,
  };
}
