import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import type { DatabaseHandle } from '../src/db/client';
import { addMonthsIso, todayIso } from '../src/lib/dates';
import { ensureLookup } from '../src/services/lookups';
import { createTestDatabase, makeCsv, seedTransaction } from './helpers';

/** As rotas usam a data real; os cenários são montados relativos a hoje. */
const TODAY = todayIso();

function shiftDays(iso: string, days: number): string {
  const [year, month, day] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day) + days * 86_400_000);
  return date.toISOString().slice(0, 10);
}

function multipart(parts: { name: string; value: string; filename?: string }[]) {
  const boundary = 'billsroutesboundary';
  const body = parts
    .map((part) => {
      const disposition = part.filename
        ? `form-data; name="${part.name}"; filename="${part.filename}"`
        : `form-data; name="${part.name}"`;
      const contentType = part.filename ? 'Content-Type: text/csv\r\n' : '';
      return `--${boundary}\r\nContent-Disposition: ${disposition}\r\n${contentType}\r\n${part.value}\r\n`;
    })
    .join('');
  return {
    payload: `${body}--${boundary}--\r\n`,
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

let handle: DatabaseHandle;
let app: FastifyInstance;
let categoryId: number;
let accountId: number;

beforeEach(async () => {
  handle = createTestDatabase();
  app = await buildApp({ db: handle.db, logger: false });
  categoryId = ensureLookup(handle.db, 'category', 'Moradia').id;
  accountId = ensureLookup(handle.db, 'payment', 'Conta Corrente').id;
});

afterEach(async () => {
  await app.close();
  handle.sqlite.close();
});

async function call(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) {
  const response = await app.inject({ method, url, ...(payload !== undefined ? { payload } : {}) });
  // any: corpo JSON de várias rotas inspecionado campo a campo nas asserções; tipar
  // cada resposta aqui só duplicaria os DTOs sem ganho para o teste.
  return { status: response.statusCode, body: response.json() as Record<string, any> };
}

async function createBill(overrides: Record<string, unknown> = {}) {
  const response = await call('POST', '/api/bills', {
    description: 'Condomínio',
    amountCents: 78200,
    dueDate: TODAY,
    categoryId,
    ...overrides,
  });
  expect(response.status).toBe(201);
  return response.body.bill as { id: number; dueDate: string };
}

describe('rotas de contas a pagar — validação (AC11)', () => {
  it('400 com issues[].path para payload inválido', async () => {
    const missing = await call('POST', '/api/bills', { description: 'X', dueDate: '10/03/2026', categoryId });
    expect(missing.status).toBe(400);
    const paths = (missing.body.issues as { path: string }[]).map((issue) => issue.path);
    expect(paths).toEqual(expect.arrayContaining(['dueDate', 'amountCents']));

    const unknownField = await call('POST', '/api/bills', {
      description: 'X',
      amountCents: 100,
      dueDate: TODAY,
      categoryId,
      inventado: true,
    });
    expect(unknownField.status).toBe(400);

    const badMode = await call('POST', '/api/bills/1/pay', { mode: 'cheque', paidAt: TODAY, paidCents: 1 });
    expect(badMode.status).toBe(400);
    expect(badMode.body.issues[0].path).toBe('mode');

    const badId = await call('GET', '/api/bills/abc');
    expect(badId.status).toBe(400);

    const badDays = await call('GET', '/api/bills/agenda?days=0');
    expect(badDays.status).toBe(400);

    const badScope = await call('PUT', '/api/bill-templates/1?scope=this', { description: 'X' });
    expect(badScope.status).toBe(400);
  });

  it('404 para conta e recorrência inexistentes', async () => {
    expect((await call('GET', '/api/bills/999')).status).toBe(404);
    expect((await call('POST', '/api/bills/999/pay', { mode: 'external', paidAt: TODAY, paidCents: 1 })).status).toBe(404);
    expect((await call('GET', '/api/bill-templates/999')).status).toBe(404);
  });
});

describe('rotas de contas a pagar — ocorrências', () => {
  it('cria, lê, edita, lista por mês com filtros e exclui', async () => {
    const created = await createBill({ notes: 'portaria', paymentMethodId: accountId });
    expect((await call('GET', `/api/bills/${created.id}`)).body.bill).toMatchObject({
      description: 'Condomínio',
      displayStatus: 'due_today',
      notes: 'portaria',
      paymentMethodName: 'Conta Corrente',
    });

    const updated = await call('PUT', `/api/bills/${created.id}`, { amountCents: 80000 });
    expect(updated.status).toBe(200);
    expect(updated.body.bill.amountCents).toBe(80000);

    const [year, month] = TODAY.split('-').map(Number);
    const list = await call('GET', `/api/bills?year=${year}&month=${month}&q=condominio&state=open`);
    expect(list.body.bills).toHaveLength(1);
    expect(list.body.summary.openCents).toBe(80000);
    expect((await call('GET', `/api/bills?year=${year}&month=${month}&state=paid`)).body.bills).toHaveLength(0);

    expect((await call('DELETE', `/api/bills/${created.id}`)).body).toEqual({ removed: true, skipped: false });
    expect((await call('GET', `/api/bills/${created.id}`)).status).toBe(404);
  });

  it('agenda separa atrasadas, hoje e próximas', async () => {
    await createBill({ description: 'Atrasada', dueDate: shiftDays(TODAY, -2) });
    await createBill({ description: 'Hoje' });
    await createBill({ description: 'Amanhã', dueDate: shiftDays(TODAY, 1) });
    await createBill({ description: 'Longe', dueDate: shiftDays(TODAY, 20) });

    const agenda = await call('GET', '/api/bills/agenda?days=7');
    expect(agenda.status).toBe(200);
    expect(agenda.body.today).toBe(TODAY);
    expect(agenda.body.overdue.map((b: { description: string }) => b.description)).toEqual(['Atrasada']);
    expect(agenda.body.dueToday.map((b: { description: string }) => b.description)).toEqual(['Hoje']);
    expect(agenda.body.upcoming.map((b: { description: string }) => b.description)).toEqual(['Amanhã']);
  });

  it('previsão devolve um resumo por mês a partir do mês corrente', async () => {
    await createBill({ amountCents: 1000 });
    const nextMonth = addMonthsIso(`${TODAY.slice(0, 7)}-05`, 1) as string;
    await createBill({ amountCents: 2000, dueDate: nextMonth });

    const forecast = await call('GET', '/api/bills/forecast?months=2');
    expect(forecast.status).toBe(200);
    expect(forecast.body.months).toHaveLength(2);
    expect(forecast.body.months[0].from).toBe(`${TODAY.slice(0, 7)}-01`);
    expect(forecast.body.months[0].summary.openCents).toBe(1000);
    expect(forecast.body.months[1].summary.openCents).toBe(2000);
  });

  it('pagar, desfazer, pular e agendar', async () => {
    const bill = await createBill({ dueDate: shiftDays(TODAY, 3) });

    const scheduled = await call('POST', `/api/bills/${bill.id}/schedule`, { scheduledFor: shiftDays(TODAY, 2) });
    expect(scheduled.body.bill).toMatchObject({ displayStatus: 'scheduled', status: 'AG' });

    const paid = await call('POST', `/api/bills/${bill.id}/pay`, {
      mode: 'transaction',
      paidAt: TODAY,
      paidCents: 78200,
      paymentMethodId: accountId,
    });
    expect(paid.status).toBe(200);
    expect(paid.body.bill).toMatchObject({ state: 'paid', paidCents: 78200 });
    const transactionId = paid.body.bill.payments[0].transactionId as number;

    const again = await call('POST', `/api/bills/${bill.id}/pay`, { mode: 'external', paidAt: TODAY, paidCents: 1 });
    expect(again.status).toBe(409);

    const blockedDelete = await call('DELETE', `/api/transactions/${transactionId}`);
    expect(blockedDelete.status).toBe(409);
    expect(blockedDelete.body.error).toMatch(/Desfaça o pagamento/);

    const reopened = await call('POST', `/api/bills/${bill.id}/unpay`);
    expect(reopened.body.bill).toMatchObject({ state: 'open', payments: [] });
    expect((await call('GET', `/api/transactions/${transactionId}`)).status).toBe(404);

    const skipped = await call('POST', `/api/bills/${bill.id}/skip`);
    expect(skipped.body.bill.displayStatus).toBe('skipped');
    const unskipped = await call('POST', `/api/bills/${bill.id}/unskip`);
    expect(unskipped.body.bill.state).toBe('open');
  });

  it('vincular lançamento existente pela rota', async () => {
    const bill = await createBill();
    const imported = seedTransaction(handle.db, { amount: '-R$ 782,00', dueDate: TODAY });
    const linked = await call('POST', `/api/bills/${bill.id}/pay`, { mode: 'link', transactionId: imported.id });
    expect(linked.status).toBe(200);
    expect(linked.body.bill.payments[0]).toMatchObject({ transactionId: imported.id, createdTransaction: false });
    const transaction = await call('GET', `/api/transactions/${imported.id}`);
    expect(transaction.body.billPayment).toMatchObject({ billId: bill.id });
  });

  it('rotas legadas /status e /repeat continuam respondendo para a tela atual', async () => {
    const bill = await createBill();
    const status = await call('POST', `/api/bills/${bill.id}/status`, { status: 'PG' });
    expect(status.body).toMatchObject({ promptRepeat: true, bill: { status: 'PG' } });
    const repeat = await call('POST', `/api/bills/${bill.id}/repeat`);
    expect(repeat.body.created).toBe(true);
  });
});

describe('rotas de contas a pagar — recorrências', () => {
  const template = () => ({
    description: 'Internet',
    amountCents: 9900,
    categoryId,
    recurrence: { frequency: 'monthly', interval: 1, dayOfMonth: 10 },
    startDate: `${TODAY.slice(0, 7)}-10`,
  });

  it('prévia não grava; criar gera ocorrências; listar e ler', async () => {
    const preview = await call('POST', '/api/bill-templates/preview', { ...template(), occurrenceCount: 3 });
    expect(preview.status).toBe(200);
    expect(preview.body.dates).toHaveLength(3);
    expect((await call('GET', '/api/bill-templates')).body.templates).toHaveLength(0);

    const created = await call('POST', '/api/bill-templates', { ...template(), occurrenceCount: 3 });
    expect(created.status).toBe(201);
    expect(created.body.template).toMatchObject({ recurrenceLabel: 'Mensal, dia 10', occurrenceCount: 3 });
    const id = created.body.template.id as number;

    expect((await call('GET', '/api/bill-templates')).body.templates).toHaveLength(1);
    expect((await call('GET', `/api/bill-templates/${id}`)).body.template.id).toBe(id);
    const count = handle.sqlite.prepare('SELECT COUNT(*) AS n FROM scheduled_bills WHERE template_id = ?').get(id) as { n: number };
    expect(count.n).toBe(3);
  });

  it('alterar com scope=all e scope=future, desativar e excluir', async () => {
    const created = await call('POST', '/api/bill-templates', template());
    const id = created.body.template.id as number;

    const all = await call('PUT', `/api/bill-templates/${id}?scope=all`, { amountCents: 10900 });
    expect(all.body.template.amountCents).toBe(10900);

    const refused = await call('PUT', `/api/bill-templates/${id}?scope=all`, { recurrence: { dayOfMonth: 20 } });
    expect(refused.status).toBe(400);

    const from = addMonthsIso(`${TODAY.slice(0, 7)}-01`, 2) as string;
    const future = await call('PUT', `/api/bill-templates/${id}?scope=future&from=${from}`, {
      recurrence: { dayOfMonth: 20 },
    });
    expect(future.status).toBe(200);
    expect(future.body.template.id).not.toBe(id);
    expect(future.body.template.startDate).toBe(from);

    const inactive = await call('PUT', `/api/bill-templates/${future.body.template.id}`, { active: false });
    expect(inactive.body.template.active).toBe(false);
    expect((await call('GET', '/api/bill-templates?includeInactive=true')).body.templates.length).toBeGreaterThanOrEqual(2);

    const removed = await call('DELETE', `/api/bill-templates/${id}`);
    expect(removed.body.removed).toBe(true);
  });

  it('400 para recorrência sem frequência e para campo desconhecido', async () => {
    const { recurrence: _ignored, ...withoutRecurrence } = template();
    expect((await call('POST', '/api/bill-templates', withoutRecurrence)).status).toBe(400);
    expect((await call('POST', '/api/bill-templates', { ...template(), recurrence: { interval: 1 } })).status).toBe(400);
    expect((await call('POST', '/api/bill-templates', { ...template(), cor: 'azul' })).status).toBe(400);
  });
});

describe('rotas de contas a pagar — importação (multipart compartilhado)', () => {
  it('prévia e importação de contas por arquivo', async () => {
    const csv = makeCsv(['Condominio;R$ 782,00;10/01/2024;PG;Moradia'], 'Despesa;Valor;Vencimento;Situação;Categoria').toString('utf8');
    const previewForm = multipart([{ name: 'file', value: csv, filename: 'contas.csv' }]);
    const preview = await app.inject({ method: 'POST', url: '/api/bills/import/preview', ...previewForm });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().totalRows).toBe(1);

    const importForm = multipart([
      { name: 'file', value: csv, filename: 'contas.csv' },
      { name: 'skipDuplicates', value: 'true' },
    ]);
    const imported = await app.inject({ method: 'POST', url: '/api/bills/import', ...importForm });
    expect(imported.statusCode).toBe(201);
    expect(imported.json().importedRows).toBe(1);

    const withoutFile = multipart([{ name: 'skipDuplicates', value: 'true' }]);
    const missing = await app.inject({ method: 'POST', url: '/api/bills/import/preview', ...withoutFile });
    expect(missing.statusCode).toBe(400);

    const badJson = multipart([
      { name: 'file', value: csv, filename: 'contas.csv' },
      { name: 'mapping', value: '{nao-e-json' },
    ]);
    const invalid = await app.inject({ method: 'POST', url: '/api/bills/import/preview', ...badJson });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error).toMatch(/Mapeamento inválido/);
  });
});
