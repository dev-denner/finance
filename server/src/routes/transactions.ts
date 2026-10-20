import type { FastifyInstance } from 'fastify';
import type { AppDatabase } from '../db/client';
import { badRequest } from '../lib/errors';
import {
  createLookup,
  deleteLookup,
  listLookups,
  renameLookup,
  type LookupKind,
} from '../services/lookups';
import {
  bulkDeleteSchema,
  bulkTransactionSchema,
  listTransactionsSchema,
  lookupWriteSchema,
  parseWith,
  transactionWriteSchema,
  transferCandidatesSchema,
  transferLinkSchema,
} from './validation';
import {
  bulkDeleteTransactions,
  bulkUpdateTransactions,
  createTransaction,
  deleteTransaction,
  getTransaction,
  listTransactions,
  updateTransaction,
} from '../services/transactions';
import { linkTransfer, unlinkTransfer } from '../services/transfers';
import { detectCandidatesForTransaction } from '../services/transfer-detection';
import { isPairRejected } from '../services/reconciliation';

export function registerTransactionRoutes(app: FastifyInstance, db: AppDatabase): void {
  app.get('/api/transactions', async (request) => {
    const query = parseWith(listTransactionsSchema, request.query, 'Filtros inválidos.');
    return listTransactions(db, query);
  });

  app.get<{ Params: { id: string } }>('/api/transactions/:id', async (request) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id <= 0) throw badRequest('Lançamento inválido.');
    return getTransaction(db, id);
  });

  app.post('/api/transactions', async (request, reply) => {
    const body = parseWith(transactionWriteSchema, request.body);
    const created = createTransaction(db, body);
    return reply.status(201).send(created);
  });

  app.patch<{ Params: { id: string } }>('/api/transactions/:id', async (request) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id <= 0) throw badRequest('Lançamento inválido.');
    const body = parseWith(transactionWriteSchema, request.body);
    return updateTransaction(db, id, body);
  });

  app.delete<{ Params: { id: string } }>('/api/transactions/:id', async (request) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id <= 0) throw badRequest('Lançamento inválido.');
    deleteTransaction(db, id);
    return { ok: true };
  });

  app.patch('/api/transactions/bulk', async (request) => {
    const body = parseWith(bulkTransactionSchema, request.body);
    const updated = bulkUpdateTransactions(db, body.ids, {
      categoryId: body.categoryId,
      paymentMethodId: body.paymentMethodId,
    });
    return { updated };
  });

  app.post('/api/transactions/bulk-delete', async (request) => {
    const body = parseWith(bulkDeleteSchema, request.body);
    const deleted = bulkDeleteTransactions(db, body.ids);
    return { deleted };
  });

  app.get<{ Params: { id: string } }>(
    '/api/transactions/:id/transfer-candidates',
    async (request) => {
      const id = Number(request.params.id);
      if (!Number.isInteger(id) || id <= 0) throw badRequest('Lançamento inválido.');
      const query = parseWith(transferCandidatesSchema, request.query, 'Parâmetros inválidos.');
      const candidates = detectCandidatesForTransaction(db, id, query).filter((candidate) => {
        const outgoingId = candidate.outgoing.transactionId;
        const incomingId = candidate.incoming.transactionId;
        if (outgoingId === null || incomingId === null) return true;
        return !isPairRejected(db, outgoingId, incomingId);
      });
      return { candidates };
    },
  );

  app.post('/api/transfers', async (request, reply) => {
    const body = parseWith(transferLinkSchema, request.body);
    const created = linkTransfer(db, body);
    return reply.status(201).send(created);
  });

  app.delete<{ Params: { id: string } }>('/api/transfers/:id', async (request) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id <= 0) throw badRequest('Transferência inválida.');
    return unlinkTransfer(db, id);
  });
}

const LOOKUP_CONFIGS: { kind: LookupKind; base: string }[] = [
  { kind: 'category', base: '/api/categories' },
  { kind: 'payment', base: '/api/payment-methods' },
];

export function registerLookupRoutes(app: FastifyInstance, db: AppDatabase): void {
  for (const config of LOOKUP_CONFIGS) {
    app.get(config.base, async () => listLookups(db, config.kind));

    app.post(config.base, async (request, reply) => {
      const body = parseWith(lookupWriteSchema, request.body);
      const created = createLookup(db, config.kind, body.name, body.color, body.classification);
      return reply.status(201).send(created);
    });

    app.patch<{ Params: { id: string } }>(`${config.base}/:id`, async (request) => {
      const id = Number(request.params.id);
      if (!Number.isInteger(id) || id <= 0) throw badRequest('Registro inválido.');
      const body = parseWith(lookupWriteSchema, request.body);
      return renameLookup(db, config.kind, id, body.name, body.color, body.classification);
    });

    app.delete<{ Params: { id: string }; Querystring: { reassignTo?: string } }>(
      `${config.base}/:id`,
      async (request) => {
        const id = Number(request.params.id);
        if (!Number.isInteger(id) || id <= 0) throw badRequest('Registro inválido.');
        const rawTarget = request.query.reassignTo;
        const reassignTo =
          rawTarget === undefined || rawTarget === '' ? undefined : Number(rawTarget);
        if (reassignTo !== undefined && (!Number.isInteger(reassignTo) || reassignTo <= 0)) {
          throw badRequest('Registro de destino inválido.');
        }
        return deleteLookup(db, config.kind, id, reassignTo);
      },
    );
  }
}
