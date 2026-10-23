import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { ZodError } from 'zod';
import type { AppDatabase } from './db/client';
import { HttpError } from './lib/errors';
import { registerBillRoutes } from './routes/bills';
import { registerConsolidationRoutes } from './routes/consolidation';
import { registerImportRoutes } from './routes/imports';
import { registerInstallmentRoutes } from './routes/installments';
import { registerMetaRoutes } from './routes/meta';
import { registerPurchaseRoutes } from './routes/purchases';
import { registerReconciliationRoutes } from './routes/reconciliation';
import { registerLookupRoutes, registerTransactionRoutes } from './routes/transactions';

export interface BuildAppOptions {
  db: AppDatabase;
  logger?: boolean;
  staticDir?: string;
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 25 * 1024 * 1024,
  });

  await app.register(fastifyMultipart, {
    limits: {
      fileSize: 25 * 1024 * 1024,
      files: 1,
      fields: 20,
    },
  });

  registerMetaRoutes(app, options.db);
  registerPurchaseRoutes(app, options.db);
  registerTransactionRoutes(app, options.db);
  registerLookupRoutes(app, options.db);
  registerBillRoutes(app, options.db);
  registerImportRoutes(app, options.db);
  registerConsolidationRoutes(app, options.db);
  registerReconciliationRoutes(app, options.db);
  registerInstallmentRoutes(app, options.db);

  if (options.staticDir && fs.existsSync(options.staticDir)) {
    await app.register(fastifyStatic, {
      root: options.staticDir,
      prefix: '/',
      wildcard: false,
    });

    app.setNotFoundHandler((request, reply) => {
      if (request.raw.url?.startsWith('/api/')) {
        return reply.status(404).send({ error: 'Rota não encontrada.' });
      }
      return reply.sendFile('index.html');
    });
  }

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof HttpError) {
      return reply.status(error.statusCode).send({
        error: error.message,
        issues: error.issues,
      });
    }

    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: 'Dados inválidos.',
        issues: error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }

    if ((error as { statusCode?: number }).statusCode === 413) {
      return reply.status(413).send({ error: 'Arquivo muito grande (limite de 25 MB).' });
    }

    if ((error as { code?: string }).code?.startsWith('SQLITE_CONSTRAINT')) {
      return reply.status(409).send({
        error: 'A operação viola uma restrição do banco de dados.',
      });
    }

    request.log.error(error);
    return reply.status(500).send({ error: 'Erro interno ao processar a solicitação.' });
  });

  return app;
}
