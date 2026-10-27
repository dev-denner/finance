export type CategoryClassification =
  | 'expense'
  | 'income'
  | 'transfer'
  | 'card_settlement'
  | 'mixed';

export interface Lookup {
  id: number;
  name: string;
  normalizedName: string;
  color: string | null;
  classification: CategoryClassification | null;
  balanceType?: 'credit' | 'debit' | 'wallet' | 'unclassified';
  balanceCents?: number;
  usageCount: number;
  createdAt: string;
}

export interface PaymentBalanceHistory {
  account: { id: number; name: string; balanceType: 'credit' | 'debit' | 'wallet' | 'unclassified' };
  balance: { balanceType: string; balanceCents: number; minimumBalanceCents: number; minimumBalanceDate: string | null };
  events: Array<{ id: number; effectiveDate: string; amountCents: number; reason: string; description: string; kind: string; reversedAt: string | null }>;
}

export interface PurchaseItem {
  id?: number;
  categoryId?: number | null;
  categoryName?: string | null;
  categoryColor?: string | null;
  position?: number;
  description: string;
  quantity: string;
  unit: string;
  unitPriceCents: number;
  discountCents: number | null;
  totalCents: number;
}

export interface Purchase {
  id?: number;
  accessKey?: string;
  supplierName: string;
  supplierCnpj: string;
  invoiceNumber: string;
  series: string;
  issuedAt: string;
  totalCents: number;
  invoiceDiscountCents: number;
  paymentMethod: string | null;
  importedAt?: string;
  categoryId?: number | null;
  categoryName?: string | null;
  categoryColor?: string | null;
  itemCount?: number;
  transactionId?: number | null;
  reconciledAt?: string | null;
  items?: PurchaseItem[];
}


export interface PurchaseReconciliationCandidate {
  transactionId: number;
  purchaseDate: string;
  dueDate: string;
  description: string;
  amountCents: number;
  paymentMethodName: string;
  paymentMethodId?: number;
  balanceType?: 'credit' | 'debit' | 'wallet' | 'unclassified';
  balanceShortfallCents?: number;
  balanceShortfallDate?: string | null;
  categoryId: number;
  categoryName: string;
  categoryColor: string | null;
  dayDistance: number;
}

export interface PurchaseReconciliationCandidates {
  toleranceDays: number;
  linkedMovement: Omit<PurchaseReconciliationCandidate, 'dayDistance'> | null;
  candidates: PurchaseReconciliationCandidate[];
  settlements: Array<{ id: number; transactionId: number | null; paymentMethodId: number; paymentMethodName: string; amountCents: number; settlementType: 'movement' | 'wallet'; effectiveDate: string }>;
  wallets: Array<{ id: number; name: string; balanceType: 'wallet'; balanceCents: number; minimumBalanceCents: number; minimumBalanceDate: string | null }>;
  totalCents: number;
  settledCents: number;
  linkedTransactionIds: number[];
}

export interface PurchaseReconciliationInput {
  transactionIds: number[];
  walletPayments: Array<{ paymentMethodId: number; amountCents: number; adjustment?: { amountCents: number; effectiveDate: string; reason: 'opening_balance' | 'cashback' | 'bonus' | 'other'; description: string } }>;
  balanceAdjustments?: Array<{ paymentMethodId: number; amountCents: number; effectiveDate: string; reason: 'opening_balance' | 'cashback' | 'bonus' | 'other'; description: string }>;
  categoryId: number | null;
}

export type NfceBatchRowStatus =
  | 'valid'
  | 'invalid'
  | 'blank'
  | 'duplicate-file'
  | 'already-imported'
  | 'error'
  | 'not-queried';

export interface NfceBatchLimits {
  fileBytes: number;
  lines: number;
  queries: number;
  lineChars: number;
}

export interface NfceBatchColumnInfo {
  index: number;
  label: string;
  validCount: number;
  totalCount: number;
}

export interface NfceBatchInspection {
  headers: string[] | null;
  columns: NfceBatchColumnInfo[];
  suggestedColumn: number | null;
  dataLines: number;
  blankLines: number;
  tooLongLines: number;
  limits: NfceBatchLimits;
}

