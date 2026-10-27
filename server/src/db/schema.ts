import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

const now = sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;

export const categories = sqliteTable(
  'categories',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    normalizedName: text('normalized_name').notNull(),
    color: text('color'),
    /** Classificação semântica opcional: expense, income, transfer, card_settlement, mixed. */
    classification: text('classification'),
    createdAt: text('created_at').notNull().default(now),
  },
  (table) => [uniqueIndex('categories_normalized_name_uq').on(table.normalizedName)],
);

export const paymentMethods = sqliteTable(
  'payment_methods',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    normalizedName: text('normalized_name').notNull(),
    /** Explicit balance behavior: credit may owe; debit and wallet require available balance. */
    balanceType: text('balance_type').$type<'credit' | 'debit' | 'wallet' | 'unclassified'>().notNull().default('unclassified'),
    createdAt: text('created_at').notNull().default(now),
  },
  (table) => [
    uniqueIndex('payment_methods_normalized_name_uq').on(table.normalizedName),
    check('payment_methods_balance_type_check', sql`${table.balanceType} in ('credit', 'debit', 'wallet', 'unclassified')`),
  ],
);

export const paymentBalanceAdjustments = sqliteTable(
  'payment_balance_adjustments',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    paymentMethodId: integer('payment_method_id')
      .notNull()
      .references(() => paymentMethods.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
    effectiveDate: text('effective_date').notNull(),
    amountCents: integer('amount_cents').notNull(),
    reason: text('reason').notNull(),
    description: text('description').notNull(),
    purchaseId: integer('purchase_id').references(() => purchases.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
    reversedAt: text('reversed_at'),
    createdAt: text('created_at').notNull().default(now),
  },
  (table) => [
    index('payment_balance_adjustments_purchase_idx').on(table.purchaseId),
    index('payment_balance_adjustments_account_date_idx').on(table.paymentMethodId, table.effectiveDate),
    check('payment_balance_adjustments_amount_check', sql`${table.amountCents} > 0`),
    check('payment_balance_adjustments_reason_check', sql`${table.reason} in ('opening_balance', 'cashback', 'bonus', 'other')`),
  ],
);

/**
 * Modelo de mapeamento de colunas salvo pelo usuário. Guarda a associação entre
 * cabeçalhos do arquivo e campos internos (nomes, não posições), permitindo
 * reutilizar o mesmo formato em importações futuras.
 */
export const importMappingTemplates = sqliteTable(
  'import_mapping_templates',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    /** Cabeçalhos do formato ao qual o modelo se aplica (JSON array). */
    headers: text('headers').notNull(),
    /** Associação entre cabeçalhos do arquivo e campos internos (JSON). */
    mapping: text('mapping').notNull(),
    createdAt: text('created_at').notNull().default(now),
    updatedAt: text('updated_at').notNull().default(now),
  },
  (table) => [uniqueIndex('import_mapping_templates_name_uq').on(table.name)],
);

export const importBatches = sqliteTable('import_batches', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  filename: text('filename').notNull(),
  importedAt: text('imported_at').notNull().default(now),
  totalRows: integer('total_rows').notNull(),
  importedRows: integer('imported_rows').notNull(),
  rejectedRows: integer('rejected_rows').notNull(),
  /** Modelo de mapeamento utilizado nesta importação, quando houver. */
  mappingTemplateId: integer('mapping_template_id').references(() => importMappingTemplates.id, {
    onDelete: 'set null',
    onUpdate: 'cascade',
  }),
});

