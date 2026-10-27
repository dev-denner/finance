import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { AppDatabase } from '../db/client';
import { categories, purchaseItems, purchases } from '../db/schema';
import { badRequest, conflict, notFound } from '../lib/errors';
import type { PurchaseInput } from './rj-nfce';

export function listPurchases(db: AppDatabase) {
  return db
    .select({
      id: purchases.id,
      supplierName: purchases.supplierName,
      supplierCnpj: purchases.supplierCnpj,
      invoiceNumber: purchases.invoiceNumber,
      series: purchases.series,
      issuedAt: purchases.issuedAt,
      totalCents: purchases.totalCents,
      invoiceDiscountCents: purchases.invoiceDiscountCents,
      paymentMethod: purchases.paymentMethod,
      importedAt: purchases.importedAt,
      categoryId: purchases.categoryId,
      categoryName: categories.name,
      categoryColor: categories.color,
      transactionId: purchases.transactionId,
      reconciledAt: purchases.reconciledAt,
      itemCount: sql<number>`count(${purchaseItems.id})`,
    })
    .from(purchases)
    .leftJoin(purchaseItems, eq(purchaseItems.purchaseId, purchases.id))
    .leftJoin(categories, eq(categories.id, purchases.categoryId))
    .groupBy(purchases.id)
    .orderBy(desc(purchases.issuedAt), desc(purchases.id))
    .all();
}

export function getPurchase(db: AppDatabase, id: number) {
  const purchase = db.select({
    id: purchases.id, accessKey: purchases.accessKey, supplierName: purchases.supplierName,
    supplierCnpj: purchases.supplierCnpj, invoiceNumber: purchases.invoiceNumber, series: purchases.series,
    issuedAt: purchases.issuedAt, totalCents: purchases.totalCents, invoiceDiscountCents: purchases.invoiceDiscountCents,
    paymentMethod: purchases.paymentMethod, categoryId: purchases.categoryId, transactionId: purchases.transactionId,
    reconciledAt: purchases.reconciledAt, importedAt: purchases.importedAt,
  }).from(purchases).where(eq(purchases.id, id)).get();
  if (!purchase) throw notFound('Compra não encontrada.');
  const items = db
    .select({
      id: purchaseItems.id,
      purchaseId: purchaseItems.purchaseId,
      position: purchaseItems.position,
      description: purchaseItems.description,
      quantity: purchaseItems.quantity,
      unit: purchaseItems.unit,
      unitPriceCents: purchaseItems.unitPriceCents,
      discountCents: purchaseItems.discountCents,
      totalCents: purchaseItems.totalCents,
      categoryId: purchaseItems.categoryId,
      categoryName: categories.name,
      categoryColor: categories.color,
    })
    .from(purchaseItems)
    .leftJoin(categories, eq(categories.id, purchaseItems.categoryId))
    .where(eq(purchaseItems.purchaseId, id))
    .orderBy(purchaseItems.position)
    .all();
  return { ...purchase, items };
}

export function updatePurchaseItemsCategory(
  db: AppDatabase,
  purchaseId: number,
  rawItemIds: number[],
  categoryId: number | null,
) {
  const itemIds = [...new Set(rawItemIds)];
  if (itemIds.length === 0) throw badRequest('Selecione ao menos um item.');
  return db.transaction((tx) => {
    const purchase = tx.select({ id: purchases.id, transactionId: purchases.transactionId }).from(purchases).where(eq(purchases.id, purchaseId)).get();
    if (!purchase) throw notFound('Compra não encontrada.');
    if (categoryId !== null && !tx.select({ id: categories.id }).from(categories).where(eq(categories.id, categoryId)).get()) {
      throw badRequest('A categoria selecionada não existe.');
    }
    const owned = tx.select({ id: purchaseItems.id }).from(purchaseItems)
      .where(and(eq(purchaseItems.purchaseId, purchaseId), inArray(purchaseItems.id, itemIds))).all();
    if (owned.length !== itemIds.length) throw badRequest('Um ou mais itens não pertencem a esta compra.');
    const result = tx.update(purchaseItems).set({ categoryId, ...(purchase.transactionId !== null ? { reconciliationPreviousCategoryId: categoryId } : {}) })
      .where(and(eq(purchaseItems.purchaseId, purchaseId), inArray(purchaseItems.id, itemIds))).run();
    return { updated: result.changes };
  });
}

export function updatePurchaseCategory(db: AppDatabase, id: number, categoryId: number | null) {
  const purchase = db.select({ id: purchases.id, transactionId: purchases.transactionId }).from(purchases).where(eq(purchases.id, id)).get();
  if (!purchase) throw notFound('Compra não encontrada.');
  if (categoryId !== null && !db.select({ id: categories.id }).from(categories).where(eq(categories.id, categoryId)).get()) {
    throw badRequest('A categoria selecionada não existe.');
  }
  db.update(purchases).set({ categoryId, ...(purchase.transactionId !== null ? { reconciliationPreviousCategoryId: categoryId } : {}) }).where(eq(purchases.id, id)).run();
  return listPurchases(db).find((row) => row.id === id);
}

export function findPurchaseByAccessKey(db: AppDatabase, accessKey: string): number | null {
  return db.select({ id: purchases.id }).from(purchases).where(eq(purchases.accessKey, accessKey)).get()?.id ?? null;
}

export function importPurchase(db: AppDatabase, purchase: PurchaseInput) {
  try {
    return db.transaction((tx) => {
      const existing = tx
        .select({ id: purchases.id })
        .from(purchases)
        .where(eq(purchases.accessKey, purchase.accessKey))
        .get();
      if (existing) return { id: existing.id, duplicate: true };

      const inserted = tx
        .insert(purchases)
        .values({
          accessKey: purchase.accessKey,
          supplierName: purchase.supplierName,
          supplierCnpj: purchase.supplierCnpj,
          invoiceNumber: purchase.invoiceNumber,
          series: purchase.series,
          issuedAt: purchase.issuedAt,
          totalCents: purchase.totalCents,
          invoiceDiscountCents: purchase.invoiceDiscountCents,
          paymentMethod: purchase.paymentMethod,
        })
        .returning({ id: purchases.id })
        .get();
      tx.insert(purchaseItems)
        .values(purchase.items.map((item, index) => ({
          purchaseId: inserted.id,
          position: index + 1,
          description: item.description,
          quantity: item.quantity,
          unit: item.unit,
          unitPriceCents: item.unitPriceCents,
          discountCents: item.discountCents,
          totalCents: item.totalCents,
        })))
        .run();
      return { id: inserted.id, duplicate: false };
    });
  } catch (error) {
    if ((error as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') {
      const id = findPurchaseByAccessKey(db, purchase.accessKey);
      if (id) return { id, duplicate: true };
    }
    throw conflict('Não foi possível salvar a compra; nenhum dado financeiro foi criado.');
  }
}
