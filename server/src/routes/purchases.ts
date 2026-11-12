import type { MultipartFile } from '@fastify/multipart';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppDatabase } from '../db/client';
import { badRequest } from '../lib/errors';
import { importNfceBatch, inspectNfceBatch, MAX_BATCH_FILE_BYTES, previewNfceBatch } from '../services/nfce-batch';
import { importPreviewedNfceForPurchase, previewNfceForPurchase } from '../services/nfce-adapters';
import { importCopiedNfceText, MAX_COPIED_NFCE_BLOCKS, MAX_COPIED_NFCE_TEXT_BYTES, previewCopiedNfceText } from '../services/nfce-copied-text';
import { extractNfcePdf, MAX_NFCE_PDF_BYTES } from '../services/nfce-pdf';
import { getPaymentBalanceHistory, getPurchaseReconciliationCandidates, reconcilePurchase, undoPurchaseReconciliation } from '../services/purchase-reconciliation';
import { findPurchaseByAccessKey, getPurchase, importPurchase, listPurchases, updatePurchaseCategory, updatePurchaseItemsCategory } from '../services/purchases';

const qrBody = z.object({ url: z.string().trim().min(1).max(2048) }).strict();
const qrImportBody = z.object({ previewToken: z.string().uuid() }).strict();
const copiedNfceTextBody = z.object({
  text: z.string().min(1).max(MAX_COPIED_NFCE_TEXT_BYTES),
}).strict();
const copiedNfceTextImportBody = copiedNfceTextBody.extend({
  blocks: z.array(z.number().int().positive()).min(1).max(MAX_COPIED_NFCE_BLOCKS),
}).strict();
const purchaseCategoryBody = z.object({ categoryId: z.number().int().positive().nullable() }).strict();
const reconcilePurchaseBody = z.object({
  transactionIds: z.array(z.number().int().positive()).max(100),
  walletPayments: z.array(z.object({
    paymentMethodId: z.number().int().positive(),
    amountCents: z.number().int().positive(),
    adjustment: z.object({
      amountCents: z.number().int().positive(),
      effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      reason: z.enum(['opening_balance', 'cashback', 'bonus', 'other']),
      description: z.string().trim().min(1).max(240),
    }).optional(),
  }).strict()).max(20),
  balanceAdjustments: z.array(z.object({
    paymentMethodId: z.number().int().positive(),
    amountCents: z.number().int().positive(),
    effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    reason: z.enum(['opening_balance', 'cashback', 'bonus', 'other']),
    description: z.string().trim().min(1).max(240),
  }).strict()).max(20).optional(),
  categoryId: z.number().int().positive().nullable(),
}).strict();
const purchaseItemsCategoryBody = z.object({
  itemIds: z.array(z.number().int().positive()).min(1).max(500),
  categoryId: z.number().int().positive().nullable(),
}).strict();

interface BatchMultipartData {
  buffer: Buffer | null;
  filename: string;
  column: number | null;
  lines: number[] | null;
}

/**
 * Lê o arquivo em memória com teto rígido de 1 MB, sem depender do limite
 * global do multipart. Ao exceder, interrompe a leitura e rejeita o lote.
 */
