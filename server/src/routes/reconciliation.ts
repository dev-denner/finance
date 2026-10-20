import type { FastifyInstance } from 'fastify';
import type { AppDatabase } from '../db/client';
import {
  clearAllTransferRejections,
  clearTransferRejection,
  getReconciliation,
  rejectTransferPair,
} from '../services/reconciliation';
import {
  parseWith,
  reconciliationQuerySchema,
  transferRejectionSchema,
} from './validation';

export function registerReconciliationRoutes(app: FastifyInstance, db: AppDatabase): void {
  app.get('/api/transfers/reconciliation', async (request) => {
    const query = parseWith(
      reconciliationQuerySchema,
      request.query,
      'Parâmetros da conciliação inválidos.',
    );
    return getReconciliation(db, {
      toleranceDays: query.toleranceDays,
      includeRejected: query.includeRejected === true,
    });
  });

  app.post('/api/transfers/rejections', async (request, reply) => {
    const body = parseWith(transferRejectionSchema, request.body);
    const created = rejectTransferPair(
      db,
      body.outgoingTransactionId,
      body.incomingTransactionId,
    );
    return reply.status(201).send(created);
  });

  app.post('/api/transfers/rejections/clear', async (request) => {
    const body = parseWith(transferRejectionSchema, request.body);
    return clearTransferRejection(db, body.outgoingTransactionId, body.incomingTransactionId);
  });

  app.delete('/api/transfers/rejections', async () => clearAllTransferRejections(db));
}
