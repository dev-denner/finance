import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppDatabase } from '../db/client';
import { badRequest } from '../lib/errors';
import {
  FIELD_LABELS,
  IMPORT_FIELDS,
  deleteMappingTemplate,
  importWorkbook,
  listImportBatches,
  listMappingTemplates,
  previewImport,
  saveMappingTemplate,
  DEFAULT_TRANSFER_TOLERANCE_DAYS,
  type CategoryDecision,
  type CategoryDecisions,
  type ColumnMapping,
  type ImportField,
  type ImportOverrides,
  type TransferDecision,
} from '../services/import';

interface MultipartData {
  buffer: Buffer | null;
  filename: string | null;
  mapping?: unknown;
  overrides?: unknown;
  skipDuplicates?: boolean;
  rejectedRows?: unknown;
  includedDuplicateRows?: unknown;
  toleranceDays?: number;
  transferDecisions?: unknown;
  templateId?: number;
  destinationPaymentMethodId?: number;
  categoryDecisions?: unknown;
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw badRequest(`${label} inválido.`);
  }
}

function sanitizeMapping(input: unknown): ColumnMapping {
  const mapping: ColumnMapping = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return mapping;
  const source = input as Record<string, unknown>;
  for (const field of IMPORT_FIELDS) {
    if (!(field in source)) continue;
    const value = source[field];
    if (value === null || value === undefined || value === '') {
      mapping[field] = null;
    } else {
      const index = Number(value);
      if (!Number.isInteger(index) || index < 0) {
        throw badRequest(`Mapeamento inválido para "${FIELD_LABELS[field]}".`);
      }
      mapping[field] = index;
    }
  }
  return mapping;
}

function sanitizeOverrides(input: unknown): ImportOverrides {
  const overrides: ImportOverrides = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return overrides;
  const source = input as Record<string, unknown>;
  const entries = Object.entries(source).slice(0, 25_000);
  for (const [rowNumber, values] of entries) {
    if (!/^\d+$/.test(rowNumber) || !values || typeof values !== 'object' || Array.isArray(values)) {
      continue;
    }
    const cleaned: Partial<Record<ImportField, string>> = {};
    for (const field of IMPORT_FIELDS) {
      const value = (values as Record<string, unknown>)[field];
      if (value !== undefined) cleaned[field] = String(value);
    }
    overrides[rowNumber] = cleaned;
  }
  return overrides;
}

function sanitizeRejectedRows(input: unknown): number[] {
  if (!Array.isArray(input)) return [];
  return [
    ...new Set(
      input
        .map(Number)
        .filter((value) => Number.isInteger(value) && value > 0)
        .slice(0, 25_000),
    ),
  ];
}

function sanitizeIncludedDuplicateRows(input: unknown): number[] {
  if (!Array.isArray(input)) return [];
  return [
    ...new Set(
      input
        .map(Number)
        .filter((value) => Number.isInteger(value) && value > 0)
        .slice(0, 25_000),
    ),
  ];
}

function sanitizeDestinationPaymentMethodId(input: unknown): number | null | undefined {
  if (input === undefined || input === null || input === '') return undefined;
  const value = Number(input);
  if (!Number.isInteger(value) || value <= 0) return undefined;
  return value;
}

type CategoryAction = CategoryDecision['action'];

function parseCategoryAction(value: unknown): CategoryAction {
  if (
    value === 'accept' ||
    value === 'use' ||
    value === 'create' ||
    value === 'reject'
  ) {
    return value;
  }
  throw badRequest('Ação de decisão de categoria inválida.');
}

function parseSourceCategory(value: unknown, fallback: string | null): string {
  if (value === undefined || value === null) {
    if (fallback === null) throw badRequest('Decisão de categoria sem categoria de origem.');
    return fallback;
  }
  if (typeof value !== 'string') {
    throw badRequest('Categoria de origem inválida na decisão de categoria.');
  }
  const trimmed = value.trim();
  if (!trimmed) throw badRequest('Decisão de categoria sem categoria de origem.');
  return trimmed;
}

