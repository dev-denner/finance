import { z, type ZodType } from 'zod';
import { badRequest } from '../lib/errors';

export function parseWith<T>(schema: ZodType<T>, value: unknown, label = 'Dados inválidos.'): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw badRequest(
      label,
      result.error.issues.map((issue) => ({
        path: issue.path.join('.') || undefined,
        message: issue.message,
      })),
    );
  }
  return result.data;
}

const emptyToUndefined = (value: unknown) =>
  value === '' || value === null || value === undefined ? undefined : value;

function optionalIntSchema(options: { min?: number; max?: number; positive?: boolean } = {}) {
  let numberSchema = z.coerce.number().int();
  if (options.positive) numberSchema = numberSchema.positive();
  if (options.min !== undefined) numberSchema = numberSchema.min(options.min);
  if (options.max !== undefined) numberSchema = numberSchema.max(options.max);
  return z.preprocess(emptyToUndefined, numberSchema.optional()) as unknown as ZodType<
    number | undefined
  >;
}

export const optionalInt = optionalIntSchema();
export const optionalPositiveInt = optionalIntSchema({ positive: true });
export const optionalYear = optionalIntSchema({ min: 1900, max: 2200 });
export const optionalMonth = optionalIntSchema({ min: 1, max: 12 });

export const listTransactionsSchema = z.object({
  year: optionalYear,
  month: optionalMonth,
  dateField: z.enum(['due', 'purchase']).default('due'),
  categoryId: optionalPositiveInt,
  paymentMethodId: optionalPositiveInt,
  search: z.string().max(200).optional(),
  kind: z.enum(['all', 'expenses', 'income', 'transfers']).default('all'),
  sortBy: z
    .enum([
      'dueDate',
      'purchaseDate',
      'amount',
      'description',
      'categoryName',
      'paymentMethodName',
      'createdAt',
    ])
    .default('dueDate'),
  sortDir: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});

export const transactionWriteSchema = z.object({
  purchaseDate: z.string().optional(),
  dueDate: z.string().optional(),
  description: z.string().optional(),
  amount: z.union([z.string(), z.number()]).optional(),
  amountCents: z.number().int().optional(),
  paymentMethodId: z.number().int().optional(),
  categoryId: z.number().int().optional(),
  installmentNumber: z.union([z.number().int(), z.null()]).optional(),
  installmentTotal: z.union([z.number().int(), z.null()]).optional(),
  transfer: z.union([z.string(), z.null()]).optional(),
});

export const bulkTransactionSchema = z.object({
  ids: z.array(z.number().int().positive()).min(1).max(5000),
  categoryId: z.number().int().positive().optional(),
  paymentMethodId: z.number().int().positive().optional(),
});

export const bulkDeleteSchema = z.object({
  ids: z.array(z.number().int().positive()).min(1).max(5000),
});

const colorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'Cor inválida. Use o formato #RRGGBB.')
  .nullable()
  .optional();

export const lookupWriteSchema = z.object({
  name: z.string().min(1).max(120),
  color: colorSchema,
  classification: z
    .enum(['expense', 'income', 'transfer', 'card_settlement', 'mixed'])
    .nullable()
    .optional(),
  balanceType: z.enum(['credit', 'debit', 'wallet', 'unclassified']).optional(),
});

export const transferLinkSchema = z.object({
  outgoingTransactionId: z.number().int().positive(),
  incomingTransactionId: z.number().int().positive(),
  confidence: z.enum(['high', 'probable', 'manual']).optional(),
});

export const transferCandidatesSchema = z.object({
  toleranceDays: z.coerce.number().int().min(0).max(31).optional(),
});

export const reconciliationQuerySchema = z.object({
  toleranceDays: z.coerce.number().int().min(0).max(31).default(3),
  includeRejected: z
    .preprocess(
      (value) => value === true || value === 'true' || value === '1',
      z.boolean(),
    )
    .default(false),
});

export const transferRejectionSchema = z.object({
  outgoingTransactionId: z.number().int().positive(),
  incomingTransactionId: z.number().int().positive(),
});

export const installmentRecoveryApplySchema = z.object({
  ids: z.array(z.number().int().positive()).min(1).max(5000),
});

export const consolidationSchema = z.object({
  year: optionalYear,
  dateField: z.enum(['due', 'purchase']).default('due'),
  kind: z.enum(['expenses', 'income', 'transfers']).default('expenses'),
});

