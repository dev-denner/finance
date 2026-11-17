/** Impressão digital dos lançamentos e comparação com o que já está no banco. */
import { desc, eq } from 'drizzle-orm';
import type { AppDatabase } from '../../db/client';
import { categories, importBatches, paymentMethods, transactions } from '../../db/schema';
import { normalizeName } from '../../lib/normalize';
import type { DuplicateCounterpart, ParsedImportValues } from './types';

export function transactionFingerprint(input: {
  purchaseDate: string;
  dueDate: string;
  description: string;
  amountCents: number;
  paymentMethod: string;
  category: string;
  installmentNumber: number | null;
  installmentTotal: number | null;
  transfer: string | null;
}): string {
  return [
    input.purchaseDate,
    input.dueDate,
    normalizeName(input.description),
    input.amountCents,
    normalizeName(input.paymentMethod),
    normalizeName(input.category),
    input.installmentNumber ?? '',
    input.installmentTotal ?? '',
    normalizeName(input.transfer ?? ''),
  ].join('|');
}

/** Chave mais branda: mesma data, valor e conta, mesmo com descrição diferente. */
export function probableDuplicateKey(input: {
  purchaseDate: string;
  dueDate: string;
  amountCents: number;
  paymentMethod: string;
}): string {
  return [
    input.purchaseDate,
    input.dueDate,
    input.amountCents,
    normalizeName(input.paymentMethod),
  ].join('|');
}

export function loadDatabaseComparisons(db: AppDatabase): {
  exact: Map<string, DuplicateCounterpart>;
  probable: Map<string, DuplicateCounterpart>;
} {
  const rows = db
    .select({
      transactionId: transactions.id,
      purchaseDate: transactions.purchaseDate,
      dueDate: transactions.dueDate,
      description: transactions.description,
      amountCents: transactions.amountCents,
      installmentNumber: transactions.installmentNumber,
      installmentTotal: transactions.installmentTotal,
      transfer: transactions.transfer,
      categoryName: categories.name,
      paymentMethodName: paymentMethods.name,
      importBatchId: transactions.importBatchId,
      importedAt: importBatches.importedAt,
    })
    .from(transactions)
    .innerJoin(categories, eq(transactions.categoryId, categories.id))
    .innerJoin(paymentMethods, eq(transactions.paymentMethodId, paymentMethods.id))
    .leftJoin(importBatches, eq(transactions.importBatchId, importBatches.id))
    .orderBy(desc(transactions.id))
    .all();

  const exact = new Map<string, DuplicateCounterpart>();
  const probable = new Map<string, DuplicateCounterpart>();

  for (const row of rows) {
    const counterpart: DuplicateCounterpart = {
      source: 'database',
      rowNumber: null,
      transactionId: row.transactionId,
      purchaseDate: row.purchaseDate,
      dueDate: row.dueDate,
      description: row.description,
      amountCents: row.amountCents,
      paymentMethod: row.paymentMethodName,
      category: row.categoryName,
      installmentNumber: row.installmentNumber,
      installmentTotal: row.installmentTotal,
      importBatchId: row.importBatchId,
      importedAt: row.importedAt ?? null,
    };
    const fingerprint = transactionFingerprint({
      ...row,
      category: row.categoryName,
      paymentMethod: row.paymentMethodName,
    });
    if (!exact.has(fingerprint)) exact.set(fingerprint, counterpart);
    const probableKey = probableDuplicateKey({
      purchaseDate: row.purchaseDate,
      dueDate: row.dueDate,
      amountCents: row.amountCents,
      paymentMethod: row.paymentMethodName,
    });
    if (!probable.has(probableKey)) probable.set(probableKey, counterpart);
  }

  return { exact, probable };
}

export function fileComparable(
  rowNumber: number,
  values: ParsedImportValues,
  identity: { paymentMethod: string; category: string },
): DuplicateCounterpart {
  return {
    source: 'file',
    rowNumber,
    transactionId: null,
    purchaseDate: values.purchaseDate as string,
    dueDate: values.dueDate as string,
    description: values.description,
    amountCents: values.amountCents as number,
    // A contraparte exibe a identidade resolvida (conta de destino e categoria
    // escolhida), a mesma usada na impressão digital da duplicidade.
    paymentMethod: identity.paymentMethod,
    category: identity.category,
    installmentNumber: values.installmentNumber,
    installmentTotal: values.installmentTotal,
    importBatchId: null,
    importedAt: null,
  };
}
