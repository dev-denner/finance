import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppDatabase } from '../db/client';
import { badRequest } from '../lib/errors';
import {
  BILL_IMPORT_FIELDS,
  importBills,
  previewBillsImport,
  type BillImportField,
} from '../services/bills-import';
import {
  createBill,
  createTemplate,
  deleteBill,
  deleteTemplate,
  getAgenda,
  getBill,
  getForecast,
  getTemplate,
  listBills,
  listTemplates,
  payBill,
  previewTemplateDates,
  scheduleBill,
  skipBill,
  unpayBill,
  unskipBill,
  updateBill,
  updateTemplate,
} from '../services/bills';
import { parseJsonField, readMultipartForm } from './multipart';
import {
  billAgendaQuerySchema,
  billCreateSchema,
  billForecastQuerySchema,
  billListQuerySchema,
  billTemplateCreateSchema,
  billTemplateListQuerySchema,
  billTemplateUpdateQuerySchema,
  billTemplateUpdateSchema,
  billUpdateSchema,
  idParamSchema,
  parseWith,
  payBillSchema,
  scheduleBillSchema,
} from './validation';

type BillMapping = Partial<Record<BillImportField, number | null>>;
type BillOverrides = Record<string, Partial<Record<BillImportField, string>>>;

function sanitizeMapping(input: unknown): BillMapping {
  const mapping: BillMapping = {};
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

function sanitizeOverrides(input: unknown): BillOverrides {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const result: BillOverrides = {};
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

async function readBillImportForm(request: FastifyRequest) {
  const form = await readMultipartForm(request);
  if (!form.file) throw badRequest('Envie um arquivo CSV ou Excel.');
  const mapping = parseJsonField(form.fields.get('mapping'), 'Mapeamento');
  const overrides = parseJsonField(form.fields.get('overrides'), 'Correções');
  const rejectedRows = parseJsonField(form.fields.get('rejectedRows'), 'Linhas rejeitadas');
  const skipDuplicates = form.fields.get('skipDuplicates');
  return {
    buffer: form.file.buffer,
    filename: form.file.filename,
    mapping: mapping === undefined ? undefined : sanitizeMapping(mapping),
    overrides: overrides === undefined ? undefined : sanitizeOverrides(overrides),
    rejectedRows: rejectedRows === undefined ? [] : sanitizeRejectedRows(rejectedRows),
    skipDuplicates: skipDuplicates === undefined ? true : skipDuplicates === 'true',
  };
}

function idOf(request: FastifyRequest): number {
  return parseWith(idParamSchema, request.params, 'Identificador inválido.').id;
}

export function registerBillRoutes(app: FastifyInstance, db: AppDatabase) {
  // ---- Ocorrências -------------------------------------------------------

  app.get('/api/bills', async (request) => {
    const query = parseWith(billListQuerySchema, request.query, 'Filtros de contas inválidos.');
    const now = new Date();
    return listBills(db, query.year ?? now.getFullYear(), query.month ?? now.getMonth() + 1, {
      state: query.state,
      search: query.q,
      categoryId: query.categoryId,
    });
  });

  app.get('/api/bills/agenda', async (request) => {
    const query = parseWith(billAgendaQuerySchema, request.query, 'Parâmetros da agenda inválidos.');
    return getAgenda(db, { days: query.days });
  });

  app.get('/api/bills/forecast', async (request) => {
    const query = parseWith(billForecastQuerySchema, request.query, 'Parâmetros da previsão inválidos.');
    return getForecast(db, { months: query.months });
  });

  app.get('/api/bills/:id', async (request) => ({ bill: getBill(db, idOf(request)) }));

  app.post('/api/bills', async (request, reply) => {
    const body = parseWith(billCreateSchema, request.body, 'Dados da conta inválidos.');
    return reply.status(201).send({ bill: createBill(db, body) });
  });

  app.put('/api/bills/:id', async (request) => {
    const id = idOf(request);
    const body = parseWith(billUpdateSchema, request.body ?? {}, 'Dados da conta inválidos.');
    return { bill: updateBill(db, id, body) };
  });

  /** Conta avulsa é apagada; ocorrência de recorrência vira pulada (a série não a recria). */
  app.delete('/api/bills/:id', async (request) => deleteBill(db, idOf(request)));

  app.post('/api/bills/:id/pay', async (request) => {
    const id = idOf(request);
    const body = parseWith(payBillSchema, request.body, 'Dados do pagamento inválidos.');
    return { bill: payBill(db, id, body) };
  });

  app.post('/api/bills/:id/unpay', async (request) => ({ bill: unpayBill(db, idOf(request)) }));

  app.post('/api/bills/:id/skip', async (request) => ({ bill: skipBill(db, idOf(request)) }));

  app.post('/api/bills/:id/unskip', async (request) => ({ bill: unskipBill(db, idOf(request)) }));

  app.post('/api/bills/:id/schedule', async (request) => {
    const id = idOf(request);
    const body = parseWith(scheduleBillSchema, request.body, 'Data de agendamento inválida.');
    return { bill: scheduleBill(db, id, body.scheduledFor) };
  });

  // ---- Importação de contas ---------------------------------------------

  app.post('/api/bills/import/preview', async (request) => {
    const form = await readBillImportForm(request);
    return previewBillsImport(db, form.buffer, form.filename, form.mapping, form.overrides);
  });

  app.post('/api/bills/import', async (request, reply) => {
    const form = await readBillImportForm(request);
    const summary = importBills(db, form.buffer, form.filename, {
      mapping: form.mapping ?? {},
      overrides: form.overrides,
      skipDuplicates: form.skipDuplicates,
      rejectedRows: form.rejectedRows,
    });
    return reply.status(201).send(summary);
  });

  // ---- Recorrências ------------------------------------------------------

  app.get('/api/bill-templates', async (request) => {
    const query = parseWith(billTemplateListQuerySchema, request.query, 'Filtros inválidos.');
    return { templates: listTemplates(db, { includeInactive: query.includeInactive === true }) };
  });

  /** Próximas datas que a regra geraria, sem gravar (prévia do formulário). */
  app.post('/api/bill-templates/preview', async (request) => {
    const body = parseWith(billTemplateCreateSchema, request.body, 'Dados da recorrência inválidos.');
    return { dates: previewTemplateDates(db, body) };
  });

  app.get('/api/bill-templates/:id', async (request) => ({ template: getTemplate(db, idOf(request)) }));

  app.post('/api/bill-templates', async (request, reply) => {
    const body = parseWith(billTemplateCreateSchema, request.body, 'Dados da recorrência inválidos.');
    return reply.status(201).send({ template: createTemplate(db, body) });
  });

  /** `scope=all` altera a regra em vigor; `scope=future&from=AAAA-MM-DD` divide a série. */
  app.put('/api/bill-templates/:id', async (request) => {
    const id = idOf(request);
    const query = parseWith(billTemplateUpdateQuerySchema, request.query, 'Escopo da alteração inválido.');
    const body = parseWith(billTemplateUpdateSchema, request.body ?? {}, 'Dados da recorrência inválidos.');
    return { template: updateTemplate(db, id, body, { scope: query.scope, from: query.from }) };
  });

  app.delete('/api/bill-templates/:id', async (request) => deleteTemplate(db, idOf(request)));
}
