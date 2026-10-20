import type { FastifyInstance } from 'fastify';
import { max, sql } from 'drizzle-orm';
import type { AppDatabase } from '../db/client';
import { transactions } from '../db/schema';
import { listLookups } from '../services/lookups';

export function registerMetaRoutes(app: FastifyInstance, db: AppDatabase): void {
  app.get('/api/health', async () => ({ ok: true }));

  app.get('/api/meta', async () => {
    const categoryList = listLookups(db, 'category');
    const paymentList = listLookups(db, 'payment');

    const yearRows = db
      .select({ year: sql<string>`substr(${transactions.dueDate}, 1, 4)` })
      .from(transactions)
      .groupBy(sql`substr(${transactions.dueDate}, 1, 4)`)
      .all();
    const purchaseYearRows = db
      .select({ year: sql<string>`substr(${transactions.purchaseDate}, 1, 4)` })
      .from(transactions)
      .groupBy(sql`substr(${transactions.purchaseDate}, 1, 4)`)
      .all();

    const years = [...new Set([...yearRows, ...purchaseYearRows].map((row) => Number(row.year)))]
      .filter((year) => Number.isFinite(year))
      .sort((a, b) => b - a);

    const dueAggregate = db
      .select({ latest: max(transactions.dueDate) })
      .from(transactions)
      .get();
    const purchaseAggregate = db
      .select({ latest: max(transactions.purchaseDate) })
      .from(transactions)
      .get();
    const countAggregate = db
      .select({ value: sql<number>`count(*)` })
      .from(transactions)
      .get();

    return {
      categories: categoryList,
      paymentMethods: paymentList,
      years,
      latestDueDate: dueAggregate?.latest ?? null,
      latestPurchaseDate: purchaseAggregate?.latest ?? null,
      transactionCount: countAggregate?.value ?? 0,
    };
  });
}
