import { and, asc, count, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, not, or, sql, type SQL } from 'drizzle-orm';
import type { AppDatabase } from '../db/client';
import { estimateFirstInstallmentDate } from '../lib/installments';
import { categories, paymentMethods, transactions, type Transaction } from '../db/schema';
import { parseDateValue } from '../lib/dates';
import { badRequest, conflict, HttpError, notFound, nowIso } from '../lib/errors';
import { normalizeTransfer } from '../lib/installments';
import { parseAmountToCents } from '../lib/money';
import { displayName, normalizeName } from '../lib/normalize';
import {
  ensurePaymentChangeKeepsTransfers,
  ensureTransactionCanBeRemoved,
  ensureUpdateKeepsTransfer,
  getTransferContext,
  type TransferLinkDto,
} from './transfers';

export type TransactionKind = 'all' | 'expenses' | 'income' | 'transfers';
export type DateField = 'due' | 'purchase';
export type SortBy =
  | 'dueDate'
  | 'purchaseDate'
  | 'amount'
  | 'description'
  | 'categoryName'
  | 'paymentMethodName'
  | 'createdAt';
export type SortDir = 'asc' | 'desc';

export type TransferStatus = 'confirmed' | 'unconfirmed' | null;

export interface TransactionDto extends Transaction {
  categoryName: string;
  paymentMethodName: string;
  transferStatus: TransferStatus;
  transferLink: TransferLinkDto | null;
  /**
   * Data estimada da primeira parcela, derivada do vencimento e do número
   * atual da parcela. Nunca é a data real da compra; null quando não há
   * parcelas válidas. Computada na leitura para nunca ficar desatualizada.
   */
  estimatedFirstInstallmentDate: string | null;
}

export interface ListTransactionsFilters {
  year?: number;
  month?: number;
  dateField?: DateField;
  categoryId?: number;
  paymentMethodId?: number;
  search?: string;
  kind?: TransactionKind;
  sortBy?: SortBy;
  sortDir?: SortDir;
  page?: number;
  pageSize?: number;
}

export interface TransactionSummary {
  count: number;
  /** Soma de todas as movimentações do filtro (inclui transferências e liquidações). */
  netCents: number;
  /** Resultado financeiro: despesas reais, sem transferências nem liquidação de cartão. */
  expenseCents: number;
  /** Resultado financeiro: receitas reais, sem transferências. */
  incomeCents: number;
  /** Receitas menos despesas do resultado financeiro. */
  resultNetCents: number;
  /** Movimento de caixa: mesma soma de netCents, exposta com nome explícito. */
  cashFlowCents: number;
  transferCents: number;
  /** Saídas classificadas como liquidação de cartão (não entram como despesa). */
  cardSettlementCents: number;
}

export interface TransactionWriteInput {
  purchaseDate?: unknown;
  dueDate?: unknown;
  description?: unknown;
  amount?: unknown;
  amountCents?: unknown;
  paymentMethodId?: unknown;
  categoryId?: unknown;
  installmentNumber?: unknown;
  installmentTotal?: unknown;
  transfer?: unknown;
}

interface ParsedWrite {
  purchaseDate: string;
  dueDate: string;
  description: string;
  amountCents: number;
  paymentMethodId: number;
  categoryId: number;
  installmentNumber: number | null;
  installmentTotal: number | null;
  transfer: string | null;
}

function positiveInt(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function optionalInstallment(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(n) && n > 0 ? n : Number.NaN;
}

function monthBounds(year: number, month: number): { start: string; end: string } {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    start: `${year}-${String(month).padStart(2, '0')}-01`,
    end: `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`,
  };
}

// Referência qualificada explícita: em consultas com uma única tabela o Drizzle
// omite o prefixo, o que quebraria a correlação dentro das subconsultas.
const TRANSACTION_ID = sql.raw('"transactions"."id"');
const TRANSACTION_CATEGORY_ID = sql.raw('"transactions"."category_id"');

export function categoryHasClassification(classification: string): SQL {
  return sql`exists (
    select 1 from categories
    where categories.id = ${TRANSACTION_CATEGORY_ID}
      and categories.classification = ${classification}
  )`;
}

export function transferLikeCondition(): SQL {
  return sql`(
    ${transactions.transfer} is not null
    or ${linkedTransferExists()}
    or ${categoryHasClassification('transfer')}
  )`;
}

export function linkedTransferExists(): SQL {
  return sql`exists (
    select 1 from transfers
    where transfers.outgoing_transaction_id = ${TRANSACTION_ID}
       or transfers.incoming_transaction_id = ${TRANSACTION_ID}
  )`;
}