// ---------------------------------------------------------------------------
// Módulo 1 — contas a pagar
// ---------------------------------------------------------------------------

const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a data no formato AAAA-MM-DD.');
const positiveCentsSchema = z.number().int().positive().max(1_000_000_000_00);
const amountTextSchema = z.union([z.string().max(40), z.number()]);
const notesSchema = z.string().max(1000).nullable().optional();

export const idParamSchema = z.object({ id: z.coerce.number().int().positive() });

const recurrenceShape = {
  frequency: z.enum(['monthly', 'weekly', 'yearly']),
  interval: z.number().int().min(1).max(120).optional(),
  dayOfMonth: z.number().int().min(1).max(31).nullable().optional(),
  weekday: z.number().int().min(0).max(6).nullable().optional(),
  monthOfYear: z.number().int().min(1).max(12).nullable().optional(),
};

export const billRecurrenceSchema = z.object(recurrenceShape).strict();

const hasAmount = (value: { amountCents?: unknown; amount?: unknown }) =>
  value.amountCents !== undefined || value.amount !== undefined;

const billFields = {
  description: z.string().trim().min(1).max(200),
  amountCents: positiveCentsSchema.optional(),
  amount: amountTextSchema.optional(),
  dueDate: isoDateSchema,
  categoryId: z.number().int().positive(),
  paymentMethodId: z.number().int().positive().nullable().optional(),
  notes: notesSchema,
  scheduledFor: isoDateSchema.nullable().optional(),
};

export const billCreateSchema = z
  .object(billFields)
  .strict()
  .refine(hasAmount, { message: 'Informe o valor da conta.', path: ['amountCents'] });

export const billUpdateSchema = z.object(billFields).partial().strict();

export const billListQuerySchema = z.object({
  year: optionalYear,
  month: optionalMonth,
  state: z.enum(['all', 'open', 'paid', 'skipped']).default('all'),
  q: z.string().max(200).optional(),
  categoryId: optionalPositiveInt,
});

export const billAgendaQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(60).default(7),
});

export const billForecastQuerySchema = z.object({
  months: z.coerce.number().int().min(1).max(12).default(3),
});

export const payBillSchema = z.discriminatedUnion('mode', [
  z
    .object({
      mode: z.literal('external'),
      paidAt: isoDateSchema,
      paidCents: positiveCentsSchema,
      notes: notesSchema,
    })
    .strict(),
  z
    .object({
      mode: z.literal('transaction'),
      paidAt: isoDateSchema,
      paidCents: positiveCentsSchema,
      paymentMethodId: z.number().int().positive(),
      notes: notesSchema,
    })
    .strict(),
  z
    .object({
      mode: z.literal('link'),
      transactionId: z.number().int().positive(),
      notes: notesSchema,
    })
    .strict(),
]);

export const scheduleBillSchema = z
  .object({ scheduledFor: isoDateSchema.nullable() })
  .strict();

const templateFields = {
  description: z.string().trim().min(1).max(200),
  amountCents: positiveCentsSchema.optional(),
  amount: amountTextSchema.optional(),
  amountMinCents: positiveCentsSchema.nullable().optional(),
  amountMaxCents: positiveCentsSchema.nullable().optional(),
  categoryId: z.number().int().positive(),
  paymentMethodId: z.number().int().positive().nullable().optional(),
  recurrence: billRecurrenceSchema,
  startDate: isoDateSchema,
  endDate: isoDateSchema.nullable().optional(),
  occurrenceCount: z.number().int().min(1).max(600).nullable().optional(),
  active: z.boolean().optional(),
  notes: notesSchema,
};

export const billTemplateCreateSchema = z
  .object(templateFields)
  .strict()
  .refine(hasAmount, { message: 'Informe o valor previsto.', path: ['amountCents'] });

export const billTemplateUpdateSchema = z
  .object({
    ...templateFields,
    recurrence: z.object(recurrenceShape).partial().strict(),
  })
  .partial()
  .strict();

export const billTemplateUpdateQuerySchema = z.object({
  scope: z.enum(['all', 'future']).default('all'),
  from: isoDateSchema.optional(),
});

export const billTemplateListQuerySchema = z.object({
  includeInactive: z
    .preprocess((value) => value === true || value === 'true' || value === '1', z.boolean())
    .default(false),
});
