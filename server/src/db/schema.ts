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
    createdAt: text('created_at').notNull().default(now),
  },
  (table) => [uniqueIndex('payment_methods_normalized_name_uq').on(table.normalizedName)],
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

export type Category = typeof categories.$inferSelect;
export type PaymentMethod = typeof paymentMethods.$inferSelect;
export type ImportBatch = typeof importBatches.$inferSelect;
export type Transaction = typeof transactions.$inferSelect;
export type Transfer = typeof transfers.$inferSelect;
export type TransferRejection = typeof transferRejections.$inferSelect;
export type ScheduledBill = typeof scheduledBills.$inferSelect;
export type CategoryImportAlias = typeof categoryImportAliases.$inferSelect;