export interface NfceBatchRow {
  line: number;
  state: 'RJ' | 'SP' | 'TO' | null;
  status: NfceBatchRowStatus;
  message: string | null;
  supplierName: string | null;
  supplierCnpj: string | null;
  invoiceNumber: string | null;
  series: string | null;
  issuedAt: string | null;
  totalCents: number | null;
  invoiceDiscountCents: number | null;
  itemCount: number | null;
}

export interface NfceBatchSummary {
  total: number;
  valid: number;
  invalid: number;
  blank: number;
  duplicateFile: number;
  alreadyImported: number;
  error: number;
  notQueried: number;
}

export interface NfceBatchPreview {
  inspection: NfceBatchInspection;
  rows: NfceBatchRow[];
  summary: NfceBatchSummary;
}

export type NfceBatchImportStatus = 'imported' | 'duplicate' | 'error' | 'not-queried';

export interface NfceBatchImportRow {
  line: number;
  status: NfceBatchImportStatus;
  message: string | null;
  purchaseId: number | null;
}

export interface NfceBatchImportSummary {
  total: number;
  imported: number;
  duplicate: number;
  error: number;
  notQueried: number;
}

export interface NfceBatchImportResult {
  rows: NfceBatchImportRow[];
  summary: NfceBatchImportSummary;
}

export type CopiedNfceRowStatus = 'ready' | 'invalid' | 'duplicate-file' | 'already-imported';

export interface CopiedNfcePreviewRow {
  block: number;
  state: string | null;
  status: CopiedNfceRowStatus;
  message: string | null;
  purchase: Omit<Purchase, 'accessKey'> | null;
  purchaseId: number | null;
}

export interface CopiedNfcePreview {
  rows: CopiedNfcePreviewRow[];
  summary: { total: number; ready: number; invalid: number; duplicateFile: number; alreadyImported: number };
}

export interface CopiedNfceImportResult {
  rows: { block: number; status: 'imported' | 'duplicate' | 'error'; message: string | null; purchaseId: number | null }[];
  summary: { total: number; imported: number; duplicate: number; error: number };
}

export interface Meta {
  categories: Lookup[];
  paymentMethods: Lookup[];
  years: number[];
  latestDueDate: string | null;
  latestPurchaseDate: string | null;
  transactionCount: number;
}

export interface TransferLeg {
  id: number;
  description: string;
  amountCents: number;
  dueDate: string;
  purchaseDate: string;
  paymentMethodId: number;
  paymentMethodName: string;
  categoryName: string;
  transfer: string | null;
}

export interface TransferLink {
  id: number;
  direction: 'out' | 'in';
  confidence: string;
  origin: string;
  counterpart: TransferLeg;
  sourceAccount: string;
  destinationAccount: string;
}

export type TransferStatus = 'confirmed' | 'unconfirmed' | null;

export interface TransferParty {
  key: string;
  source: 'file' | 'database';
  rowNumber: number | null;
  transactionId: number | null;
  dueDate: string;
  purchaseDate: string;
  description: string;
  amountCents: number;
  paymentMethod: string;
  transfer: string | null;
  category?: string;
  classification?: CategoryClassification | null;
}

export interface TransferCandidate {
  key: string;
  confidence: 'high' | 'possible';
  ambiguous: boolean;
  reasons: string[];
  dayDistance: number;
  outgoing: TransferParty;
  incoming: TransferParty;
}

export interface Transaction {
  id: number;
  purchaseDate: string;
  /** Origem da data de compra: arquivo, derivada do vencimento ou não registrada. */
  purchaseDateSource: 'file' | 'due_date_fallback' | null;
  dueDateSource: 'file' | 'estimated_from_installment' | 'derived_from_cash_purchase' | 'derived_from_purchase_fallback' | null;
  dueDate: string;
  description: string;
  amountCents: number;
  paymentMethodId: number;
  categoryId: number;
  installmentNumber: number | null;
  installmentTotal: number | null;
  installmentSource: 'column' | 'description' | 'manual' | null;
  installmentOriginal: string | null;
  transfer: string | null;
  importBatchId: number | null;
  createdAt: string;
  updatedAt: string;
  categoryName: string;
  paymentMethodName: string;
  transferStatus: TransferStatus;
  transferLink: TransferLink | null;
  /** Data estimada da primeira parcela (derivada; nunca a data real da compra). */
  estimatedFirstInstallmentDate: string | null;
}

