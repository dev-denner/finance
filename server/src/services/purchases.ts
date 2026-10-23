import { desc, eq, sql } from 'drizzle-orm';
import type { AppDatabase } from '../db/client';
import { purchaseItems, purchases } from '../db/schema';
import { conflict, notFound } from '../lib/errors';
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
      paymentMethod: purchases.paymentMethod,
      importedAt: purchases.importedAt,
      itemCount: sql<number>`count(${purchaseItems.id})`,
    })
    .from(purchases)
    .leftJoin(purchaseItems, eq(purchaseItems.purchaseId, purchases.id))
    .groupBy(purchases.id)
    .orderBy(desc(purchases.issuedAt), desc(purchases.id))
    .all();
}

export function getPurchase(db: AppDatabase, id: number) {
  const purchase = db.select().from(purchases).where(eq(purchases.id, id)).get();
  if (!purchase) throw notFound('Compra não encontrada.');
  const items = db
    .select()
    .from(purchaseItems)
    .where(eq(purchaseItems.purchaseId, id))
    .orderBy(purchaseItems.position)
    .all();
  return { ...purchase, items };
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
