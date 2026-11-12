import { and, asc, count, eq, ne, sql } from 'drizzle-orm';
import type { AppDatabase } from '../db/client';
import { categories, categoryImportAliases, paymentBalanceAdjustments, paymentMethods, purchaseItems, purchaseSettlements, purchases, transactions } from '../db/schema';
import { badRequest, conflict, notFound } from '../lib/errors';
import { displayName, normalizeName } from '../lib/normalize';
import { ensurePaymentChangeKeepsTransfers } from './transfers';

export type Executor = Pick<AppDatabase, 'select' | 'insert' | 'update' | 'delete'>;

export type CategoryClassification =
  | 'expense'
  | 'income'
  | 'transfer'
  | 'card_settlement'
  | 'mixed';

export const CATEGORY_CLASSIFICATIONS: CategoryClassification[] = [
  'expense',
  'income',
  'transfer',
  'card_settlement',
  'mixed',
];

export interface LookupDto {
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

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/** Normaliza a cor para #rrggbb minúsculo; `null` limpa; `undefined` mantém. */
export function normalizeColor(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (!HEX_COLOR.test(text)) {
    throw badRequest('Cor inválida. Use o formato #RRGGBB.');
  }
  return text.toLowerCase();
}

/** Normaliza a classificação semântica; `null` limpa; `undefined` mantém. */
export function normalizeClassification(
  value: unknown,
): CategoryClassification | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (!CATEGORY_CLASSIFICATIONS.includes(text as CategoryClassification)) {
    throw badRequest('Classificação de categoria inválida.');
  }
  return text as CategoryClassification;
}

export type LookupKind = 'category' | 'payment';

const TABLES = {
  category: categories,
  payment: paymentMethods,
} as const;

function usageColumn(kind: LookupKind) {
  return kind === 'category' ? transactions.categoryId : transactions.paymentMethodId;
}

export function listLookups(db: AppDatabase, kind: LookupKind): LookupDto[] {
  const table = TABLES[kind];
  if (kind === 'category') {
    return db.select({
      id: categories.id,
      name: categories.name,
      normalizedName: categories.normalizedName,
      color: categories.color,
      classification: categories.classification,
      usageCount: sql<number>`
        (SELECT count(*) FROM transactions WHERE transactions.category_id = ${categories.id}) +
        (SELECT count(*) FROM purchases WHERE purchases.category_id = ${categories.id}) +
        (SELECT count(*) FROM purchase_items WHERE purchase_items.category_id = ${categories.id})
      `,
      createdAt: categories.createdAt,
    }).from(categories).orderBy(asc(sql`lower(${categories.name})`)).all() as LookupDto[];
  }
  const rows = db
    .select({
      id: paymentMethods.id,
      name: paymentMethods.name,
      normalizedName: paymentMethods.normalizedName,
      color: sql<string | null>`null`,
      classification: sql<string | null>`null`,
      balanceType: paymentMethods.balanceType,
      balanceCents: sql<number>`coalesce((SELECT sum(amount_cents) FROM transactions WHERE transactions.payment_method_id = ${paymentMethods.id}), 0) + coalesce((SELECT sum(amount_cents) FROM payment_balance_adjustments WHERE payment_balance_adjustments.payment_method_id = ${paymentMethods.id} AND payment_balance_adjustments.reversed_at IS NULL), 0) - coalesce((SELECT sum(amount_cents) FROM purchase_settlements WHERE purchase_settlements.payment_method_id = ${paymentMethods.id} AND purchase_settlements.settlement_type = 'wallet' AND purchase_settlements.reversed_at IS NULL), 0)`,
      usageCount: sql<number>`count(distinct ${transactions.id}) + (SELECT count(*) FROM purchase_settlements WHERE purchase_settlements.payment_method_id = ${paymentMethods.id}) + (SELECT count(*) FROM payment_balance_adjustments WHERE payment_balance_adjustments.payment_method_id = ${paymentMethods.id})`,
      createdAt: paymentMethods.createdAt,
    })
    .from(paymentMethods)
    .leftJoin(transactions, eq(transactions.paymentMethodId, paymentMethods.id))
    .groupBy(paymentMethods.id)
    .orderBy(asc(sql`lower(${paymentMethods.name})`))
    .all();
  return rows as LookupDto[];
}

export function findLookupByName(db: Executor, kind: LookupKind, name: string) {
  const table = TABLES[kind];
  const normalized = normalizeName(name);
  if (!normalized) return undefined;
  return db.select().from(table).where(eq(table.normalizedName, normalized)).get();
}

