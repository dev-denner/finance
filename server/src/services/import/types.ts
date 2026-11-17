/** Constantes, campos e tipos compartilhados pela prévia e pela gravação da importação. */
import type { DueDateSource } from '../../lib/dates';
import type { CategorySuggestion, CategorySuggestionAlternative } from '../category-matching';
import type { TransferCandidate } from '../transfer-detection';
import type { BillDecision, BillPaymentCandidate } from '../bill-payment-detection';
import type { MappingWarning } from './mapping';

export const IMPORT_FIELDS = [
  'purchaseDate',
  'dueDate',
  'description',
  'amount',
  'paymentMethod',
  'installments',
  'category',
  'transfer',
] as const;

export type ImportField = (typeof IMPORT_FIELDS)[number];
export type ColumnMapping = Partial<Record<ImportField, number | null>>;

export const REQUIRED_FIELDS: ImportField[] = ['description', 'amount'];

export const FIELD_LABELS: Record<ImportField, string> = {
  purchaseDate: 'Data Compra',
  dueDate: 'Vencimento',
  description: 'Compra',
  amount: 'Valor',
  paymentMethod: 'Pagamento',
  installments: 'Parcelas',
  category: 'Categorias',
  transfer: 'Transf',
};

export const MAX_ROWS = 20_000;

export const DEFAULT_TRANSFER_TOLERANCE_DAYS = 3;

export type TransferDecision = 'confirm' | 'reject' | 'pending';

export interface CellMeta {
  type: string;
  format?: string;
  text?: string;
}

export interface SheetRow {
  rowNumber: number;
  cells: unknown[];
  /** Metadados das células (tipo/formato do Excel), na mesma ordem de `cells`. */
  meta: (CellMeta | null)[];
}

export interface ParsedWorkbook {
  filename: string;
  sheetName: string;
  headers: string[];
  rows: SheetRow[];
  mapping: ColumnMapping;
}

export type PurchaseDateSource = 'file' | 'due_date_fallback';

export interface ParsedImportValues {
  purchaseDate: string | null;
  /** Origem da data de compra: arquivo ou derivada do vencimento por fallback. */
  purchaseDateSource: PurchaseDateSource | null;
  dueDate: string | null;
  /** Origem da data de vencimento: arquivo ou derivada da data de compra. */
  dueDateSource: DueDateSource | null;
  description: string;
  amountCents: number | null;
  paymentMethod: string | null;
  category: string;
  cashPurchase: boolean;
  installmentNumber: number | null;
  installmentTotal: number | null;
  installmentSource: 'column' | 'description' | null;
  installmentOriginal: string | null;
  /** Data estimada da primeira parcela (calculada, nunca histórica). */
  estimatedFirstInstallmentDate: string | null;
  transfer: string | null;
}

export interface FieldIssue {
  field: ImportField;
  message: string;
}

export interface RowSuggestion {
  field: ImportField;
  number: number;
  total: number;
  label: string;
}

export interface DuplicateCounterpart {
  source: 'file' | 'database';
  rowNumber: number | null;
  transactionId: number | null;
  purchaseDate: string;
  dueDate: string;
  description: string;
  amountCents: number;
  paymentMethod: string;
  category: string;
  installmentNumber: number | null;
  installmentTotal: number | null;
  importBatchId: number | null;
  importedAt: string | null;
}

export interface DuplicateInfo {
  kind: 'exact' | 'probable';
  source: 'file' | 'database';
  /** Identificador do grupo (linha líder no arquivo ou lançamento no banco). */
  groupKey: string;
  counterpartRowNumber: number | null;
  counterpartTransactionId: number | null;
  counterpart: DuplicateCounterpart;
  reason: string;
}

export interface PreviewRow {
  rowNumber: number;
  raw: Record<ImportField, string>;
  values: ParsedImportValues;
  errors: string[];
  issues: FieldIssue[];
  suggestions: RowSuggestion[];
  installmentNote: string | null;
  duplicate: DuplicateInfo | null;
  categorySuggestion: CategorySuggestion;
}