async function readBatchFile(part: MultipartFile): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of part.file) {
    total += (chunk as Buffer).length;
    if (total > MAX_BATCH_FILE_BYTES) {
      throw badRequest('O arquivo deve ter no máximo 1 MB.');
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/**
 * Lê o arquivo e os campos do lote. `column` é opcional (auto-detecção) e
 * `lines` traz somente os números de linha escolhidos na prévia.
 */
async function readBatchMultipart(request: FastifyRequest): Promise<BatchMultipartData> {
  const data: BatchMultipartData = { buffer: null, filename: '', column: null, lines: null };

  for await (const part of request.parts()) {
    if (part.type === 'file') {
      if (part.fieldname !== 'file') {
        part.file.resume();
        continue;
      }
      data.buffer = await readBatchFile(part);
      data.filename = part.filename ?? '';
      continue;
    }

    const value = String(part.value ?? '').trim();
    if (!value) continue;
    if (part.fieldname === 'column') {
      if (value === 'auto') continue;
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 0) throw badRequest('Coluna de URL inválida.');
      data.column = parsed;
      continue;
    }
    if (part.fieldname === 'lines') {
      let parsed: unknown;
      try {
        parsed = JSON.parse(value);
      } catch {
        throw badRequest('Seleção de linhas inválida.');
      }
      if (!Array.isArray(parsed) || parsed.some((line) => !Number.isInteger(line) || line <= 0)) {
        throw badRequest('Seleção de linhas inválida.');
      }
      data.lines = parsed as number[];
    }
  }

  return data;
}

export function registerPurchaseRoutes(app: FastifyInstance, db: AppDatabase) {
  app.get('/api/purchases', async () => listPurchases(db));

  app.patch('/api/purchases/:id/items/category', async (request) => {
    const { id: rawId } = request.params as { id: string };
    const id = Number(rawId);
    if (!Number.isInteger(id) || id <= 0) throw badRequest('Identificador inválido.');
    const parsed = purchaseItemsCategoryBody.safeParse(request.body);
    if (!parsed.success) throw badRequest('Selecione itens e uma categoria válida ou remova a categoria.');
    return updatePurchaseItemsCategory(db, id, parsed.data.itemIds, parsed.data.categoryId);
  });

  app.patch('/api/purchases/:id/category', async (request) => {
    const { id: rawId } = request.params as { id: string };
    const id = Number(rawId);
    if (!Number.isInteger(id) || id <= 0) throw badRequest('Identificador inválido.');
    const parsed = purchaseCategoryBody.safeParse(request.body);
    if (!parsed.success) throw badRequest('Selecione uma categoria válida ou remova a categoria.');
    return updatePurchaseCategory(db, id, parsed.data.categoryId);
  });

  app.get('/api/purchases/:id/reconciliation/candidates', async (request) => {
    const { id: rawId } = request.params as { id: string };
    const id = Number(rawId);
    if (!Number.isInteger(id) || id <= 0) throw badRequest('Identificador inválido.');
    return getPurchaseReconciliationCandidates(db, id);
  });

  app.get('/api/payment-methods/:id/balance-history', async (request) => {
    const { id: rawId } = request.params as { id: string };
    const id = Number(rawId);
    if (!Number.isInteger(id) || id <= 0) throw badRequest('Identificador inválido.');
    return getPaymentBalanceHistory(db, id);
  });

  app.post('/api/purchases/:id/reconciliation', async (request) => {
    const { id: rawId } = request.params as { id: string };
    const id = Number(rawId);
    if (!Number.isInteger(id) || id <= 0) throw badRequest('Identificador inválido.');
    const parsed = reconcilePurchaseBody.safeParse(request.body);
    if (!parsed.success) throw badRequest('Revise os pagamentos e a categoria selecionada.');
    return reconcilePurchase(db, id, parsed.data);
  });

  app.delete('/api/purchases/:id/reconciliation', async (request) => {
    const { id: rawId } = request.params as { id: string };
    const id = Number(rawId);
    if (!Number.isInteger(id) || id <= 0) throw badRequest('Identificador inválido.');
    return undoPurchaseReconciliation(db, id);
  });

  app.get('/api/purchases/:id', async (request) => {
    const { id: rawId } = request.params as { id: string };
    const id = Number(rawId);
    if (!Number.isInteger(id) || id <= 0) throw badRequest('Identificador inválido.');
    return getPurchase(db, id);
  });

  app.post('/api/purchases/preview', async (request) => {
    const parsed = qrBody.safeParse(request.body);
    if (!parsed.success) throw badRequest('Informe a URL do QR Code da NFC-e.');
    return previewNfceForPurchase(db, parsed.data.url);
  });

  app.post('/api/purchases/import', async (request, reply) => {
    const parsed = qrImportBody.safeParse(request.body);
    if (!parsed.success) throw badRequest('Faça uma nova prévia antes de importar a NFC-e.');
    const result = importPreviewedNfceForPurchase(db, parsed.data.previewToken);
    return reply.status(result.duplicate ? 200 : 201).send(result);
  });

  app.post('/api/purchases/pdf/preview', async (request) => {
    const { state, purchase } = await extractNfcePdf(await readNfcePdf(request));
    const existingPurchaseId = findPurchaseByAccessKey(db, purchase.accessKey);
    return { state, purchase: existingPurchaseId === null ? purchase : null, alreadyImported: existingPurchaseId !== null, existingPurchaseId };
  });

  app.post('/api/purchases/pdf/import', async (request, reply) => {
    const { purchase } = await extractNfcePdf(await readNfcePdf(request));
    const result = importPurchase(db, purchase);
    return reply.status(result.duplicate ? 200 : 201).send(result);
  });

  app.post('/api/purchases/copied-text/preview', async (request) => {
    const parsed = copiedNfceTextBody.safeParse(request.body);
    if (!parsed.success) throw badRequest('Cole o texto das notas para conferir a prévia.');
    return previewCopiedNfceText(db, parsed.data.text);
  });

  app.post('/api/purchases/copied-text/import', async (request) => {
    const parsed = copiedNfceTextImportBody.safeParse(request.body);
    if (!parsed.success) throw badRequest('Selecione ao menos um bloco válido para importar.');
    return importCopiedNfceText(db, parsed.data.text, parsed.data.blocks);
  });

  app.post('/api/purchases/batch/inspect', async (request) => {
    const data = await readBatchMultipart(request);
    if (!data.buffer) throw badRequest('Envie um arquivo CSV ou TXT.');
    return { inspection: inspectNfceBatch(data.buffer, data.filename) };
  });

  app.post('/api/purchases/batch/preview', async (request) => {
    const data = await readBatchMultipart(request);
    if (!data.buffer) throw badRequest('Envie um arquivo CSV ou TXT.');
    return previewNfceBatch(db, data.buffer, data.filename, { column: data.column });
  });

  app.post('/api/purchases/batch/import', async (request) => {
    const data = await readBatchMultipart(request);
    if (!data.buffer) throw badRequest('Envie um arquivo CSV ou TXT.');
    if (!data.lines) throw badRequest('Selecione ao menos uma linha para importar.');
    return importNfceBatch(db, data.buffer, data.filename, {
      column: data.column,
      lines: data.lines,
    });
  });
}

async function readNfcePdf(request: FastifyRequest): Promise<Buffer> {
  let buffer: Buffer | null = null;
  for await (const part of request.parts()) {
    if (part.type !== 'file') continue;
    if (part.fieldname !== 'file' || buffer !== null) { part.file.resume(); continue; }
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of part.file) {
      const data = chunk as Buffer;
      total += data.length;
      if (total > MAX_NFCE_PDF_BYTES) throw badRequest('O PDF deve ter no máximo 5 MB.');
      chunks.push(data);
    }
    buffer = Buffer.concat(chunks);
  }
  if (!buffer) throw badRequest('Selecione um arquivo PDF de NFC-e.');
  return buffer;
}