export const transactions = sqliteTable(
  'transactions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    purchaseDate: text('purchase_date').notNull(),
    dueDate: text('due_date').notNull(),
    description: text('description').notNull(),
    amountCents: integer('amount_cents').notNull(),
    paymentMethodId: integer('payment_method_id')
      .notNull()
      .references(() => paymentMethods.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
    categoryId: integer('category_id')
      .notNull()
      .references(() => categories.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
    installmentNumber: integer('installment_number'),
    installmentTotal: integer('installment_total'),
    /** Origem da informação de parcelas: column, description ou manual. */
    installmentSource: text('installment_source'),
    /** Valor original preservado quando a parcela foi recuperada/corrigida. */
    installmentOriginal: text('installment_original'),
    /**
     * Origem da data de compra: `file` quando informada no arquivo,
     * `due_date_fallback` quando derivada do vencimento por falta de coluna.
     * Nulo indica registro anterior ao campo (origem não registrada).
     */
    purchaseDateSource: text('purchase_date_source'),
    /** Origem da data de vencimento: `file` ou derivada da data de compra. */
    dueDateSource: text('due_date_source'),
    transfer: text('transfer'),
    importBatchId: integer('import_batch_id').references(() => importBatches.id, {
      onDelete: 'set null',
      onUpdate: 'cascade',
    }),
    createdAt: text('created_at').notNull().default(now),
    updatedAt: text('updated_at').notNull().default(now),
  },
  (table) => [
    index('transactions_due_date_idx').on(table.dueDate),
    index('transactions_purchase_date_idx').on(table.purchaseDate),
    index('transactions_category_id_idx').on(table.categoryId),
    index('transactions_payment_method_id_idx').on(table.paymentMethodId),
    index('transactions_import_batch_id_idx').on(table.importBatchId),
    check(
      'transactions_installments_check',
      sql`(${table.installmentNumber} is null or ${table.installmentNumber} >= 1)
        and (${table.installmentTotal} is null or ${table.installmentTotal} >= 1)
        and (${table.installmentNumber} is null or ${table.installmentTotal} is null
          or ${table.installmentNumber} <= ${table.installmentTotal})`,
    ),
  ],
);

export const transfers = sqliteTable(
  'transfers',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    outgoingTransactionId: integer('outgoing_transaction_id')
      .notNull()
      .references(() => transactions.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
    incomingTransactionId: integer('incoming_transaction_id')
      .notNull()
      .references(() => transactions.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
    confidence: text('confidence').notNull().default('manual'),
    origin: text('origin').notNull().default('manual'),
    createdAt: text('created_at').notNull().default(now),
  },
  (table) => [
    uniqueIndex('transfers_outgoing_transaction_uq').on(table.outgoingTransactionId),
    uniqueIndex('transfers_incoming_transaction_uq').on(table.incomingTransactionId),
    check('transfers_distinct_check', sql`${table.outgoingTransactionId} <> ${table.incomingTransactionId}`),
    check(
      'transfers_confidence_check',
      sql`${table.confidence} in ('high', 'probable', 'manual')`,
    ),
    check('transfers_origin_check', sql`${table.origin} in ('import', 'manual')`),
  ],
);

export const transferRejections = sqliteTable(
  'transfer_rejections',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    outgoingTransactionId: integer('outgoing_transaction_id')
      .notNull()
      .references(() => transactions.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
    incomingTransactionId: integer('incoming_transaction_id')
      .notNull()
      .references(() => transactions.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
    /** Assinatura dos dois lançamentos no momento da rejeição. */
    signature: text('signature').notNull(),
    createdAt: text('created_at').notNull().default(now),
  },
  (table) => [
    uniqueIndex('transfer_rejections_pair_uq').on(
      table.outgoingTransactionId,
      table.incomingTransactionId,
    ),
    check(
      'transfer_rejections_distinct_check',
      sql`${table.outgoingTransactionId} <> ${table.incomingTransactionId}`,
    ),
  ],
);

/**
 * Contas a pagar agendadas (Módulo 1). Entidade própria, separada das
 * transações financeiras do Módulo 2 — não cria movimentação automaticamente.
 */
export const categoryImportAliases = sqliteTable(
  'category_import_aliases',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sourceNormalizedName: text('source_normalized_name').notNull(),
    targetCategoryId: integer('target_category_id')
      .notNull()
      .references(() => categories.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
    createdAt: text('created_at').notNull().default(now),
  },
  (table) => [uniqueIndex('category_import_aliases_source_uq').on(table.sourceNormalizedName)],
);

export const scheduledBills = sqliteTable(
  'scheduled_bills',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    description: text('description').notNull(),
    amountCents: integer('amount_cents').notNull(),
    dueDate: text('due_date').notNull(),
    status: text('status').notNull().default(''),
    categoryId: integer('category_id')
      .notNull()
      .references(() => categories.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
    /** Conta de origem quando esta foi gerada por repetição (mês seguinte). */
    repeatedFromId: integer('repeated_from_id').references((): any => scheduledBills.id, {
      onDelete: 'set null',
      onUpdate: 'cascade',
    }),
    createdAt: text('created_at').notNull().default(now),
    updatedAt: text('updated_at').notNull().default(now),
  },
  (table) => [
    check('scheduled_bills_status_check', sql`${table.status} IN ('', 'AG', 'PG')`),
    check('scheduled_bills_amount_check', sql`${table.amountCents} > 0`),
    index('scheduled_bills_due_date_idx').on(table.dueDate),
    index('scheduled_bills_category_idx').on(table.categoryId),
    index('scheduled_bills_repeated_from_idx').on(table.repeatedFromId),
  ],
);

/**
 * Lote de lembrete por e-mail: um e-mail por (marco, data-alvo).
 * `state` acompanha o resultado do envio (`pending|sent|failed|skipped`).
 */
export const billReminderBatches = sqliteTable(
  'bill_reminder_batches',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** Marco do lembrete (D-3, D-2, D-1 ou D0). */
    milestone: text('milestone').notNull(),
    /** Data-alvo do envio (AAAA-MM-DD). */
    sendDate: text('send_date').notNull(),
    state: text('state').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    sentAt: text('sent_at'),
    /** Quantidade de itens consolidados no e-mail. */
    itemCount: integer('item_count').notNull().default(0),
    /** Destinatário do lote (endereço de e-mail, sem outros dados pessoais). */
    recipient: text('recipient').notNull(),
    createdAt: text('created_at').notNull().default(now),
    updatedAt: text('updated_at').notNull().default(now),
  },
  (table) => [
    uniqueIndex('bill_reminder_batches_milestone_send_date_uq').on(
      table.milestone,
      table.sendDate,
    ),
    check(
      'bill_reminder_batches_state_check',
      sql`${table.state} in ('pending', 'sent', 'failed', 'skipped')`,
    ),
    check('bill_reminder_batches_attempts_check', sql`${table.attempts} >= 0`),
    check('bill_reminder_batches_item_count_check', sql`${table.itemCount} >= 0`),
    index('bill_reminder_batches_state_idx').on(table.state),
    index('bill_reminder_batches_send_date_idx').on(table.sendDate),
  ],
);

/** Compras importadas de documentos fiscais; independentes das movimentações. */
export const purchases = sqliteTable(
  'purchases',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    accessKey: text('access_key').notNull(),
    supplierName: text('supplier_name').notNull(),
    supplierCnpj: text('supplier_cnpj').notNull(),
    invoiceNumber: text('invoice_number').notNull(),
    series: text('series').notNull(),
    issuedAt: text('issued_at').notNull(),
    totalCents: integer('total_cents').notNull(),
    invoiceDiscountCents: integer('invoice_discount_cents').notNull().default(0),
    paymentMethod: text('payment_method'),
    categoryId: integer('category_id').references(() => categories.id, { onDelete: 'set null', onUpdate: 'cascade' }),
    transactionId: integer('transaction_id').references(() => transactions.id, { onDelete: 'set null', onUpdate: 'cascade' }),
    reconciledAt: text('reconciled_at'),
    reconciliationPreviousCategoryId: integer('reconciliation_previous_category_id'),
    importedAt: text('imported_at').notNull().default(now),
  },
  (table) => [
    uniqueIndex('purchases_access_key_uq').on(table.accessKey),
    uniqueIndex('purchases_transaction_id_uq').on(table.transactionId),
    index('purchases_issued_at_idx').on(table.issuedAt),
  ],
);

export const purchaseSettlements = sqliteTable(
  'purchase_settlements',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    purchaseId: integer('purchase_id')
      .notNull()
      .references(() => purchases.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
    transactionId: integer('transaction_id')
      .references(() => transactions.id, { onDelete: 'set null', onUpdate: 'cascade' }),
    paymentMethodId: integer('payment_method_id')
      .notNull()
      .references(() => paymentMethods.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
    amountCents: integer('amount_cents').notNull(),
    settlementType: text('settlement_type').$type<'movement' | 'wallet'>().notNull(),
    effectiveDate: text('effective_date').notNull(),
    reversedAt: text('reversed_at'),
    createdAt: text('created_at').notNull().default(now),
  },
  (table) => [
    uniqueIndex('purchase_settlements_transaction_active_uq')
      .on(table.transactionId)
      .where(sql`${table.transactionId} is not null and ${table.reversedAt} is null`),
    index('purchase_settlements_purchase_idx').on(table.purchaseId),
    index('purchase_settlements_payment_date_idx').on(table.paymentMethodId, table.effectiveDate),
    check('purchase_settlements_amount_check', sql`${table.amountCents} > 0`),
    check(
      'purchase_settlements_type_check',
      sql`(${table.settlementType} = 'movement' and (${table.transactionId} is not null or (${table.transactionId} is null and ${table.reversedAt} is not null))) or (${table.settlementType} = 'wallet' and ${table.transactionId} is null)`,
    ),
  ],
);

export const purchaseItems = sqliteTable(
  'purchase_items',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    purchaseId: integer('purchase_id')
      .notNull()
      .references(() => purchases.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
    position: integer('position').notNull(),
    description: text('description').notNull(),
    quantity: text('quantity').notNull(),
    unit: text('unit').notNull(),
    unitPriceCents: integer('unit_price_cents').notNull(),
    discountCents: integer('discount_cents'),
    totalCents: integer('total_cents').notNull(),
    categoryId: integer('category_id').references(() => categories.id, { onDelete: 'set null', onUpdate: 'cascade' }),
    reconciliationPreviousCategoryId: integer('reconciliation_previous_category_id'),
  },
  (table) => [
    uniqueIndex('purchase_items_purchase_position_uq').on(table.purchaseId, table.position),
    index('purchase_items_purchase_id_idx').on(table.purchaseId),
  ],
);

/**
 * Ledger de lembretes por item: uma linha por (conta, marco, vencimento).
 * `bill_id` apaga o histórico do item quando a conta é excluída.
 */
export const billReminderNotifications = sqliteTable(
  'bill_reminder_notifications',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    billId: integer('bill_id')
      .notNull()
      .references(() => scheduledBills.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
    milestone: text('milestone').notNull(),
    /** Vencimento registrado no momento da criação (AAAA-MM-DD). */
    dueDate: text('due_date').notNull(),
    /** Data-alvo do envio (AAAA-MM-DD). */
    sendDate: text('send_date').notNull(),
    state: text('state').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    sentAt: text('sent_at'),
    batchId: integer('batch_id').references(() => billReminderBatches.id, {
      onDelete: 'set null',
      onUpdate: 'cascade',
    }),
    createdAt: text('created_at').notNull().default(now),
    updatedAt: text('updated_at').notNull().default(now),
  },
  (table) => [
    uniqueIndex('bill_reminder_notifications_bill_milestone_due_date_uq').on(
      table.billId,
      table.milestone,
      table.dueDate,
    ),
    check(
      'bill_reminder_notifications_state_check',
      sql`${table.state} in ('pending', 'sent', 'failed', 'skipped')`,
    ),
    check('bill_reminder_notifications_attempts_check', sql`${table.attempts} >= 0`),
    index('bill_reminder_notifications_bill_id_idx').on(table.billId),
    index('bill_reminder_notifications_state_idx').on(table.state),
    index('bill_reminder_notifications_batch_id_idx').on(table.batchId),
  ],
);

export type Category = typeof categories.$inferSelect;
export type PaymentMethod = typeof paymentMethods.$inferSelect;
export type ImportBatch = typeof importBatches.$inferSelect;
export type Transaction = typeof transactions.$inferSelect;
export type Transfer = typeof transfers.$inferSelect;
export type TransferRejection = typeof transferRejections.$inferSelect;
export type ScheduledBill = typeof scheduledBills.$inferSelect;
export type CategoryImportAlias = typeof categoryImportAliases.$inferSelect;
export type BillReminderBatch = typeof billReminderBatches.$inferSelect;
export type BillReminderNotification = typeof billReminderNotifications.$inferSelect;