export interface ImportPreview {
  filename: string;
  sheetName: string;
  headers: string[];
  mapping: ColumnMapping;
  mappingErrors: string[];
  /** Avisos do reconhecimento automático (ambiguidades, colunas sem campo). */
  mappingWarnings: MappingWarning[];
  /** Modelo de mapeamento aplicado automaticamente, quando houver. */
  appliedTemplate: { id: number; name: string } | null;
  totalRows: number;
  validRows: number;
  invalidRows: number;
  duplicateRows: number;
  rows: PreviewRow[];
  transferToleranceDays: number;
  transferCandidates: TransferCandidate[];
  /** Saídas do arquivo que parecem pagar uma conta a pagar em aberto (Módulo 1). */
  billCandidates: BillPaymentCandidate[];
  categorySuggestions: {
    sourceCategory: string;
    sourceNormalized: string;
    count: number;
    targetCategoryId: number | null;
    targetCategoryName: string | null;
    confidence: 'high' | 'medium' | 'low';
    reason: string;
    method: string;
    ambiguous: boolean;
    alternatives: CategorySuggestionAlternative[];
  }[];
}

export interface ImportOverrides {
  [rowNumber: string]: Partial<Record<ImportField, string>>;
}

export type CategoryDecisionAction = 'accept' | 'use' | 'create' | 'reject';

export interface CategoryDecision {
  action: CategoryDecisionAction;
  sourceCategory?: string | null;
  targetCategoryId?: number | null;
  newCategoryName?: string | null;
  /** false quando a decisão foi apenas o padrão da UI (não confirmada pelo usuário). */
  confirmed?: boolean;
}

export type CategoryDecisions = Record<string, CategoryDecision>;

export interface ImportOptions {
  mapping: ColumnMapping;
  destinationPaymentMethodId?: number | null;
  categoryDecisions?: CategoryDecisions | CategoryDecision[];
  overrides?: ImportOverrides;
  skipDuplicates?: boolean;
  rejectedRows?: number[];
  /**
   * Linhas que o usuário escolheu importar mesmo sendo duplicatas exatas.
   * Quando presente, o servidor é a autoridade: duplicata exata só entra se
   * estiver nesta lista. Ausente, vale a semântica legada de `skipDuplicates`.
   */
  includedDuplicateRows?: number[];
  transferToleranceDays?: number;
  transferDecisions?: Record<string, TransferDecision>;
  /**
   * Decisões sobre os pagamentos de contas sugeridos na prévia. Sem decisão
   * explícita, nada é vinculado.
   */
  billDecisions?: Record<string, BillDecision>;
  /** Modelo de mapeamento aplicado nesta importação (registra no lote). */
  templateId?: number;
}

export interface ImportSummary {
  batchId: number;
  filename: string;
  totalRows: number;
  importedRows: number;
  rejectedRows: number;
  duplicateRows: number;
  skippedDuplicates: number;
  invalidRows: number;
  explicitRejections: number;
  createdCategories: string[];
  createdPaymentMethods: string[];
  duplicateRowsInPreview: number;
  transferCandidates: number;
  confirmedTransfers: number;
  pendingTransfers: number;
  rejectedTransfers: number;
  billCandidates: number;
  linkedBillPayments: number;
  pendingBillPayments: number;
  rejectedBillPayments: number;
  /** Confirmações que não puderam virar vínculo, com o motivo. */
  skippedBillPayments: { rowNumber: number | null; billDescription: string; reason: string }[];
  ignoredRows: number;
  firstDueDate: string | null;
  lastDueDate: string | null;
  errors: { rowNumber: number; errors: string[] }[];
}

export interface PreviewOptions {
  destinationPaymentMethodId?: number | null;
  categoryDecisions?: CategoryDecisions | CategoryDecision[];
}
