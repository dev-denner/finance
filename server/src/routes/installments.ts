import type { FastifyInstance } from 'fastify';
import type { AppDatabase } from '../db/client';
import {
  applyInstallmentRecovery,
  findInstallmentRecoveryProposals,
} from '../services/installment-recovery';
import { installmentRecoveryApplySchema, parseWith } from './validation';

export function registerInstallmentRoutes(app: FastifyInstance, db: AppDatabase): void {
  app.get('/api/installments/recovery', async () => ({
    proposals: findInstallmentRecoveryProposals(db),
  }));

  app.post('/api/installments/recovery', async (request) => {
    const body = parseWith(installmentRecoveryApplySchema, request.body);
    return applyInstallmentRecovery(db, body.ids);
  });
}