export function notLinkedTransfer(): SQL {
  return sql`not exists (
    select 1 from transfers
    where transfers.outgoing_transaction_id = ${TRANSACTION_ID}
       or transfers.incoming_transaction_id = ${TRANSACTION_ID}
  )`;
}

export function applyKindCondition(kind: TransactionKind): SQL | undefined {
  switch (kind) {
    case 'expenses':
      return and(
        lt(transactions.amountCents, 0),
        isNull(transactions.transfer),
        notLinkedTransfer(),
        not(categoryHasClassification('transfer')),
        not(categoryHasClassification('card_settlement')),
      );
    case 'income':
      return and(
        gt(transactions.amountCents, 0),
        isNull(transactions.transfer),
        notLinkedTransfer(),
        not(categoryHasClassification('transfer')),
      );
    case 'transfers':
      return transferLikeCondition();
    default:
      return undefined;
  }
}

function buildConditions(filters: ListTransactionsFilters): SQL[] {
  const conditions: SQL[] = [];
  const dateColumn = filters.dateField === 'purchase' ? transactions.purchaseDate : transactions.dueDate;

  if (filters.year) {
    if (filters.month) {
      const bounds = monthBounds(filters.year, filters.month);
      conditions.push(gte(dateColumn, bounds.start), lte(dateColumn, bounds.end));
    } else {
      conditions.push(
        gte(dateColumn, `${filters.year}-01-01`),
        lte(dateColumn, `${filters.year}-12-31`),
      );
    }
  }

  if (filters.categoryId) conditions.push(eq(transactions.categoryId, filters.categoryId));
  if (filters.paymentMethodId) {
    conditions.push(eq(transactions.paymentMethodId, filters.paymentMethodId));
  }

  const search = normalizeName(filters.search ?? '');
  if (search) {
    const escaped = search.replace(/[!%_]/g, (char) => `!${char}`);
    conditions.push(
      sql`normalize_search(${transactions.description}) like ${`%${escaped}%`} escape '!'`,
    );
  }

  const kindCondition = applyKindCondition(filters.kind ?? 'all');
  if (kindCondition) conditions.push(kindCondition);

  return conditions;
}

function rowSelect(db: AppDatabase) {
  return db
    .select({
      transaction: transactions,
      categoryName: categories.name,
      paymentMethodName: paymentMethods.name,
    })
    .from(transactions)
    .innerJoin(categories, eq(transactions.categoryId, categories.id))
    .innerJoin(paymentMethods, eq(transactions.paymentMethodId, paymentMethods.id));
}

type JoinedRow = {
  transaction: Transaction;
  categoryName: string;
  paymentMethodName: string;
};

function baseDto(row: JoinedRow): TransactionDto {
  const transaction = row.transaction;
  return {
    ...transaction,
    categoryName: row.categoryName,
    paymentMethodName: row.paymentMethodName,
    transferStatus: null,
    transferLink: null,
    estimatedFirstInstallmentDate: estimateFirstInstallmentDate(
      transaction.dueDate,
      transaction.installmentNumber,
      transaction.installmentTotal,
    ),
  };
}

function withTransfer(
  dto: TransactionDto,
  link: TransferLinkDto | undefined,
): TransactionDto {
  if (link) {
    return { ...dto, transferStatus: 'confirmed', transferLink: link };
  }
  if (dto.transfer && dto.transfer.trim()) {
    return { ...dto, transferStatus: 'unconfirmed' };
  }
  return dto;
}

export function getTransaction(db: AppDatabase, id: number): TransactionDto {
  const row = rowSelect(db).where(eq(transactions.id, id)).get();
  if (!row) throw notFound('Lançamento não encontrado.');
  const dto = baseDto(row);
  return withTransfer(dto, getTransferContext(db, [id]).get(id));
}

function validateLookups(db: AppDatabase, categoryId: number, paymentMethodId: number) {
  const issues = [];
  const category = db.select().from(categories).where(eq(categories.id, categoryId)).get();
  if (!category) issues.push({ path: 'categoryId', message: 'Categoria inválida.' });
  const payment = db
    .select()
    .from(paymentMethods)
    .where(eq(paymentMethods.id, paymentMethodId))
    .get();
  if (!payment) issues.push({ path: 'paymentMethodId', message: 'Forma de pagamento inválida.' });
  return issues;
}

