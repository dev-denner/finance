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