function parseTargetCategoryId(value: unknown, action: CategoryAction): number | null {
  if (value === undefined || value === null) {
    if (action === 'accept' || action === 'use') {
      throw badRequest('Decisão de categoria de aceite/uso exige categoria de destino.');
    }
    return null;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw badRequest('Categoria de destino inválida na decisão de categoria.');
  }
  return value;
}

function parseOptionalString(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw badRequest(`${label} inválido na decisão de categoria.`);
  return value;
}

function parseConfirmed(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw badRequest('Confirmação inválida na decisão de categoria.');
  }
  return value;
}

function sanitizeCategoryDecisions(input: unknown): CategoryDecisions | CategoryDecision[] | undefined {
  if (input === undefined || input === null) return undefined;
  if (typeof input !== 'object') throw badRequest('Decisões de categoria inválidas.');
  if (Array.isArray(input)) {
    const result: CategoryDecision[] = [];
    for (const item of input.slice(0, 5_000)) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw badRequest('Decisão de categoria inválida.');
      }
      const source = item as Record<string, unknown>;
      const action = parseCategoryAction(source.action);
      result.push({
        action,
        sourceCategory: parseSourceCategory(source.sourceCategory, null),
        targetCategoryId: parseTargetCategoryId(source.targetCategoryId, action),
        newCategoryName: parseOptionalString(source.newCategoryName, 'Nome da nova categoria'),
        confirmed: parseConfirmed(source.confirmed),
      });
    }
    return result;
  }
  const source = input as Record<string, unknown>;
  const result: CategoryDecisions = {};
  for (const [key, value] of Object.entries(source).slice(0, 5_000)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw badRequest('Decisão de categoria inválida.');
    }
    const item = value as Record<string, unknown>;
    const action = parseCategoryAction(item.action);
    result[key] = {
      action,
      sourceCategory: parseSourceCategory(item.sourceCategory, key),
      targetCategoryId: parseTargetCategoryId(item.targetCategoryId, action),
      newCategoryName: parseOptionalString(item.newCategoryName, 'Nome da nova categoria'),
      confirmed: parseConfirmed(item.confirmed),
    };
  }
  return result;
}

function sanitizeTolerance(input: unknown): number | undefined {
  if (input === undefined || input === null || input === '') return undefined;
  const value = Number(input);
  if (!Number.isInteger(value) || value < 0 || value > 31) return undefined;
  return value;
}

function sanitizeTransferDecisions(input: unknown): Record<string, TransferDecision> {
  const decisions: Record<string, TransferDecision> = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return decisions;
  const source = input as Record<string, unknown>;
  for (const [key, value] of Object.entries(source).slice(0, 5_000)) {
    if (value === 'confirm' || value === 'reject' || value === 'pending') {
      decisions[key] = value;
    }
  }
  return decisions;
}

async function readMultipart(request: FastifyRequest): Promise<MultipartData> {
  const data: MultipartData = { buffer: null, filename: null };

  for await (const part of request.parts()) {
    if (part.type === 'file') {
      if (part.fieldname !== 'file') continue;
      const buffer = await part.toBuffer();
      data.buffer = buffer;
      data.filename = part.filename || 'importacao';
      continue;
    }

    const value = String(part.value ?? '');
    switch (part.fieldname) {
      case 'mapping':
        if (value) data.mapping = parseJson(value, 'Mapeamento');
        break;
      case 'overrides':
        if (value) data.overrides = parseJson(value, 'Correções');
        break;
      case 'skipDuplicates':
        data.skipDuplicates = value === 'true';
        break;
      case 'rejectedRows':
        if (value) data.rejectedRows = parseJson(value, 'Linhas rejeitadas');
        break;
      case 'includedDuplicateRows':
        if (value) data.includedDuplicateRows = parseJson(value, 'Duplicatas aceitas');
        break;
      case 'toleranceDays':
        data.toleranceDays = sanitizeTolerance(value);
        break;
      case 'transferDecisions':
        if (value) data.transferDecisions = parseJson(value, 'Decisões de transferência');
        break;
      case 'templateId': {
        if (value === '' || value === undefined) break;
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed <= 0) {
          throw badRequest('Identificador de modelo de mapeamento inválido.');
        }
        data.templateId = parsed;
        break;
      }
      case 'destinationPaymentMethodId': {
        if (value === '' || value === undefined) break;
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed <= 0) {
          throw badRequest('Identificador de forma de pagamento de destino inválido.');
        }
        data.destinationPaymentMethodId = parsed;
        break;
      }
      case 'categoryDecisions': {
        if (value) data.categoryDecisions = parseJson(value, 'Decisões de categoria');
        break;
      }
      default:
        break;
    }
  }

  return data;
}

