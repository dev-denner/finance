import type {
  AccountCashFlowResult,
  Bill,
  BillListResponse,
  CategoryClassification,
  CategoryDecisionsPayload,
  ColumnMapping,
  ConsolidationResponse,
  DateField,
  ImportBatch,
  ImportMappingTemplate,
  ImportOverrides,
  ImportPreview,
  ImportSummary,
  InstallmentRecoveryProposal,
  Lookup,
  Meta,
  ReconciliationResult,
  RejectedTransferRecord,
  Transaction,
  TransactionFilters,
  TransactionInput,
  TransactionKind,
  TransactionListResponse,
  TransferCandidate,
  TransferDecision,
} from './types';

export interface TransferRecord {
  id: number;
  outgoingTransactionId: number;
  incomingTransactionId: number;
  confidence: string;
  origin: string;
  createdAt: string;
}

export class ApiError extends Error {
  status: number;
  issues?: { path?: string; message: string }[];

  constructor(status: number, message: string, issues?: { path?: string; message: string }[]) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.issues = issues;
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !(options.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(`/api${path}`, { ...options, headers });
  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { error: text };
    }
  }

  if (!response.ok) {
    const data = (payload ?? {}) as {
      error?: string;
      issues?: { path?: string; message: string }[];
    };
    throw new ApiError(
      response.status,
      data.error ?? 'Não foi possível concluir a operação.',
      data.issues,
    );
  }

  return payload as T;
}