function parseWrite(
  db: AppDatabase,
  raw: TransactionWriteInput,
  existing?: Transaction,
  requireAll = false,
): ParsedWrite {
  const issues: { path: string; message: string }[] = [];

  const purchaseDateRaw = raw.purchaseDate !== undefined ? raw.purchaseDate : existing?.purchaseDate;
  const dueDateRaw = raw.dueDate !== undefined ? raw.dueDate : existing?.dueDate;
  const descriptionRaw = raw.description !== undefined ? raw.description : existing?.description;
  const categoryRaw = raw.categoryId !== undefined ? raw.categoryId : existing?.categoryId;
  const paymentRaw =
    raw.paymentMethodId !== undefined ? raw.paymentMethodId : existing?.paymentMethodId;
  const installmentNumberRaw =
    raw.installmentNumber !== undefined ? raw.installmentNumber : existing?.installmentNumber;
  const installmentTotalRaw =
    raw.installmentTotal !== undefined ? raw.installmentTotal : existing?.installmentTotal;
  const transferRaw = raw.transfer !== undefined ? raw.transfer : existing?.transfer;

  if (requireAll) {
    if (purchaseDateRaw === undefined) issues.push({ path: 'purchaseDate', message: 'Informe a data da compra.' });
    if (dueDateRaw === undefined) issues.push({ path: 'dueDate', message: 'Informe o vencimento.' });
    if (descriptionRaw === undefined) issues.push({ path: 'description', message: 'Informe a descrição.' });
    if (raw.amount === undefined && raw.amountCents === undefined) {
      issues.push({ path: 'amount', message: 'Informe o valor.' });
    }
    if (categoryRaw === undefined) issues.push({ path: 'categoryId', message: 'Informe a categoria.' });
    if (paymentRaw === undefined) {
      issues.push({ path: 'paymentMethodId', message: 'Informe a forma de pagamento.' });
    }
  }

  const purchaseDate = parseDateValue(purchaseDateRaw);
  if (!purchaseDate.ok) issues.push({ path: 'purchaseDate', message: purchaseDate.error });

  const dueDate = parseDateValue(dueDateRaw);
  if (!dueDate.ok) issues.push({ path: 'dueDate', message: dueDate.error });

  const description = displayName(String(descriptionRaw ?? ''));
  if (!description) issues.push({ path: 'description', message: 'Descrição obrigatória.' });
  if (description.length > 500) {
    issues.push({ path: 'description', message: 'Descrição muito longa (máximo 500).' });
  }

  let amountCents: number | null = null;
  if (raw.amount !== undefined) {
    const parsed = parseAmountToCents(raw.amount);
    if (!parsed.ok) issues.push({ path: 'amount', message: parsed.error });
    else amountCents = parsed.value;
  } else if (raw.amountCents !== undefined) {
    const n = typeof raw.amountCents === 'number' ? raw.amountCents : Number(raw.amountCents);
    if (!Number.isSafeInteger(n)) issues.push({ path: 'amount', message: 'Valor inválido.' });
    else amountCents = n;
  } else if (existing) {
    amountCents = existing.amountCents;
  }

  const categoryId = positiveInt(categoryRaw);
  if (!categoryId) issues.push({ path: 'categoryId', message: 'Categoria inválida.' });

  const paymentMethodId = positiveInt(paymentRaw);
  if (!paymentMethodId) {
    issues.push({ path: 'paymentMethodId', message: 'Forma de pagamento inválida.' });
  }

  if (categoryId && paymentMethodId) {
    issues.push(...validateLookups(db, categoryId, paymentMethodId));
  }

  const installmentNumber = optionalInstallment(installmentNumberRaw);
  const installmentTotal = optionalInstallment(installmentTotalRaw);
  if (typeof installmentNumber === 'number' && Number.isNaN(installmentNumber)) {
    issues.push({ path: 'installmentNumber', message: 'Número da parcela inválido.' });
  }
  if (typeof installmentTotal === 'number' && Number.isNaN(installmentTotal)) {
    issues.push({ path: 'installmentTotal', message: 'Total de parcelas inválido.' });
  }
  if (
    typeof installmentNumber === 'number' &&
    typeof installmentTotal === 'number' &&
    !Number.isNaN(installmentNumber) &&
    !Number.isNaN(installmentTotal) &&
    installmentNumber > installmentTotal
  ) {
    issues.push({ path: 'installmentNumber', message: 'A parcela não pode exceder o total.' });
  }

  if (issues.length > 0) {
    throw badRequest('Dados do lançamento inválidos.', issues);
  }

  return {
    purchaseDate: purchaseDate.ok ? purchaseDate.value : '',
    dueDate: dueDate.ok ? dueDate.value : '',
    description,
    amountCents: amountCents ?? 0,
    paymentMethodId: paymentMethodId as number,
    categoryId: categoryId as number,
    installmentNumber:
      typeof installmentNumber === 'number' ? installmentNumber : null,
    installmentTotal: typeof installmentTotal === 'number' ? installmentTotal : null,
    transfer: normalizeTransfer(transferRaw),
  };
}

