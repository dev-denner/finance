import type { FastifyInstance } from 'fastify';
import type { AppDatabase } from '../db/client';
import { transactions } from '../db/schema';
import { max } from 'drizzle-orm';
import { getAccountCashFlow, getAnnualConsolidation } from '../services/consolidation';
import { listTransactions } from '../services/transactions';
import { consolidationSchema, parseWith } from './validation';
import { z } from 'zod';

const detailsSchema = consolidationSchema.extend({
  month: z.coerce.number().int().min(1).max(12),
  categoryId: z.coerce.number().int().positive(),
});

function latestYear(db: AppDatabase): number {
  const latest = db
    .select({ value: max(transactions.dueDate) })
    .from(transactions)
    .get()?.value;
  if (latest) return Number(latest.slice(0, 4));
  return new Date().getFullYear();
}

export function registerConsolidationRoutes(app: FastifyInstance, db: AppDatabase): void {
  app.get('/api/consolidation', async (request) => {
    const query = parseWith(consolidationSchema, request.query, 'Parâmetros inválidos.');
    const year = query.year ?? latestYear(db);
    return getAnnualConsolidation(db, year, query.dateField ?? 'due', query.kind ?? 'expenses');
  });

  app.get('/api/consolidation/cash-flow', async (request) => {
    const query = parseWith(consolidationSchema, request.query, 'Parâmetros inválidos.');
    const year = query.year ?? latestYear(db);
    return getAccountCashFlow(db, year, query.dateField ?? 'due');
  });

  app.get('/api/consolidation/details', async (request) => {
    const query = parseWith(detailsSchema, request.query, 'Parâmetros inválidos.');
    const result = listTransactions(db, {
      year: query.year ?? latestYear(db),
      month: query.month,
      categoryId: query.categoryId,
      dateField: query.dateField ?? 'due',
      kind: query.kind ?? 'expenses',
      sortBy: 'dueDate',
      sortDir: 'asc',
      page: 1,
      pageSize: 200,
    });
    return result;
  });
}