function queryString(params: Record<string, string | number | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

export const api = {
  getMeta: () => request<Meta>('/meta'),

  listTransactions: (filters: TransactionFilters) =>
    request<TransactionListResponse>(
      `/transactions${queryString({
        year: filters.year,
        month: filters.month,
        dateField: filters.dateField,
        categoryId: filters.categoryId,
        paymentMethodId: filters.paymentMethodId,
        search: filters.search,
        kind: filters.kind,
        sortBy: filters.sortBy,
        sortDir: filters.sortDir,
        page: filters.page,
        pageSize: filters.pageSize,
      })}`,
    ),

  getTransaction: (id: number) => request<Transaction>(`/transactions/${id}`),

  createTransaction: (input: TransactionInput) =>
    request<Transaction>('/transactions', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  updateTransaction: (id: number, input: TransactionInput) =>
    request<Transaction>(`/transactions/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),

  deleteTransaction: (id: number) =>
    request<{ ok: true }>(`/transactions/${id}`, { method: 'DELETE' }),

  bulkUpdate: (ids: number[], changes: { categoryId?: number; paymentMethodId?: number }) =>
    request<{ updated: number }>('/transactions/bulk', {
      method: 'PATCH',
      body: JSON.stringify({ ids, ...changes }),
    }),

  bulkDelete: (ids: number[]) =>
    request<{ deleted: number }>('/transactions/bulk-delete', {
      method: 'POST',
      body: JSON.stringify({ ids }),
    }),

  listLookups: (kind: 'category' | 'payment') =>
    request<Lookup[]>(kind === 'category' ? '/categories' : '/payment-methods'),

  createLookup: (
    kind: 'category' | 'payment',
    name: string,
    color?: string | null,
    classification?: CategoryClassification | null,
  ) =>
    request<Lookup>(kind === 'category' ? '/categories' : '/payment-methods', {
      method: 'POST',
      body: JSON.stringify({ name, color, classification }),
    }),

  renameLookup: (
    kind: 'category' | 'payment',
    id: number,
    name: string,
    color?: string | null,
    classification?: CategoryClassification | null,
  ) =>
    request<Lookup>(`${kind === 'category' ? '/categories' : '/payment-methods'}/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name, color, classification }),
    }),

  deleteLookup: (kind: 'category' | 'payment', id: number, reassignTo?: number) =>
    request<{ reassigned: number }>(
      `${kind === 'category' ? '/categories' : '/payment-methods'}/${id}${queryString({
        reassignTo,
      })}`,
      { method: 'DELETE' },
    ),

  previewImport: (
    file: File,
    mapping?: ColumnMapping,
    overrides?: ImportOverrides,
    toleranceDays?: number,
    templateId?: number,
    options?: {
      destinationPaymentMethodId?: number | null;
      categoryDecisions?: CategoryDecisionsPayload;
    },
  ) => {
    const form = new FormData();
    form.append('file', file);
    if (mapping) form.append('mapping', JSON.stringify(mapping));
    if (overrides) form.append('overrides', JSON.stringify(overrides));
    if (toleranceDays !== undefined) form.append('toleranceDays', String(toleranceDays));
    if (templateId !== undefined) form.append('templateId', String(templateId));
    if (options?.destinationPaymentMethodId !== undefined && options.destinationPaymentMethodId !== null) {
      form.append('destinationPaymentMethodId', String(options.destinationPaymentMethodId));
    }
    if (options?.categoryDecisions) {
      form.append('categoryDecisions', JSON.stringify(options.categoryDecisions));
    }
    return request<ImportPreview>('/imports/preview', { method: 'POST', body: form });
  },

  importFile: (
    file: File,
    options: {
      mapping: ColumnMapping;
      overrides?: ImportOverrides;
      skipDuplicates: boolean;
      rejectedRows: number[];
      /** Linhas que o usuário escolheu importar mesmo sendo duplicatas. */
      includedDuplicateRows?: number[];
      toleranceDays?: number;
      transferDecisions?: Record<string, TransferDecision>;
      templateId?: number;
      destinationPaymentMethodId?: number | null;
      categoryDecisions?: CategoryDecisionsPayload;
    },
  ) => {
    const form = new FormData();
    form.append('file', file);
    form.append('mapping', JSON.stringify(options.mapping));
    form.append('overrides', JSON.stringify(options.overrides ?? {}));
    form.append('skipDuplicates', String(options.skipDuplicates));
    form.append('rejectedRows', JSON.stringify(options.rejectedRows));
    if (options.includedDuplicateRows !== undefined) {
      form.append('includedDuplicateRows', JSON.stringify(options.includedDuplicateRows));
    }
    if (options.toleranceDays !== undefined) {
      form.append('toleranceDays', String(options.toleranceDays));
    }
    if (options.transferDecisions) {
      form.append('transferDecisions', JSON.stringify(options.transferDecisions));
    }
    if (options.templateId !== undefined) {
      form.append('templateId', String(options.templateId));
    }
    if (options.destinationPaymentMethodId !== undefined && options.destinationPaymentMethodId !== null) {
      form.append('destinationPaymentMethodId', String(options.destinationPaymentMethodId));
    }
    if (options.categoryDecisions) {
      form.append('categoryDecisions', JSON.stringify(options.categoryDecisions));
    }
    return request<ImportSummary>('/imports', { method: 'POST', body: form });
  },

  getImports: () => request<{ batches: ImportBatch[] }>('/imports'),

  getBills: (year: number, month: number) =>
    request<BillListResponse>(`/bills?${new URLSearchParams({ year: String(year), month: String(month) }).toString()}`),

  createBill: (input: {
    description: string;
    amountCents: number;
    dueDate: string;
    categoryId: number;
    status?: '' | 'AG' | 'PG';
  }) =>
    request<{ bill: Bill }>('/bills', { method: 'POST', body: JSON.stringify(input) }),

  updateBill: (
    id: number,
    input: {
      description?: string;
      amountCents?: number;
      dueDate?: string;
      categoryId?: number;
      status?: '' | 'AG' | 'PG';
    },
  ) => request<{ bill: Bill }>(`/bills/${id}`, { method: 'PUT', body: JSON.stringify(input) }),

  deleteBill: (id: number) => request<{ removed: true }>(`/bills/${id}`, { method: 'DELETE' }),

  setBillStatus: (id: number, status: '' | 'AG' | 'PG') =>
    request<{ bill: Bill; promptRepeat: boolean; existingRepeatId: number | null }>(
      `/bills/${id}/status`,
      { method: 'POST', body: JSON.stringify({ status }) },
    ),

  repeatBill: (id: number) => request<{ bill: Bill; created: boolean }>(`/bills/${id}/repeat`, { method: 'POST' }),

  listMappingTemplates: () =>
    request<{ templates: ImportMappingTemplate[] }>('/imports/mappings'),

  saveMappingTemplate: (input: { name: string; headers: string[]; mapping: ColumnMapping }) =>
    request<{ template: ImportMappingTemplate }>('/imports/mappings', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  deleteMappingTemplate: (id: number) =>
    request<{ removed: true }>(`/imports/mappings/${id}`, { method: 'DELETE' }),

  getTransferCandidates: (transactionId: number, toleranceDays?: number) =>
    request<{ candidates: TransferCandidate[] }>(
      `/transactions/${transactionId}/transfer-candidates${queryString({ toleranceDays })}`,
    ),

  linkTransfer: (
    outgoingTransactionId: number,
    incomingTransactionId: number,
    confidence?: 'high' | 'probable' | 'manual',
  ) =>
    request<TransferRecord>('/transfers', {
      method: 'POST',
      body: JSON.stringify({ outgoingTransactionId, incomingTransactionId, confidence }),
    }),

  unlinkTransfer: (id: number) =>
    request<{ removed: true }>(`/transfers/${id}`, { method: 'DELETE' }),

  getReconciliation: (toleranceDays: number, includeRejected: boolean) =>
    request<ReconciliationResult>(
      `/transfers/reconciliation${queryString({
        toleranceDays,
        includeRejected: includeRejected ? 'true' : undefined,
      })}`,
    ),

  rejectTransferPair: (outgoingTransactionId: number, incomingTransactionId: number) =>
    request<RejectedTransferRecord>('/transfers/rejections', {
      method: 'POST',
      body: JSON.stringify({ outgoingTransactionId, incomingTransactionId }),
    }),

  clearTransferRejection: (outgoingTransactionId: number, incomingTransactionId: number) =>
    request<{ removed: number }>('/transfers/rejections/clear', {
      method: 'POST',
      body: JSON.stringify({ outgoingTransactionId, incomingTransactionId }),
    }),

  clearAllTransferRejections: () =>
    request<{ removed: number }>('/transfers/rejections', { method: 'DELETE' }),

  getInstallmentRecovery: () =>
    request<{ proposals: InstallmentRecoveryProposal[] }>('/installments/recovery'),

  applyInstallmentRecovery: (ids: number[]) =>
    request<{ updated: number; skipped: number[] }>('/installments/recovery', {
      method: 'POST',
      body: JSON.stringify({ ids }),
    }),

  getConsolidation: (year: number, dateField: DateField, kind: string) =>
    request<ConsolidationResponse>(
      `/consolidation${queryString({ year, dateField, kind })}`,
    ),

  getAccountCashFlow: (year: number, dateField: DateField) =>
    request<AccountCashFlowResult>(`/consolidation/cash-flow${queryString({ year, dateField })}`),

  getConsolidationDetails: (
    year: number,
    month: number,
    categoryId: number,
    dateField: DateField,
    kind: Exclude<TransactionKind, 'all'>,
  ) =>
    request<TransactionListResponse>(
      `/consolidation/details${queryString({
        year,
        month,
        categoryId,
        dateField,
        kind,
      })}`,
    ),
};

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.issues?.length) {
      return `${error.message} ${error.issues.map((issue) => issue.message).join(' ')}`;
    }
    return error.message;
  }
  if (error instanceof Error) return error.message;
  return 'Erro inesperado.';
}