export function createTransaction(db: AppDatabase, input: TransactionWriteInput): TransactionDto {
  const parsed = parseWrite(db, input, undefined, true);
  const timestamp = nowIso();
  const created = db
    .insert(transactions)
    .values({
      ...parsed,
      installmentSource:
        parsed.installmentNumber !== null || parsed.installmentTotal !== null ? 'manual' : null,
      installmentOriginal: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    .returning()
    .get();
  return getTransaction(db, created.id);
}

export function updateTransaction(
  db: AppDatabase,
  id: number,
  input: TransactionWriteInput,
): TransactionDto {
  const existing = db.select().from(transactions).where(eq(transactions.id, id)).get();
  if (!existing) throw notFound('Lançamento não encontrado.');

  const parsed = parseWrite(db, input, existing);
  try {
    ensureUpdateKeepsTransfer(db, id, {
      amountCents: parsed.amountCents,
      paymentMethodId: parsed.paymentMethodId,
    });
  } catch (error) {
    if (error instanceof HttpError) {
      throw conflict(
        `${error.message} Desvincule a transferência antes de editar valor, sinal ou conta.`,
      );
    }
    throw error;
  }
  const updates: Partial<Transaction> = { ...parsed, updatedAt: nowIso() };
  if (input.installmentNumber !== undefined || input.installmentTotal !== undefined) {
    updates.installmentSource = 'manual';
  }
  db.update(transactions)
    .set(updates)
    .where(eq(transactions.id, id))
    .run();
  return getTransaction(db, id);
}

export function deleteTransaction(db: AppDatabase, id: number): void {
  ensureTransactionCanBeRemoved(db, [id]);
  const result = db.delete(transactions).where(eq(transactions.id, id)).run();
  if (result.changes === 0) throw notFound('Lançamento não encontrado.');
}

function normalizeIds(ids: unknown): number[] {
  if (!Array.isArray(ids)) throw badRequest('Selecione ao menos um lançamento.');
  const unique = [
    ...new Set(
      ids
        .map((id) => (typeof id === 'number' ? id : Number(id)))
        .filter((id) => Number.isInteger(id) && id > 0),
    ),
  ];
  if (unique.length === 0) throw badRequest('Selecione ao menos um lançamento.');
  if (unique.length > 5000) throw badRequest('Selecione no máximo 5000 lançamentos por vez.');
  return unique;
}

export function bulkUpdateTransactions(
  db: AppDatabase,
  idsInput: unknown,
  changes: { categoryId?: unknown; paymentMethodId?: unknown },
): number {
  const ids = normalizeIds(idsInput);
  const values: { categoryId?: number; paymentMethodId?: number; updatedAt: string } = {
    updatedAt: nowIso(),
  };

  if (changes.categoryId !== undefined) {
    const categoryId = positiveInt(changes.categoryId);
    if (!categoryId) throw badRequest('Categoria inválida.');
    const category = db.select().from(categories).where(eq(categories.id, categoryId)).get();
    if (!category) throw badRequest('Categoria inválida.');
    values.categoryId = categoryId;
  }

  if (changes.paymentMethodId !== undefined) {
    const paymentMethodId = positiveInt(changes.paymentMethodId);
    if (!paymentMethodId) throw badRequest('Forma de pagamento inválida.');
    const payment = db
      .select()
      .from(paymentMethods)
      .where(eq(paymentMethods.id, paymentMethodId))
      .get();
    if (!payment) throw badRequest('Forma de pagamento inválida.');
    values.paymentMethodId = paymentMethodId;
  }

  if (values.categoryId === undefined && values.paymentMethodId === undefined) {
    throw badRequest('Informe ao menos um campo para alterar.');
  }

  if (values.paymentMethodId !== undefined) {
    ensurePaymentChangeKeepsTransfers(db, ids, values.paymentMethodId);
  }

  return db
    .update(transactions)
    .set(values)
    .where(inArray(transactions.id, ids))
    .run().changes;
}

export function bulkDeleteTransactions(db: AppDatabase, idsInput: unknown): number {
  const ids = normalizeIds(idsInput);
  ensureTransactionCanBeRemoved(db, ids);
  return db.delete(transactions).where(inArray(transactions.id, ids)).run().changes;
}

export function listTransactions(db: AppDatabase, filters: ListTransactionsFilters) {
  const conditions = buildConditions(filters);
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const sortColumn =
    filters.sortBy === 'purchaseDate'
      ? transactions.purchaseDate
      : filters.sortBy === 'amount'
        ? transactions.amountCents
        : filters.sortBy === 'description'
          ? sql`lower(${transactions.description})`
          : filters.sortBy === 'categoryName'
            ? sql`normalize_search(${categories.name})`
            : filters.sortBy === 'paymentMethodName'
              ? sql`normalize_search(${paymentMethods.name})`
              : filters.sortBy === 'createdAt'
                ? transactions.createdAt
                : transactions.dueDate;
  const direction = filters.sortDir === 'asc' ? asc : desc;

  const page = Math.max(1, Math.floor(filters.page ?? 1));
  const pageSize = Math.min(200, Math.max(1, Math.floor(filters.pageSize ?? 25)));

  const rawRows = rowSelect(db)
    .where(where)
    .orderBy(direction(sortColumn), desc(transactions.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize)
    .all();
  const transferContext = getTransferContext(
    db,
    rawRows.map((row) => row.transaction.id),
  );
  const rows = rawRows.map((row) =>
    withTransfer(baseDto(row), transferContext.get(row.transaction.id)),
  );

  const totalRow = db
    .select({ value: count() })
    .from(transactions)
    .where(where)
    .get();

  const summaryRow = db
    .select({
      count: sql<number>`count(*)`,
      netCents: sql<number>`coalesce(sum(${transactions.amountCents}), 0)`,
      expenseCents: sql<number>`coalesce(sum(case when ${transactions.amountCents} < 0 and ${transactions.transfer} is null and not exists (
        select 1 from transfers
        where transfers.outgoing_transaction_id = ${TRANSACTION_ID}
           or transfers.incoming_transaction_id = ${TRANSACTION_ID}
      ) and not exists (
        select 1 from categories
        where categories.id = ${TRANSACTION_CATEGORY_ID}
          and categories.classification in ('transfer', 'card_settlement')
      ) then -${transactions.amountCents} else 0 end), 0)`,
      incomeCents: sql<number>`coalesce(sum(case when ${transactions.amountCents} > 0 and ${transactions.transfer} is null and not exists (
        select 1 from transfers
        where transfers.outgoing_transaction_id = ${TRANSACTION_ID}
           or transfers.incoming_transaction_id = ${TRANSACTION_ID}
      ) and not exists (
        select 1 from categories
        where categories.id = ${TRANSACTION_CATEGORY_ID}
          and categories.classification = 'transfer'
      ) then ${transactions.amountCents} else 0 end), 0)`,
      transferCents: sql<number>`coalesce(sum(case when ${transactions.transfer} is not null or exists (
        select 1 from transfers
        where transfers.outgoing_transaction_id = ${TRANSACTION_ID}
           or transfers.incoming_transaction_id = ${TRANSACTION_ID}
      ) or exists (
        select 1 from categories
        where categories.id = ${TRANSACTION_CATEGORY_ID}
          and categories.classification = 'transfer'
      ) then abs(${transactions.amountCents}) else 0 end), 0)`,
      cardSettlementCents: sql<number>`coalesce(sum(case when ${transactions.amountCents} < 0 and ${transactions.transfer} is null and not exists (
        select 1 from transfers
        where transfers.outgoing_transaction_id = ${TRANSACTION_ID}
           or transfers.incoming_transaction_id = ${TRANSACTION_ID}
      ) and exists (
        select 1 from categories
        where categories.id = ${TRANSACTION_CATEGORY_ID}
          and categories.classification = 'card_settlement'
      ) then -${transactions.amountCents} else 0 end), 0)`,
    })
    .from(transactions)
    .where(where)
    .get();

  const total = totalRow?.value ?? 0;
  const rawSummary = summaryRow ?? {
    count: 0,
    netCents: 0,
    expenseCents: 0,
    incomeCents: 0,
    transferCents: 0,
    cardSettlementCents: 0,
  };
  const summary: TransactionSummary = {
    ...rawSummary,
    resultNetCents: rawSummary.incomeCents - rawSummary.expenseCents,
    cashFlowCents: rawSummary.netCents,
  };

  return {
    rows,
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    summary,
  };
}