export interface TransactionSummary {
  count: number;
  netCents: number;
  expenseCents: number;
  incomeCents: number;
  resultNetCents: number;
  cashFlowCents: number;
  transferCents: number;
  cardSettlementCents: number;
}

export interface TransactionListResponse {
  rows: Transaction[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  summary: TransactionSummary;
}

export type DateField = 'due' | 'purchase';
export type TransactionKind = 'all' | 'expenses' | 'income' | 'transfers';

export interface TransactionFilters {
  year?: number;
  month?: number;
  dateField: DateField;
  categoryId?: number;
  paymentMethodId?: number;
  search?: string;
  kind: TransactionKind;
  sortBy:
    | 'dueDate'
    | 'purchaseDate'
    | 'amount'
    | 'description'
    | 'categoryName'
    | 'paymentMethodName'
    | 'createdAt';
  sortDir: 'asc' | 'desc';
  page: number;
  pageSize: number;
}

export interface TransactionInput {
  purchaseDate?: string;
  dueDate?: string;
  description?: string;
  amount?: string;
  amountCents?: number;
  paymentMethodId?: number;
  categoryId?: number;
  installmentNumber?: number | null;
  installmentTotal?: number | null;
  transfer?: string | null;
}

export interface ConsolidationRow {
  categoryId: number;
  categoryName: string;
  color: string | null;
  monthTotals: number[];
  monthCounts: number[];
  totalCents: number;
  averageCents: number;
  monthsWithData: number;
}

export interface ConsolidationResponse {
  year: number;
  dateField: DateField;
  kind: 'expenses' | 'income' | 'transfers';
  categories: ConsolidationRow[];
  totals: {
    monthTotals: number[];
    monthCounts: number[];
    totalCents: number;
    averageCents: number;
    monthsWithData: number;
  };
}

export interface AccountCashFlowRow {
  paymentMethodId: number;
  paymentMethodName: string;
  transactionCount: number;
  inCents: number;
  outCents: number;
  netCents: number;
  transferCents: number;
  cardSettlementCents: number;
}

export interface AccountCashFlowResult {
  year: number;
  dateField: DateField;
  rows: AccountCashFlowRow[];
  totals: {
    transactionCount: number;
    inCents: number;
    outCents: number;
    netCents: number;
    transferCents: number;
    cardSettlementCents: number;
  };
}

export type ImportField =
  | 'purchaseDate'
  | 'dueDate'
  | 'description'
  | 'amount'
  | 'paymentMethod'
  | 'installments'
  | 'category'
  | 'transfer';

export type ColumnMapping = Partial<Record<ImportField, number | null>>;

export interface PreviewValues {
  purchaseDate: string | null;
  /** Origem da data de compra: arquivo ou derivada do vencimento (fallback). */
  purchaseDateSource: 'file' | 'due_date_fallback' | null;
  dueDate: string | null;
  /** Origem da data de vencimento: arquivo ou derivada da data de compra. */
  dueDateSource: 'file' | 'estimated_from_installment' | 'derived_from_cash_purchase' | 'derived_from_purchase_fallback' | null;
  description: string;
  amountCents: number | null;
  paymentMethod: string | null;
  category: string;
  installmentNumber: number | null;
  installmentTotal: number | null;
  installmentSource: 'column' | 'description' | null;
  installmentOriginal: string | null;
  /** Data estimada da primeira parcela (calculada, nunca histórica). */
  estimatedFirstInstallmentDate: string | null;
  cashPurchase: boolean;
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
  groupKey: string;
  counterpartRowNumber: number | null;
  counterpartTransactionId: number | null;
  counterpart: DuplicateCounterpart;
  reason: string;
}

export interface CategorySuggestionAlternative {
  categoryId: number;
  categoryName: string;
  score: number;
}

export interface CategorySuggestion {
  sourceCategory: string;
  sourceNormalized: string;
  targetCategoryId: number | null;
  targetCategoryName: string | null;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
  method: string;
  ambiguous: boolean;
  alternatives: CategorySuggestionAlternative[];
}

export interface CategorySuggestionGroup {
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
}

/** Decisão enviada pelo cliente para resolver uma categoria de origem. */
export interface CategoryDecisionPayload {
  action: 'accept' | 'use' | 'create' | 'reject';
  sourceCategory?: string | null;
  targetCategoryId?: number | null;
  newCategoryName?: string | null;
  /** true somente para escolha explícita do usuário (aceite/uso). */
  confirmed?: boolean;
}

export type CategoryDecisionsPayload = Record<string, CategoryDecisionPayload>;

export interface PreviewRow {
  rowNumber: number;
  raw: Record<ImportField, string>;
  values: PreviewValues;
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
  /** Avisos do reconhecimento automático (coluna genérica, semelhança, não usadas). */
  mappingWarnings: { level: 'info' | 'warning'; field: ImportField | null; message: string }[];
  /** Modelo de mapeamento aplicado automaticamente ao arquivo, quando houver. */
  appliedTemplate: { id: number; name: string } | null;
  totalRows: number;
  validRows: number;
  invalidRows: number;
  duplicateRows: number;
  rows: PreviewRow[];
  transferToleranceDays: number;
  transferCandidates: TransferCandidate[];
  categorySuggestions: CategorySuggestionGroup[];
}

export interface ImportMappingTemplate {
  id: number;
  name: string;
  headers: string[];
  mapping: Partial<Record<ImportField, string | null>>;
  createdAt: string;
  updatedAt: string;
}

export interface ImportOverrides {
  [rowNumber: string]: Partial<Record<ImportField, string>>;
}

export type TransferDecision = 'confirm' | 'reject' | 'pending';

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
  ignoredRows: number;
  firstDueDate: string | null;
  lastDueDate: string | null;
  errors: { rowNumber: number; errors: string[] }[];
}