export function ensureLookup(db: Executor, kind: LookupKind, rawName: string) {
  const table = TABLES[kind];
  const name = displayName(rawName);
  const normalized = normalizeName(name);
  if (!normalized) {
    throw conflict('Informe um nome válido.');
  }
  if (name.length > 120) {
    throw conflict('O nome deve ter no máximo 120 caracteres.');
  }

  const existing = db.select().from(table).where(eq(table.normalizedName, normalized)).get();
  if (existing) return existing;

  return db
    .insert(table)
    .values({ name, normalizedName: normalized })
    .returning()
    .get();
}

export function createLookup(
  db: AppDatabase,
  kind: LookupKind,
  rawName: string,
  color?: string | null,
  classification?: string | null,
  balanceType?: 'credit' | 'debit' | 'wallet' | 'unclassified',
): LookupDto {
  const name = displayName(rawName);
  if (!name) throw conflict('Informe um nome.');
  if (name.length > 120) throw conflict('O nome deve ter no máximo 120 caracteres.');

  const normalized = normalizeName(name);
  const table = TABLES[kind];
  const existing = db.select().from(table).where(eq(table.normalizedName, normalized)).get();
  if (existing) {
    throw conflict(`Já existe um registro com o nome "${existing.name}".`);
  }

  const normalizedColor = kind === 'category' ? (normalizeColor(color) ?? null) : null;
  const normalizedClassification =
    kind === 'category' ? (normalizeClassification(classification) ?? null) : null;
  const values: Record<string, unknown> = { name, normalizedName: normalized };
  if (kind === 'category') {
    values.color = normalizedColor;
    values.classification = normalizedClassification;
  } else values.balanceType = balanceType ?? 'unclassified';

  const created = db.insert(table).values(values as never).returning().get() as {
    color?: string | null;
    classification?: string | null;
    balanceType?: 'credit' | 'debit' | 'wallet' | 'unclassified';
  };

  return {
    ...created,
    color: normalizedColor,
    classification: normalizedClassification,
    ...(kind === 'payment' ? { balanceType: (created as { balanceType?: LookupDto['balanceType'] }).balanceType ?? balanceType ?? 'unclassified' } : {}),
    usageCount: 0,
  } as LookupDto;
}

export function renameLookup(
  db: AppDatabase,
  kind: LookupKind,
  id: number,
  rawName: string,
  color?: string | null,
  classification?: string | null,
  balanceType?: 'credit' | 'debit' | 'wallet' | 'unclassified',
): LookupDto {
  const table = TABLES[kind];
  const name = displayName(rawName);
  if (!name) throw conflict('Informe um nome.');
  if (name.length > 120) throw conflict('O nome deve ter no máximo 120 caracteres.');

  const current = db.select().from(table).where(eq(table.id, id)).get();
  if (!current) throw notFound('Registro não encontrado.');

  const normalized = normalizeName(name);
  const other = db
    .select()
    .from(table)
    .where(and(eq(table.normalizedName, normalized), ne(table.id, id)))
    .get();
  if (other) {
    throw conflict(`Já existe um registro com o nome "${other.name}".`);
  }

  const updateValues: Record<string, unknown> = { name, normalizedName: normalized };
  let nextColor: string | null = (current as { color?: string | null }).color ?? null;
  if (kind === 'category' && color !== undefined) {
    nextColor = normalizeColor(color) ?? null;
    updateValues.color = nextColor;
  }
  let nextClassification: CategoryClassification | null =
    ((current as { classification?: string | null }).classification as
      | CategoryClassification
      | null
      | undefined) ?? null;
  if (kind === 'category' && classification !== undefined) {
    nextClassification = normalizeClassification(classification) ?? null;
    updateValues.classification = nextClassification;
  }
  let nextBalanceType: LookupDto['balanceType'] = (current as { balanceType?: LookupDto['balanceType'] }).balanceType ?? 'unclassified';
  if (kind === 'payment' && balanceType !== undefined) {
    nextBalanceType = balanceType;
    updateValues.balanceType = balanceType;
  }

  db.update(table)
    .set(updateValues as never)
    .where(eq(table.id, id))
    .run();

  const usage = kind === 'category'
    ? db.select({ value: sql<number>`
        (SELECT count(*) FROM transactions WHERE transactions.category_id = ${id}) +
        (SELECT count(*) FROM purchases WHERE purchases.category_id = ${id}) +
        (SELECT count(*) FROM purchase_items WHERE purchase_items.category_id = ${id})
      ` }).from(categories).where(eq(categories.id, id)).get()
    : db.select({ value: count() }).from(transactions).where(eq(usageColumn(kind), id)).get();

  return {
    ...current,
    name,
    normalizedName: normalized,
    color: kind === 'category' ? nextColor : null,
    classification: kind === 'category' ? nextClassification : null,
    ...(kind === 'payment' ? { balanceType: nextBalanceType } : {}),
    usageCount: usage?.value ?? 0,
  } as LookupDto;
}