export function registerImportRoutes(app: FastifyInstance, db: AppDatabase): void {
  app.get('/api/imports', async () => ({ batches: listImportBatches(db) }));

  app.post('/api/imports/preview', async (request) => {
    const data = await readMultipart(request);
    if (!data.buffer) throw badRequest('Envie um arquivo CSV ou Excel.');
    const mapping =
      data.mapping === undefined ? undefined : sanitizeMapping(data.mapping);
    const overrides =
      data.overrides === undefined ? undefined : sanitizeOverrides(data.overrides);
    return previewImport(
      db,
      data.buffer,
      data.filename ?? 'importacao',
      mapping,
      overrides,
      data.toleranceDays ?? DEFAULT_TRANSFER_TOLERANCE_DAYS,
      data.templateId,
      {
        destinationPaymentMethodId: sanitizeDestinationPaymentMethodId(
          data.destinationPaymentMethodId,
        ),
        categoryDecisions: sanitizeCategoryDecisions(data.categoryDecisions),
      },
    );
  });

  app.post('/api/imports', async (request, reply) => {
    const data = await readMultipart(request);
    if (!data.buffer) throw badRequest('Envie um arquivo CSV ou Excel.');

    const summary = importWorkbook(db, data.buffer, data.filename ?? 'importacao', {
      mapping: sanitizeMapping(data.mapping),
      overrides: data.overrides === undefined ? undefined : sanitizeOverrides(data.overrides),
      skipDuplicates: data.skipDuplicates ?? true,
      rejectedRows:
        data.rejectedRows === undefined ? [] : sanitizeRejectedRows(data.rejectedRows),
      // Lista explícita: quando presente, o servidor decide o que é duplicata
      // intencional. Ausente, vale a semântica de `skipDuplicates`.
      includedDuplicateRows:
        data.includedDuplicateRows === undefined
          ? undefined
          : sanitizeIncludedDuplicateRows(data.includedDuplicateRows),
      transferToleranceDays: data.toleranceDays ?? DEFAULT_TRANSFER_TOLERANCE_DAYS,
      transferDecisions:
        data.transferDecisions === undefined
          ? undefined
          : sanitizeTransferDecisions(data.transferDecisions),
      templateId: data.templateId,
      destinationPaymentMethodId: sanitizeDestinationPaymentMethodId(data.destinationPaymentMethodId),
      categoryDecisions: sanitizeCategoryDecisions(data.categoryDecisions),
    });

    return reply.status(201).send(summary);
  });

  app.get('/api/imports/mappings', async () => ({ templates: listMappingTemplates(db) }));

  app.post('/api/imports/mappings', async (request) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const name = typeof body.name === 'string' ? body.name : '';
    const headers = Array.isArray(body.headers) ? body.headers.map(String) : [];
    const mapping = sanitizeMapping(body.mapping);
    return { template: saveMappingTemplate(db, { name, headers, mapping }) };
  });

  app.delete('/api/imports/mappings/:id', async (request) => {
    const params = request.params as { id: string };
    const id = Number(params.id);
    if (!Number.isInteger(id) || id <= 0) throw badRequest('Identificador inválido.');
    return deleteMappingTemplate(db, id);
  });
}
