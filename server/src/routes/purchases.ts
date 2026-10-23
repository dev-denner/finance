import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDatabase } from '../db/client';
import { badRequest } from '../lib/errors';
import { findPurchaseByAccessKey, getPurchase, importPurchase, listPurchases } from '../services/purchases';
import { previewRjNfce } from '../services/rj-nfce';

const qrBody = z.object({ url: z.string().trim().min(1).max(2048) }).strict();

export function registerPurchaseRoutes(app: FastifyInstance, db: AppDatabase) {
  app.get('/api/purchases', async () => listPurchases(db));

  app.get('/api/purchases/:id', async (request) => {
    const { id: rawId } = request.params as { id: string };
    const id = Number(rawId);
    if (!Number.isInteger(id) || id <= 0) throw badRequest('Identificador inválido.');
    return getPurchase(db, id);
  });

  app.post('/api/purchases/preview', async (request) => {
    const parsed = qrBody.safeParse(request.body);
    if (!parsed.success) throw badRequest('Informe a URL do QR Code da NFC-e.');
    const purchase = await previewRjNfce(parsed.data.url);
    const existingPurchaseId = findPurchaseByAccessKey(db, purchase.accessKey);
    return { purchase, alreadyImported: existingPurchaseId !== null };
  });

  app.post('/api/purchases/import', async (request, reply) => {
    const parsed = qrBody.safeParse(request.body);
    if (!parsed.success) throw badRequest('Informe a URL do QR Code da NFC-e.');
    const purchase = await previewRjNfce(parsed.data.url);
    const result = importPurchase(db, purchase);
    return reply.status(result.duplicate ? 200 : 201).send(result);
  });
}
