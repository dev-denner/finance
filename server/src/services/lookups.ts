import { and, asc, count, eq, ne, sql } from 'drizzle-orm';
import type { AppDatabase } from '../db/client';
import { categories, categoryImportAliases, paymentMethods, transactions } from '../db/schema';
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
  const joinColumn = usageColumn(kind);
  const selection =
    kind === 'category'
      ? {
          id: categories.id,
          name: categories.name,
          normalizedName: categories.normalizedName,
          color: categories.color,
          classification: categories.classification,
          usageCount: count(transactions.id),
          createdAt: categories.createdAt,
        }
      : {
          id: paymentMethods.id,
          name: paymentMethods.name,
          normalizedName: paymentMethods.normalizedName,
          color: sql<string | null>`null`,
          classification: sql<string | null>`null`,
          usageCount: count(transactions.id),
          createdAt: paymentMethods.createdAt,
        };
  const rows = db
    .select(selection)
    .from(table)
    .leftJoin(transactions, eq(joinColumn, table.id))
    .groupBy(table.id)
    .orderBy(asc(sql`lower(${table.name})`))
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
  }

  const created = db.insert(table).values(values as never).returning().get() as {
    color?: string | null;
    classification?: string | null;
  };

  return {
    ...created,
    color: normalizedColor,
    classification: normalizedClassification,
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

  db.update(table)
    .set(updateValues as never)
    .where(eq(table.id, id))
    .run();

  const usage = db
    .select({ value: count() })
    .from(transactions)
    .where(eq(usageColumn(kind), id))
    .get();

  return {
    ...current,
    name,
    normalizedName: normalized,
    color: kind === 'category' ? nextColor : null,
    classification: kind === 'category' ? nextClassification : null,
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
    const usage = tx
      .select({ value: count() })
      .from(transactions)
      .where(eq(usageColumn(kind), id))
      .get();
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

      const result =
        kind === 'category'
          ? tx
              .update(transactions)
              .set({ categoryId: reassignTo, updatedAt: new Date().toISOString() })
              .where(eq(transactions.categoryId, id))
              .run()
          : tx
              .update(transactions)
              .set({ paymentMethodId: reassignTo, updatedAt: new Date().toISOString() })
              .where(eq(transactions.paymentMethodId, id))
              .run();
      reassigned = result.changes;
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