export interface ImportBatch {
  id: number;
  filename: string;
  importedAt: string;
  totalRows: number;
  importedRows: number;
  rejectedRows: number;
  /** Nome do modelo de mapeamento utilizado, quando houver. */
  templateName: string | null;
}

export interface Bill {
  id: number;
  description: string;
  amountCents: number;
  dueDate: string;
  status: '' | 'AG' | 'PG';
  categoryId: number;
  categoryName: string;
  repeatedFromId: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface BillSummary {
  totalCents: number;
  unpaidCents: number;
  paidCents: number;
  counts: { '': number; AG: number; PG: number };
}

export interface BillListResponse {
  bills: Bill[];
  summary: BillSummary;
}
export interface ConfirmedTransferRecord {
  id: number;
  confidence: string;
  origin: string;
  createdAt: string;
  outgoing: TransferLeg;
  incoming: TransferLeg;
}

export interface RejectedTransferRecord {
  id: number;
  signature: string;
  signatureMatches: boolean;
  createdAt: string;
  outgoing: TransferLeg;
  incoming: TransferLeg;
}

export interface ReconciliationResult {
  toleranceDays: number;
  confirmed: ConfirmedTransferRecord[];
  candidates: TransferCandidate[];
  unmatched: TransferParty[];
  rejected: RejectedTransferRecord[];
  summary: {
    confirmed: number;
    candidates: number;
    unmatched: number;
    rejected: number;
  };
}

export interface InstallmentRecoveryProposal {
  transactionId: number;
  description: string;
  dueDate: string;
  currentNumber: number | null;
  currentTotal: number | null;
  proposedNumber: number;
  proposedTotal: number;
  previous: string | null;
  conflict: boolean;
  reason: string;
}