export function deleteLookup(
  db: AppDatabase,
  kind: LookupKind,
  id: number,
  reassignTo?: number,
): { reassigned: number } {
  const table = TABLES[kind];
  const current = db.select().from(table).where(eq(table.id, id)).get();
  if (!current) throw notFound('Registro não encontrado.');

  return db.transaction((tx) => {
    const usage = kind === 'category'
      ? tx.select({ value: sql<number>`
          (SELECT count(*) FROM transactions WHERE transactions.category_id = ${id}) +
          (SELECT count(*) FROM purchases WHERE purchases.category_id = ${id}) +
          (SELECT count(*) FROM purchase_items WHERE purchase_items.category_id = ${id})
        ` }).from(categories).where(eq(categories.id, id)).get()
      : tx.select({ value: sql<number>`(SELECT count(*) FROM transactions WHERE transactions.payment_method_id = ${id}) + (SELECT count(*) FROM purchase_settlements WHERE purchase_settlements.payment_method_id = ${id}) + (SELECT count(*) FROM payment_balance_adjustments WHERE payment_balance_adjustments.payment_method_id = ${id})` }).from(paymentMethods).where(eq(paymentMethods.id, id)).get();
    const usageCount = usage?.value ?? 0;

    let reassigned = 0;
    if (usageCount > 0) {
      if (reassignTo === undefined) {
        throw conflict(
          `Este registro está em uso por ${usageCount} lançamento(s). Escolha um registro para reatribuir antes de excluir.`,
        );
      }
      if (reassignTo === id) {
        throw conflict('Escolha um registro de destino diferente.');
      }
      const target = tx.select().from(table).where(eq(table.id, reassignTo)).get();
      if (!target) throw notFound('Registro de destino não encontrado.');

      if (kind === 'payment') {
        const affected = tx
          .select({ id: transactions.id })
          .from(transactions)
          .where(eq(transactions.paymentMethodId, id))
          .all()
          .map((row) => row.id);
        ensurePaymentChangeKeepsTransfers(tx as unknown as AppDatabase, affected, reassignTo);
      }

      if (kind === 'category') {
        const result = tx.update(transactions)
          .set({ categoryId: reassignTo, updatedAt: new Date().toISOString() })
          .where(eq(transactions.categoryId, id)).run();
        const purchasesResult = tx.update(purchases).set({ categoryId: reassignTo }).where(eq(purchases.categoryId, id)).run();
        const itemsResult = tx.update(purchaseItems).set({ categoryId: reassignTo }).where(eq(purchaseItems.categoryId, id)).run();
        reassigned = result.changes + purchasesResult.changes + itemsResult.changes;
      } else {
        const result = tx.update(transactions)
          .set({ paymentMethodId: reassignTo, updatedAt: new Date().toISOString() })
          .where(eq(transactions.paymentMethodId, id)).run();
        const settlements = tx.update(purchaseSettlements).set({ paymentMethodId: reassignTo })
          .where(eq(purchaseSettlements.paymentMethodId, id)).run();
        const adjustments = tx.update(paymentBalanceAdjustments).set({ paymentMethodId: reassignTo })
          .where(eq(paymentBalanceAdjustments.paymentMethodId, id)).run();
        reassigned = result.changes + settlements.changes + adjustments.changes;
      }
    }

    if (kind === 'category') {
      if (reassignTo !== undefined) {
        tx.update(purchases).set({ reconciliationPreviousCategoryId: reassignTo })
          .where(eq(purchases.reconciliationPreviousCategoryId, id)).run();
        tx.update(purchaseItems).set({ reconciliationPreviousCategoryId: reassignTo })
          .where(eq(purchaseItems.reconciliationPreviousCategoryId, id)).run();
      } else {
        tx.update(purchases).set({ reconciliationPreviousCategoryId: null })
          .where(eq(purchases.reconciliationPreviousCategoryId, id)).run();
        tx.update(purchaseItems).set({ reconciliationPreviousCategoryId: null })
          .where(eq(purchaseItems.reconciliationPreviousCategoryId, id)).run();
      }
    }

    // Sem uso (sem destino de reatribuição) o ON DELETE cascade remove os
    // aliases; não há valor para atualizar.
    if (kind === 'category' && reassignTo !== undefined) {
      tx
        .update(categoryImportAliases)
        .set({ targetCategoryId: reassignTo })
        .where(eq(categoryImportAliases.targetCategoryId, id))
        .run();
    }

    tx.delete(table).where(eq(table.id, id)).run();
    return { reassigned };
  });
}
