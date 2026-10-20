import type { FastifyInstance } from 'fastify';
import type { AppDatabase } from '../db/client';
import { badRequest } from '../lib/errors';
import {
  BILL_FIELD_LABELS,
  BILL_IMPORT_FIELDS,
  importBills,
  previewBillsImport,
  type BillImportField,
  type BillImportOptions,
} from '../services/bills-import';
import {
  createBill,
  deleteBill,
  getBill,
  listBills,
  repeatBill,
  setBillStatus,
  updateBill,
} from '../services/bills';
import type { ColumnMapping } from '../services/import';

interface MultipartData {
  buffer: Buffer | null;
  filename: string | null;
  mapping?: unknown;
  overrides?: unknown;
  skipDuplicates?: boolean;
  rejectedRows?: unknown;
}

async function readMultipart(request: any): Promise<MultipartData> {
  const data: MultipartData = { buffer: null, filename: null };
  const parts = request.parts();
  for await (const part of parts) {
    if (part.type === 'file') {
      const chunks: Buffer[] = [];
      for await (const chunk of part.file) chunks.push(chunk);
      data.buffer = Buffer.concat(chunks);
      data.filename = part.filename;
    } else {
      const value = part.value;
      switch (part.fieldname) {
        case 'mapping':
          if (value) data.mapping = JSON.parse(String(value));
          break;
        case 'overrides':
          if (value) data.overrides = JSON.parse(String(value));
          break;
        case 'skipDuplicates':
          data.skipDuplicates = String(value) === 'true';
          break;
        case 'rejectedRows':
          if (value) data.rejectedRows = JSON.parse(String(value));
          break;
        default:
          break;
      }
    }
  }
  return data;
}

function sanitizeMapping(input: unknown): Partial<Record<BillImportField, number | null>> {
  const mapping: Partial<Record<BillImportField, number | null>> = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return mapping;
  const source = input as Record<string, unknown>;
  for (const field of BILL_IMPORT_FIELDS) {
    const value = source[field];
    if (value === null || value === undefined || value === '') {
      mapping[field] = null;
    } else {
      const num = Number(value);
      if (Number.isInteger(num) && num >= 0) mapping[field] = num;
    }
  }
  return mapping;
}

function sanitizeOverrides(input: unknown): Record<string, Partial<Record<BillImportField, string>>> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const result: Record<string, Partial<Record<BillImportField, string>>> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const override: Partial<Record<BillImportField, string>> = {};
    for (const field of BILL_IMPORT_FIELDS) {
      const cell = (value as Record<string, unknown>)[field];
      if (cell !== undefined && cell !== null) override[field] = String(cell);
    }
    result[key] = override;
  }
  return result;
}

function sanitizeRejectedRows(input: unknown): number[] {
  if (!Array.isArray(input)) return [];
  return input.map(Number).filter((n) => Number.isInteger(n) && n > 0);
}

export function registerBillRoutes(app: FastifyInstance, db: AppDatabase) {
  app.get('/api/bills', async (request) => {
    const query = request.query as { year?: string; month?: string };
    const now = new Date();
    const year = query.year ? Number(query.year) : now.getFullYear();
    const month = query.month ? Number(query.month) : now.getMonth() + 1;
    if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
      throw badRequest('Mês ou ano inválido.');
    }
    return listBills(db, year, month);
  });

  app.post('/api/bills', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const bill = createBill(db, {
      description: body.description,
      amountCents: body.amountCents,
      amount: body.amount,
      dueDate: body.dueDate,
      categoryId: body.categoryId,
      status: body.status,
    });
    return reply.status(201).send({ bill });
  });

  app.put('/api/bills/:id', async (request) => {
    const params = request.params as { id: string };
    const id = Number(params.id);
    if (!Number.isInteger(id) || id <= 0) throw badRequest('Identificador inválido.');
    const body = (request.body ?? {}) as Record<string, unknown>;
    const bill = updateBill(db, id, {
      description: body.description,
      amountCents: body.amountCents,
      amount: body.amount,
      dueDate: body.dueDate,
      categoryId: body.categoryId,
      status: body.status,
    });
    return { bill };
  });

  app.delete('/api/bills/:id', async (request) => {
    const params = request.params as { id: string };
    const id = Number(params.id);
    if (!Number.isInteger(id) || id <= 0) throw badRequest('Identificador inválido.');
    return deleteBill(db, id);
  });

  app.post('/api/bills/:id/status', async (request) => {
    const params = request.params as { id: string };
    const id = Number(params.id);
    if (!Number.isInteger(id) || id <= 0) throw badRequest('Identificador inválido.');
    const body = (request.body ?? {}) as Record<string, unknown>;
    return setBillStatus(db, id, body.status);
  });

  app.post('/api/bills/:id/repeat', async (request) => {
    const params = request.params as { id: string };
    const id = Number(params.id);
    if (!Number.isInteger(id) || id <= 0) throw badRequest('Identificador inválido.');
    return repeatBill(db, id);
  });

  app.post('/api/bills/import/preview', async (request) => {
    const data = await readMultipart(request);
    if (!data.buffer) throw badRequest('Envie um arquivo CSV ou Excel.');
    const mapping = data.mapping === undefined ? undefined : sanitizeMapping(data.mapping);
    const overrides = data.overrides === undefined ? undefined : sanitizeOverrides(data.overrides);
    return previewBillsImport(db, data.buffer, data.filename ?? 'importacao', mapping, overrides);
  });

  app.post('/api/bills/import', async (request, reply) => {
    const data = await readMultipart(request);
    if (!data.buffer) throw badRequest('Envie um arquivo CSV ou Excel.');
    const summary = importBills(db, data.buffer, data.filename ?? 'importacao', {
      mapping: sanitizeMapping(data.mapping),
      overrides: data.overrides === undefined ? undefined : sanitizeOverrides(data.overrides),
      skipDuplicates: data.skipDuplicates ?? true,
      rejectedRows: data.rejectedRows === undefined ? [] : sanitizeRejectedRows(data.rejectedRows),
    } as BillImportOptions);
    return reply.status(201).send(summary);
  });
}
