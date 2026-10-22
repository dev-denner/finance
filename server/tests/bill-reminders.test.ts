import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type Database from 'better-sqlite3';
import type { AppDatabase } from '../src/db/client';
import {
  billReminderBatches,
  billReminderNotifications,
  scheduledBills,
} from '../src/db/schema';
import { addDaysIso } from '../src/lib/dates';
import { createBill, deleteBill, updateBill } from '../src/services/bills';
import {
  BillReminderConfigError,
  loadBillReminderConfig,
  type BillReminderConfig,
} from '../src/services/bill-reminder-config';
import { runBillReminders, sanitizeReminderError } from '../src/services/bill-reminders';
import { createReminderScheduler } from '../src/services/bill-reminder-scheduler';
import {
  DryRunTransport,
  FakeTransport,
  type ReminderMessage,
  type ReminderTransport,
} from '../src/services/bill-reminder-transport';
import { ensureLookup } from '../src/services/lookups';
import { createTestDatabase } from './helpers';

/**
 * Lembretes por e-mail para contas a pagar não agendadas.
 *
 * Cobertura:
 * - AC-1 marcos de aviso (D-3, D-2, D-1, D0)
 * - AC-2 consolidação por (marco, data-alvo)
 * - AC-3 idempotência
 * - AC-4 conta agendada/paga interrompe os avisos
 * - AC-5 falha de envio, retentativa e sanitização do erro
 * - AC-5 (corretiva) falha que **não** é descartada: a retentativa acontece
 *   mesmo com aviso nominal no mesmo dia e um `failed` nunca vira `skipped`
 * - AC-6 nenhum e-mail real (rede bloqueada no arquivo de teste)
 * - AC-7 coerência com o banco (CASCADE, vencimento alterado)
 * - AC-9 recuperação de marcos perdidos
 * - AC-9 (corretiva) texto do aviso de recuperação: data real do envio e
 *   aviso explícito de que o marco já havia passado
 * - AC-10/AC-11 conteúdo sem valor monetário e com o pedido explícito de agendamento
 * - no máximo 1 aviso por item por dia no caminho normal (regressão da
 *   enxurrada de avisos)
 *
 * Nenhum teste abre conexão: o transporte usado é sempre `FakeTransport`,
 * `DryRunTransport` ou um dublê em memória. `globalThis.fetch` é substituído
 * por uma função que lança, para garantir que nada sai para a rede.
 */

const TODAY = '2026-03-10';
const RECIPIENT = 'lembretes@exemplo.invalid';
/** Valor sentinela: serve para provar que o valor **não** vaza no e-mail. */
const SENTINEL_AMOUNT = 123456;

const fetchOriginal = globalThis.fetch;

beforeAll(() => {
  globalThis.fetch = (() => {
    throw new Error('A rede está bloqueada nos testes de lembretes.');
  }) as typeof globalThis.fetch;
});

afterAll(() => {
  globalThis.fetch = fetchOriginal;
});

function shiftDays(date: string, days: number): string {
  const shifted = addDaysIso(date, days);
  if (!shifted) throw new Error(`Data de teste inválida: ${date}`);
  return shifted;
}

function makeConfig(overrides: Partial<BillReminderConfig> = {}): BillReminderConfig {
  return {
    enabled: true,
    transport: 'dry-run',
    to: RECIPIENT,
    from: 'finance@localhost',
    smtp: null,
    catchUpDays: 3,
    intervalMinutes: 30,
    ...overrides,
  };
}

interface Scenario {
  db: AppDatabase;
  sqlite: Database.Database;
  categoryId: number;
}

function createScenario(): Scenario {
  const handle = createTestDatabase();
  const category = ensureLookup(handle.db, 'category', 'Moradia');
  return { db: handle.db, sqlite: handle.sqlite, categoryId: category.id };
}

function seedBill(
  scenario: Scenario,
  input: { description: string; dueDate: string; amountCents?: number; status?: string },
) {
  return createBill(scenario.db, {
    description: input.description,
    amountCents: input.amountCents ?? 1000,
    dueDate: input.dueDate,
    categoryId: scenario.categoryId,
    status: input.status ?? '',
  });
}

/** Executa um ciclo com data e instante fixos (determinismo total). */
async function runCycle(
  db: AppDatabase,
  transport: ReminderTransport,
  config: BillReminderConfig,
  today: string,
  now?: Date,
) {
  return runBillReminders({
    db,
    transport,
    config,
    today,
    now: now ?? new Date(`${today}T12:00:00Z`),
  });
}

function ledgerRows(db: AppDatabase) {
  return db.select().from(billReminderNotifications).all();
}

function ledgerFor(db: AppDatabase, billId: number) {
  return db
    .select()
    .from(billReminderNotifications)
    .where(eq(billReminderNotifications.billId, billId))
    .all();
}

function batchRows(db: AppDatabase) {
  return db.select().from(billReminderBatches).all();
}

/**
 * Marco do e-mail a partir do assunto.
 * Aceita o formato nominal `(D-3)` e o de recuperação `(D-3 — recuperação)`.
 */
function milestoneOf(message: ReminderMessage): string | null {
  const match = message.subject.match(/\((D-3|D-2|D-1|D0)(?:\s+—\s+recuperação)?\)$/);
  return match ? match[1] : null;
}

function milestonesOf(messages: ReminderMessage[]): (string | null)[] {
  return messages.map(milestoneOf);
}

/** Transporte que falha sempre, com uma mensagem controlada. */
class ThrowingTransport implements ReminderTransport {
  readonly kind = 'throwing';
  readonly persists = true;

  constructor(private readonly error: Error) {}

  async send(): Promise<void> {
    throw this.error;
  }
}

/** Transporte que pode segurar o envio, para testar sobreposição de ciclos. */
class ControllableTransport implements ReminderTransport {
  readonly kind = 'controllable';
  readonly persists = true;
  readonly sent: ReminderMessage[] = [];
  block = false;

  private releases: Array<() => void> = [];

  async send(message: ReminderMessage): Promise<void> {
    this.sent.push(message);
    if (!this.block) return;
    await new Promise<void>((resolve) => {
      this.releases.push(resolve);
    });
  }

  release(): void {
    const pending = this.releases;
    this.releases = [];
    for (const resolve of pending) resolve();
  }
}

describe('lembretes por e-mail — marcos de aviso (AC-1)', () => {
  it('deve avisar três dias antes do vencimento', async () => {
    const scenario = createScenario();
    seedBill(scenario, { description: 'Aluguel', dueDate: shiftDays(TODAY, 3) });
    const transport = new FakeTransport();

    const result = await runCycle(scenario.db, transport, makeConfig(), TODAY);

    expect(transport.sent).toHaveLength(1);
    expect(milestoneOf(transport.sent[0])).toBe('D-3');
    expect(result.emailsSent).toBe(1);
    expect(result.notificationsSent).toBe(1);
  });

  it('deve avisar dois dias antes do vencimento', async () => {
    const scenario = createScenario();
    seedBill(scenario, { description: 'Energia', dueDate: shiftDays(TODAY, 2) });
    const transport = new FakeTransport();

    // O marco D-3 sai no dia dele (hoje - 1); o marco D-2 sai hoje.
    await runCycle(scenario.db, transport, makeConfig(), shiftDays(TODAY, -1));
    await runCycle(scenario.db, transport, makeConfig(), TODAY);

    expect(transport.sent).toHaveLength(2);
    expect(milestonesOf(transport.sent)).toEqual(['D-3', 'D-2']);
  });

  it('deve avisar um dia antes do vencimento', async () => {
    const scenario = createScenario();
    seedBill(scenario, { description: 'Agua', dueDate: shiftDays(TODAY, 1) });
    const transport = new FakeTransport();

    await runCycle(scenario.db, transport, makeConfig(), shiftDays(TODAY, -2));
    await runCycle(scenario.db, transport, makeConfig(), shiftDays(TODAY, -1));
    await runCycle(scenario.db, transport, makeConfig(), TODAY);

    expect(transport.sent).toHaveLength(3);
    expect(milestonesOf(transport.sent)).toEqual(['D-3', 'D-2', 'D-1']);
  });

  it('deve avisar no dia do vencimento', async () => {
    const scenario = createScenario();
    seedBill(scenario, { description: 'Internet', dueDate: TODAY });
    const transport = new FakeTransport();

    await runCycle(scenario.db, transport, makeConfig(), shiftDays(TODAY, -3));
    await runCycle(scenario.db, transport, makeConfig(), shiftDays(TODAY, -2));
    await runCycle(scenario.db, transport, makeConfig(), shiftDays(TODAY, -1));
    await runCycle(scenario.db, transport, makeConfig(), TODAY);

    expect(transport.sent).toHaveLength(4);
    expect(milestonesOf(transport.sent)).toEqual(['D-3', 'D-2', 'D-1', 'D0']);
  });

  it('deve não avisar conta que vence depois da janela de marcos', async () => {
    const scenario = createScenario();
    seedBill(scenario, { description: 'Seguro', dueDate: shiftDays(TODAY, 4) });
    const transport = new FakeTransport();

    // Hoje a conta ainda está a 4 dias: o marco mais distante (D-3) só chega amanhã.
    await runCycle(scenario.db, transport, makeConfig(), TODAY);

    expect(transport.sent).toHaveLength(0);
    expect(ledgerRows(scenario.db)).toHaveLength(0);
    expect(batchRows(scenario.db)).toHaveLength(0);

    // No dia do marco D-3 o aviso sai, e apenas um.
    await runCycle(scenario.db, transport, makeConfig(), shiftDays(TODAY, 1));

    expect(transport.sent).toHaveLength(1);
    expect(milestoneOf(transport.sent[0])).toBe('D-3');
  });

  it('deve enviar no máximo quatro avisos, um por marco, na ordem', async () => {
    const scenario = createScenario();
    const bill = seedBill(scenario, { description: 'Condominio', dueDate: shiftDays(TODAY, 3) });
    const transport = new FakeTransport();

    for (let day = 0; day < 4; day += 1) {
      await runCycle(scenario.db, transport, makeConfig(), shiftDays(TODAY, day));
    }

    expect(transport.sent).toHaveLength(4);
    expect(milestonesOf(transport.sent)).toEqual(['D-3', 'D-2', 'D-1', 'D0']);

    const rows = ledgerFor(scenario.db, bill.id);
    expect(rows).toHaveLength(4);
    expect(rows.map((row) => row.milestone).sort()).toEqual(['D-2', 'D-3', 'D0', 'D-1'].sort());
    expect(rows.every((row) => row.state === 'sent')).toBe(true);
    expect(rows.every((row) => row.attempts === 1)).toBe(true);
    expect(rows.every((row) => row.lastError === null)).toBe(true);

    // Mais dois dias não geram novos avisos: o `sent` é permanente.
    await runCycle(scenario.db, transport, makeConfig(), shiftDays(TODAY, 4));
    await runCycle(scenario.db, transport, makeConfig(), shiftDays(TODAY, 5));

    expect(transport.sent).toHaveLength(4);
    expect(ledgerFor(scenario.db, bill.id)).toHaveLength(4);
    expect(batchRows(scenario.db)).toHaveLength(4);
  });
});

describe('lembretes por e-mail — consolidação por marco (AC-2)', () => {
  it('deve consolidar em um único e-mail as contas do mesmo marco', async () => {
    const scenario = createScenario();
    seedBill(scenario, { description: 'Aluguel', dueDate: shiftDays(TODAY, 3) });
    seedBill(scenario, { description: 'Condominio', dueDate: shiftDays(TODAY, 3) });
    const transport = new FakeTransport();

    await runCycle(scenario.db, transport, makeConfig(), TODAY);

    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0].text).toContain('Aluguel');
    expect(transport.sent[0].text).toContain('Condominio');

    const batches = batchRows(scenario.db);
    expect(batches).toHaveLength(1);
    expect(batches[0].milestone).toBe('D-3');
    expect(batches[0].state).toBe('sent');
    expect(batches[0].itemCount).toBe(2);
  });

  it('deve enviar um e-mail por marco quando as contas têm marcos diferentes no mesmo dia', async () => {
    const scenario = createScenario();
    // "Luz" vence em 2 dias: o marco D-3 sai hoje - 1 e o D-2 sai hoje.
    seedBill(scenario, { description: 'Luz', dueDate: shiftDays(TODAY, 2) });
    // "Aluguel" vence em 3 dias: o marco D-3 sai hoje.
    seedBill(scenario, { description: 'Aluguel', dueDate: shiftDays(TODAY, 3) });
    const transport = new FakeTransport();

    await runCycle(scenario.db, transport, makeConfig(), shiftDays(TODAY, -1));
    const sentBefore = transport.sent.length;

    await runCycle(scenario.db, transport, makeConfig(), TODAY);

    // No mesmo dia saem dois e-mails: um por (marco, data-alvo).
    expect(transport.sent.length - sentBefore).toBe(2);
    expect(milestonesOf(transport.sent.slice(sentBefore))).toEqual(['D-2', 'D-3']);

    const today = batchRows(scenario.db).filter((row) => row.sendDate === TODAY);
    expect(today).toHaveLength(2);
    expect(today.map((row) => row.milestone).sort()).toEqual(['D-2', 'D-3']);
    expect(today.every((row) => row.state === 'sent')).toBe(true);
    // Cada e-mail carrega uma conta só: a consolidação é por marco.
    expect(today.every((row) => row.itemCount === 1)).toBe(true);
  });
});

describe('lembretes por e-mail — idempotência (AC-3)', () => {
  it('deve enviar um único e-mail quando o mesmo dia é processado três vezes', async () => {
    const scenario = createScenario();
    const bill = seedBill(scenario, { description: 'Aluguel', dueDate: shiftDays(TODAY, 3) });
    const transport = new FakeTransport();

    for (let round = 0; round < 3; round += 1) {
      await runCycle(scenario.db, transport, makeConfig(), TODAY);
    }

    expect(transport.sent).toHaveLength(1);
    expect(transport.failed).toHaveLength(0);

    const rows = ledgerFor(scenario.db, bill.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].milestone).toBe('D-3');
    expect(rows[0].attempts).toBe(1);

    const batches = batchRows(scenario.db);
    expect(batches).toHaveLength(1);
    expect(batches[0].state).toBe('sent');
    expect(batches[0].attempts).toBe(1);
  });
});

describe('lembretes por e-mail — conta já agendada ou paga (AC-4)', () => {
  it('deve ignorar conta já agendada sem gerar aviso nem histórico', async () => {
    const scenario = createScenario();
    seedBill(scenario, {
      description: 'Aluguel',
      dueDate: shiftDays(TODAY, 3),
      status: 'AG',
    });
    const transport = new FakeTransport();

    const result = await runCycle(scenario.db, transport, makeConfig(), TODAY);

    expect(transport.sent).toHaveLength(0);
    expect(ledgerRows(scenario.db)).toHaveLength(0);
    expect(result.eligibleBills).toBe(0);
  });

  it('deve ignorar conta já paga sem gerar aviso nem histórico', async () => {
    const scenario = createScenario();
    seedBill(scenario, {
      description: 'Aluguel',
      dueDate: shiftDays(TODAY, 3),
      status: 'PG',
    });
    const transport = new FakeTransport();

    await runCycle(scenario.db, transport, makeConfig(), TODAY);

    expect(transport.sent).toHaveLength(0);
    expect(ledgerRows(scenario.db)).toHaveLength(0);
  });

  it('deve interromper os avisos restantes quando a conta é agendada', async () => {
    const scenario = createScenario();
    const bill = seedBill(scenario, { description: 'Luz', dueDate: shiftDays(TODAY, 1) });
    const transport = new FakeTransport();

    // Primeiro ciclo: o marco nominal de hoje (D-1) é enviado; os marcos
    // perdidos (D-3, D-2) são descartados.
    await runCycle(scenario.db, transport, makeConfig(), TODAY);
    expect(transport.sent).toHaveLength(1);
    expect(milestoneOf(transport.sent[0])).toBe('D-1');

    updateBill(scenario.db, bill.id, { status: 'AG' });

    await runCycle(scenario.db, transport, makeConfig(), shiftDays(TODAY, 1));

    // A conta agendada não recebe mais avisos e não gera novo histórico.
    expect(transport.sent).toHaveLength(1);
    const rows = ledgerFor(scenario.db, bill.id);
    expect(rows.every((row) => row.state !== 'pending')).toBe(true);
    // O marco do dia do vencimento (D0) nunca é criado para uma conta agendada.
    expect(rows.some((row) => row.milestone === 'D0')).toBe(false);
  });

  it('deve descartar o aviso que falhou quando a conta é agendada antes da retentativa', async () => {
    const scenario = createScenario();
    const bill = seedBill(scenario, { description: 'Luz', dueDate: shiftDays(TODAY, 3) });
    const failing = new FakeTransport({ failAll: true });

    // A falha deixa o marco de hoje (D-3) como `failed`, aguardando retentativa.
    await runCycle(scenario.db, failing, makeConfig(), TODAY);
    expect(ledgerFor(scenario.db, bill.id)[0].state).toBe('failed');

    updateBill(scenario.db, bill.id, { status: 'AG' });

    const working = new FakeTransport();
    await runCycle(scenario.db, working, makeConfig(), shiftDays(TODAY, 1));

    // A conta agendada interrompe a retentativa: o aviso vira `skipped`.
    expect(working.sent).toHaveLength(0);
    const row = ledgerFor(scenario.db, bill.id)[0];
    expect(row.state).toBe('skipped');
    expect(row.attempts).toBe(1);
    expect(row.sentAt).toBeNull();
  });

  it('deve manter o aviso confirmado quando a conta volta de agendada para pendente', async () => {
    const scenario = createScenario();
    const bill = seedBill(scenario, { description: 'Aluguel', dueDate: shiftDays(TODAY, 3) });
    const transport = new FakeTransport();

    await runCycle(scenario.db, transport, makeConfig(), TODAY);
    expect(transport.sent).toHaveLength(1);

    updateBill(scenario.db, bill.id, { status: 'AG' });
    await runCycle(scenario.db, transport, makeConfig(), TODAY);
    updateBill(scenario.db, bill.id, { status: '' });
    await runCycle(scenario.db, transport, makeConfig(), TODAY);

    expect(transport.sent).toHaveLength(1);
    const rows = ledgerFor(scenario.db, bill.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe('sent');
    expect(rows[0].attempts).toBe(1);
  });
});

describe('lembretes por e-mail — falha de envio e retentativa (AC-5)', () => {
  it('deve registrar a falha do envio sem derrubar a execução', async () => {
    const scenario = createScenario();
    const bill = seedBill(scenario, { description: 'Aluguel', dueDate: shiftDays(TODAY, 3) });
    const transport = new FakeTransport({ failAll: true });

    const result = await runCycle(scenario.db, transport, makeConfig(), TODAY);

    expect(result.emailsFailed).toBe(1);
    expect(result.emailsSent).toBe(0);
    expect(result.notificationsFailed).toBe(1);

    const rows = ledgerFor(scenario.db, bill.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe('failed');
    expect(rows[0].attempts).toBe(1);
    expect(rows[0].lastError).toBeTruthy();
    expect(rows[0].sentAt).toBeNull();

    const batches = batchRows(scenario.db);
    expect(batches).toHaveLength(1);
    expect(batches[0].state).toBe('failed');
    expect(batches[0].lastError).toBeTruthy();
  });

  it('deve reenviar uma única vez quando o transporte volta a funcionar', async () => {
    const scenario = createScenario();
    const bill = seedBill(scenario, { description: 'Aluguel', dueDate: shiftDays(TODAY, 3) });
    const failing = new FakeTransport({ failAll: true });

    await runCycle(scenario.db, failing, makeConfig(), TODAY);
    expect(failing.failed).toHaveLength(1);
    expect(failing.sent).toHaveLength(0);

    const working = new FakeTransport();
    const second = await runCycle(scenario.db, working, makeConfig(), TODAY);

    expect(working.sent).toHaveLength(1);
    expect(second.emailsSent).toBe(1);

    const rows = ledgerFor(scenario.db, bill.id);
    expect(rows[0].state).toBe('sent');
    expect(rows[0].attempts).toBe(2);
    expect(rows[0].lastError).toBeNull();

    const batches = batchRows(scenario.db);
    expect(batches).toHaveLength(1);
    expect(batches[0].state).toBe('sent');
    expect(batches[0].attempts).toBe(2);

    const third = await runCycle(scenario.db, working, makeConfig(), TODAY);
    expect(working.sent).toHaveLength(1);
    expect(third.emailsSent).toBe(0);
    expect(ledgerFor(scenario.db, bill.id)[0].attempts).toBe(2);
  });

  it('deve consolidar a falha de duas contas do mesmo marco e reenviar as duas juntas', async () => {
    const scenario = createScenario();
    const first = seedBill(scenario, { description: 'Aluguel', dueDate: shiftDays(TODAY, 3) });
    const second = seedBill(scenario, { description: 'Condominio', dueDate: shiftDays(TODAY, 3) });
    const failing = new FakeTransport({ failAll: true });

    await runCycle(scenario.db, failing, makeConfig(), TODAY);

    // Uma única tentativa de envio para o marco, com os dois itens.
    expect(failing.failed).toHaveLength(1);
    expect(failing.sent).toHaveLength(0);
    expect(ledgerFor(scenario.db, first.id)[0].state).toBe('failed');
    expect(ledgerFor(scenario.db, second.id)[0].state).toBe('failed');

    const working = new FakeTransport();
    await runCycle(scenario.db, working, makeConfig(), TODAY);

    expect(working.sent).toHaveLength(1);
    expect(working.sent[0].text).toContain('Aluguel');
    expect(working.sent[0].text).toContain('Condominio');
    expect(ledgerFor(scenario.db, first.id)[0].state).toBe('sent');
    expect(ledgerFor(scenario.db, second.id)[0].state).toBe('sent');
  });

  it('deve remover e-mail e credencial da mensagem de erro', async () => {
    const scenario = createScenario();
    const bill = seedBill(scenario, { description: 'Aluguel', dueDate: shiftDays(TODAY, 3) });
    const transport = new ThrowingTransport(
      new Error('Falha SMTP em usuario@exemplo.invalid: password=segredo-super-secreto'),
    );

    await runCycle(scenario.db, transport, makeConfig(), TODAY);

    const row = ledgerFor(scenario.db, bill.id)[0];
    expect(row.state).toBe('failed');
    expect(row.lastError).toBeTruthy();
    expect(row.lastError).not.toContain('usuario@exemplo.invalid');
    expect(row.lastError).not.toContain('segredo-super-secreto');
    expect(row.lastError).toContain('[email]');
    expect(row.lastError).toContain('[redacted]');
  });

  it('deve truncar a mensagem de erro para não inchar o banco', async () => {
    const scenario = createScenario();
    const bill = seedBill(scenario, { description: 'Aluguel', dueDate: shiftDays(TODAY, 3) });
    const transport = new ThrowingTransport(new Error('x'.repeat(500)));

    await runCycle(scenario.db, transport, makeConfig(), TODAY);

    const row = ledgerFor(scenario.db, bill.id)[0];
    expect(row.lastError).toHaveLength(200);
  });
});

describe('lembretes por e-mail — nenhum e-mail real (AC-6)', () => {
  it('deve manter o recurso desabilitado sem destinatário, mesmo com transporte smtp', () => {
    const config = loadBillReminderConfig({ BILL_REMINDER_TRANSPORT: 'smtp' });

    expect(config.enabled).toBe(false);
    expect(config.to).toBeNull();
    expect(config.transport).toBe('smtp');
  });

  it('deve não enviar nada quando o recurso está desabilitado', async () => {
    const scenario = createScenario();
    seedBill(scenario, { description: 'Aluguel', dueDate: shiftDays(TODAY, 3) });
    const transport = new FakeTransport();
    const config = loadBillReminderConfig({ BILL_REMINDER_TRANSPORT: 'smtp' });

    const result = await runCycle(scenario.db, transport, config, TODAY);

    expect(result.disabled).toBe(true);
    expect(result.emailsSent).toBe(0);
    expect(transport.sent).toHaveLength(0);
    expect(transport.failed).toHaveLength(0);
    expect(ledgerRows(scenario.db)).toHaveLength(0);
  });

  it('deve rejeitar transporte smtp sem credenciais completas', () => {
    expect(() =>
      loadBillReminderConfig({
        BILL_REMINDER_TRANSPORT: 'smtp',
        BILL_REMINDER_TO: RECIPIENT,
      }),
    ).toThrow(BillReminderConfigError);
  });

  it('deve usar somente o transporte injetado mesmo com configuração smtp', async () => {
    const scenario = createScenario();
    seedBill(scenario, { description: 'Aluguel', dueDate: shiftDays(TODAY, 3) });
    const transport = new FakeTransport();
    const config = makeConfig({
      transport: 'smtp',
      smtp: { host: 'smtp.invalid', port: 2525, secure: false, user: 'u', password: 'p' },
    });

    const result = await runCycle(scenario.db, transport, config, TODAY);

    expect(result.emailsSent).toBe(1);
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0].to).toBe(RECIPIENT);
  });

  it('deve guardar o e-mail em memória no transporte de simulação', async () => {
    const transport = new DryRunTransport();
    const message: ReminderMessage = {
      to: RECIPIENT,
      subject: 'Finance: 1 conta a pagar precisa ser agendada (D-3)',
      text: 'corpo de teste',
      html: '<p>corpo de teste</p>',
      messageId: '<bill-reminder-D-3-2026-03-10@finance.local>',
    };

    await transport.send(message);

    expect(transport.messages).toHaveLength(1);
    expect(transport.messages[0].subject).toBe(message.subject);
    // Nenhum socket/handle é retido: o transporte só guarda a lista em memória.
    expect(Object.keys(transport).sort()).toEqual(['kind', 'messages', 'persists']);
    // O transporte de simulação **não** confirma entrega: o ciclo com ele
    // não grava nada no banco.
    expect(transport.persists).toBe(false);
  });
});

describe('lembretes por e-mail — recuperação de marcos perdidos (AC-9)', () => {
  it('deve avisar o marco nominal do dia e descartar os marcos perdidos quando o servidor fica dias fora', async () => {
    const scenario = createScenario();
    // Vence amanhã: D-3 (hoje-2), D-2 (hoje-1), D-1 (hoje) e D0 (amanhã).
    const bill = seedBill(scenario, { description: 'Luz', dueDate: shiftDays(TODAY, 1) });
    const transport = new FakeTransport();

    // O servidor ficou dois dias fora: D-3 e D-2 ficaram perdidos.
    await runCycle(scenario.db, transport, makeConfig(), TODAY);

    // Um único e-mail: o marco nominal do dia.
    expect(transport.sent).toHaveLength(1);
    expect(milestoneOf(transport.sent[0])).toBe('D-1');
    expect(transport.sent[0].text).toContain('1 conta a pagar');

    const rows = ledgerFor(scenario.db, bill.id);
    const sent = rows.filter((row) => row.state === 'sent');
    expect(sent).toHaveLength(1);
    expect(sent[0].milestone).toBe('D-1');

    // Os marcos perdidos viram `skipped`, com o motivo registrado.
    const skipped = rows.filter((row) => row.state === 'skipped');
    expect(new Set(skipped.map((row) => row.milestone))).toEqual(new Set(['D-3', 'D-2']));
    expect(
      skipped.every((row) => row.lastError === 'marco perdido: coberto pelo aviso de hoje'),
    ).toBe(true);
    expect(skipped.every((row) => row.attempts === 0)).toBe(true);
    expect(skipped.every((row) => row.sentAt === null)).toBe(true);

    // No dia seguinte, o marco D0 sai normalmente.
    await runCycle(scenario.db, transport, makeConfig(), shiftDays(TODAY, 1));

    expect(milestonesOf(transport.sent)).toEqual(['D-1', 'D0']);
  });

  it('deve enviar no máximo um aviso por item por dia mesmo com vários marcos elegíveis', async () => {
    const scenario = createScenario();
    const bill = seedBill(scenario, { description: 'Luz', dueDate: shiftDays(TODAY, 1) });
    const transport = new FakeTransport();

    // Três ticks no mesmo dia (o agendador roda a cada 30 minutos) com D-3,
    // D-2 e D-1 elegíveis: o item não pode receber mais de um aviso.
    await runCycle(scenario.db, transport, makeConfig(), TODAY, new Date(`${TODAY}T12:00:00Z`));
    await runCycle(scenario.db, transport, makeConfig(), TODAY, new Date(`${TODAY}T12:30:00Z`));
    await runCycle(scenario.db, transport, makeConfig(), TODAY, new Date(`${TODAY}T13:00:00Z`));

    expect(transport.sent).toHaveLength(1);
    expect(milestoneOf(transport.sent[0])).toBe('D-1');

    const rows = ledgerFor(scenario.db, bill.id);
    expect(rows.filter((row) => row.state === 'sent')).toHaveLength(1);
    expect(rows.filter((row) => row.state === 'skipped')).toHaveLength(2);
    expect(rows.filter((row) => row.state === 'pending')).toHaveLength(0);
  });

  it('deve enviar um único aviso de recuperação quando não há marco nominal no dia', async () => {
    const scenario = createScenario();
    // Venceu ontem: D-3 (hoje-4), D-2 (hoje-3), D-1 (hoje-2) e D0 (ontem).
    const bill = seedBill(scenario, { description: 'Luz', dueDate: shiftDays(TODAY, -1) });
    const transport = new FakeTransport();

    await runCycle(scenario.db, transport, makeConfig(), TODAY);

    // Sem marco nominal do dia: recupera só o marco perdido mais antigo.
    expect(transport.sent).toHaveLength(1);
    expect(milestoneOf(transport.sent[0])).toBe('D-2');

    const rows = ledgerFor(scenario.db, bill.id);
    expect(rows.filter((row) => row.state === 'sent')).toHaveLength(1);
    const skipped = rows.filter((row) => row.state === 'skipped');
    expect(new Set(skipped.map((row) => row.milestone))).toEqual(new Set(['D-1', 'D0']));
    expect(
      skipped.every((row) => row.lastError === 'marco perdido: coberto pelo aviso de recuperacao'),
    ).toBe(true);
    expect(skipped.every((row) => row.attempts === 0)).toBe(true);
    expect(skipped.every((row) => row.sentAt === null)).toBe(true);

    // Um segundo tick no mesmo dia não gera outro e-mail para o item.
    await runCycle(scenario.db, transport, makeConfig(), TODAY, new Date(`${TODAY}T12:30:00Z`));
    expect(transport.sent).toHaveLength(1);
  });

  it('deve marcar como skipped o aviso com falha cuja data-alvo saiu da janela', async () => {
    const scenario = createScenario();
    const bill = seedBill(scenario, { description: 'Luz', dueDate: shiftDays(TODAY, 3) });
    const failing = new FakeTransport({ failAll: true });

    // A falha deixa o marco de hoje (D-3) como `failed`.
    await runCycle(scenario.db, failing, makeConfig(), TODAY);
    expect(ledgerFor(scenario.db, bill.id)[0].state).toBe('failed');

    const working = new FakeTransport();
    await runCycle(scenario.db, working, makeConfig(), shiftDays(TODAY, 4));

    const rows = ledgerFor(scenario.db, bill.id);
    const antigo = rows.filter((row) => row.milestone === 'D-3');
    expect(antigo).toHaveLength(1);
    expect(antigo[0].state).toBe('skipped');
    expect(antigo[0].attempts).toBe(1);
    expect(antigo[0].sentAt).toBeNull();

    // Na recuperação, só o marco perdido mais antigo é enviado.
    expect(milestonesOf(working.sent)).toEqual(['D-2']);
  });
});

describe('lembretes por e-mail — conteúdo e privacidade (AC-10 e AC-11)', () => {
  it('deve omitir o valor monetário da conta', async () => {
    const scenario = createScenario();
    seedBill(scenario, {
      description: 'Conta de energia',
      dueDate: shiftDays(TODAY, 3),
      amountCents: SENTINEL_AMOUNT,
    });
    const transport = new FakeTransport();

    await runCycle(scenario.db, transport, makeConfig(), TODAY);

    expect(transport.sent).toHaveLength(1);
    const message = transport.sent[0];
    for (const content of [message.subject, message.text, message.html]) {
      expect(content).not.toContain('123456');
      expect(content).not.toContain('1.234,56');
      expect(content).not.toContain('1234,56');
      expect(content).not.toContain('R$');
    }
  });

  it('deve omitir o valor de qualquer item consolidado no e-mail', async () => {
    const scenario = createScenario();
    seedBill(scenario, {
      description: 'Conta de luz',
      dueDate: shiftDays(TODAY, 3),
      amountCents: SENTINEL_AMOUNT,
    });
    seedBill(scenario, {
      description: 'Taxa de assinatura',
      dueDate: shiftDays(TODAY, 3),
      amountCents: 987654,
    });
    const transport = new FakeTransport();

    await runCycle(scenario.db, transport, makeConfig(), TODAY);

    expect(transport.sent).toHaveLength(1);
    const message = transport.sent[0];
    for (const content of [message.subject, message.text, message.html]) {
      expect(content).not.toContain('123456');
      expect(content).not.toContain('987654');
      expect(content).not.toContain('R$');
    }
  });

  it('deve informar que os itens precisam ser agendados', async () => {
    const scenario = createScenario();
    seedBill(scenario, { description: 'Aluguel', dueDate: shiftDays(TODAY, 3) });
    const transport = new FakeTransport();

    await runCycle(scenario.db, transport, makeConfig(), TODAY);

    const message = transport.sent[0];
    expect(message.text).toContain('precisam ser agendados');
    expect(message.text).toContain('ainda não estão agendados');
    expect(message.html).toContain('precisam ser agendados');
    expect(message.subject).toContain('ser agendada');
  });

  it('deve listar somente as contas esperadas no e-mail', async () => {
    const scenario = createScenario();
    seedBill(scenario, { description: 'Aluguel', dueDate: shiftDays(TODAY, 3) });
    seedBill(scenario, { description: 'Condominio', dueDate: shiftDays(TODAY, 3) });
    seedBill(scenario, { description: 'Conta fora da janela', dueDate: shiftDays(TODAY, 4) });
    const transport = new FakeTransport();

    await runCycle(scenario.db, transport, makeConfig(), TODAY);

    const message = transport.sent[0];
    expect(message.text).toContain('Aluguel');
    expect(message.text).toContain('Condominio');
    expect(message.text).not.toContain('Conta fora da janela');
    expect(message.html).not.toContain('Conta fora da janela');
    expect(message.text).toContain('2 contas a pagar');
  });

  it('deve não expor valor monetário no resumo da execução', async () => {
    const scenario = createScenario();
    seedBill(scenario, {
      description: 'Conta de energia',
      dueDate: shiftDays(TODAY, 3),
      amountCents: SENTINEL_AMOUNT,
    });
    const transport = new FakeTransport();

    const result = await runCycle(scenario.db, transport, makeConfig(), TODAY);

    expect(JSON.stringify(result)).not.toContain('123456');
    expect(JSON.stringify(result)).not.toContain('Conta de energia');
  });
});

describe('lembretes por e-mail — coerência com o banco (AC-7)', () => {
  it('deve apagar o histórico do lembrete quando a conta é excluída', async () => {
    const scenario = createScenario();
    const bill = seedBill(scenario, { description: 'Aluguel', dueDate: shiftDays(TODAY, 3) });
    const transport = new FakeTransport();

    await runCycle(scenario.db, transport, makeConfig(), TODAY);
    expect(ledgerFor(scenario.db, bill.id)).toHaveLength(1);

    deleteBill(scenario.db, bill.id);

    expect(ledgerRows(scenario.db)).toHaveLength(0);
  });

  it('deve preservar os dados financeiros da conta durante o ciclo', async () => {
    const scenario = createScenario();
    const bill = seedBill(scenario, {
      description: 'Aluguel',
      dueDate: shiftDays(TODAY, 3),
      amountCents: SENTINEL_AMOUNT,
    });
    const transport = new FakeTransport();

    await runCycle(scenario.db, transport, makeConfig(), TODAY);

    const stored = scenario.db
      .select()
      .from(scheduledBills)
      .where(eq(scheduledBills.id, bill.id))
      .get();
    expect(stored?.dueDate).toBe(shiftDays(TODAY, 3));
    expect(stored?.amountCents).toBe(SENTINEL_AMOUNT);
    expect(stored?.status).toBe('');
  });

  it('deve marcar como skipped o aviso do vencimento antigo quando o vencimento muda', async () => {
    const scenario = createScenario();
    const bill = seedBill(scenario, { description: 'Luz', dueDate: shiftDays(TODAY, 1) });
    const failing = new FakeTransport({ failAll: true });

    // O aviso de hoje (D-1) fica com falha, aguardando retentativa.
    await runCycle(scenario.db, failing, makeConfig(), TODAY);
    const antes = ledgerFor(scenario.db, bill.id);
    expect(antes.filter((row) => row.state === 'failed')).toHaveLength(1);
    expect(antes.filter((row) => row.state === 'pending')).toHaveLength(0);

    updateBill(scenario.db, bill.id, { dueDate: shiftDays(TODAY, 2) });

    const working = new FakeTransport();
    await runCycle(scenario.db, working, makeConfig(), TODAY);

    const rows = ledgerFor(scenario.db, bill.id);
    const antigo = rows.filter((row) => row.dueDate === shiftDays(TODAY, 1));
    // Nenhum aviso do vencimento antigo continua elegível.
    expect(antigo.every((row) => row.state === 'skipped')).toBe(true);
    expect(antigo.every((row) => row.sentAt === null)).toBe(true);
    // O aviso que falhou foi descartado por causa do vencimento alterado.
    expect(antigo.find((row) => row.milestone === 'D-1')?.state).toBe('skipped');

    // O vencimento novo tem o próprio conjunto de marcos.
    const novo = rows.filter((row) => row.dueDate === shiftDays(TODAY, 2));
    expect(novo.length).toBeGreaterThan(0);
    expect(novo.some((row) => row.state === 'sent')).toBe(true);
  });
});

describe('lembretes por e-mail — corretiva: a falha não pode ser perdida (AC-5)', () => {
  it('deve reenviar a falha de marco anterior mesmo com aviso nominal no mesmo dia', async () => {
    const scenario = createScenario();
    // Vence amanhã: D-3 (hoje-2), D-2 (hoje-1), D-1 (hoje) e D0 (amanhã).
    const bill = seedBill(scenario, { description: 'Luz', dueDate: shiftDays(TODAY, 1) });
    const failing = new FakeTransport({ failAll: true });

    // Dois dias atrás o marco D-3 falhou no envio.
    await runCycle(scenario.db, failing, makeConfig(), shiftDays(TODAY, -2));
    const afterFailure = ledgerFor(scenario.db, bill.id);
    expect(afterFailure).toHaveLength(1);
    expect(afterFailure[0].milestone).toBe('D-3');
    expect(afterFailure[0].state).toBe('failed');

    const working = new FakeTransport();
    const result = await runCycle(scenario.db, working, makeConfig(), TODAY);

    // Dois e-mails: a retentativa do D-3 e o aviso nominal do dia (D-1).
    expect(working.sent).toHaveLength(2);
    expect(milestonesOf(working.sent)).toEqual(['D-1', 'D-3']);
    expect(result.emailsSent).toBe(2);

    const rows = ledgerFor(scenario.db, bill.id);
    const d3 = rows.find((row) => row.milestone === 'D-3');
    const d2 = rows.find((row) => row.milestone === 'D-2');
    const d1 = rows.find((row) => row.milestone === 'D-1');

    // O D-3 que falhou foi reenviado: não virou `skipped` e a tentativa subiu.
    expect(d3?.state).toBe('sent');
    expect(d3?.attempts).toBe(2);
    expect(d3?.lastError).toBeNull();
    expect(d3?.sentAt).not.toBeNull();

    // O marco nominal do dia também saiu.
    expect(d1?.state).toBe('sent');
    expect(d1?.attempts).toBe(1);

    // O marco perdido que nunca falhou foi coberto pelo aviso de hoje.
    expect(d2?.state).toBe('skipped');
    expect(d2?.lastError).toBe('marco perdido: coberto pelo aviso de hoje');
  });

  it('deve reenviar uma falha isolada uma única vez', async () => {
    const scenario = createScenario();
    // Vence hoje: D0 (hoje) é o último marco do item.
    const bill = seedBill(scenario, { description: 'Luz', dueDate: TODAY });
    const failing = new FakeTransport({ failAll: true });

    await runCycle(scenario.db, failing, makeConfig(), TODAY);
    const failed = ledgerFor(scenario.db, bill.id).filter((row) => row.state === 'failed');
    expect(failed).toHaveLength(1);
    expect(failed[0].milestone).toBe('D0');

    const working = new FakeTransport();
    await runCycle(scenario.db, working, makeConfig(), shiftDays(TODAY, 1));

    // A falha é retentada: o item volta a ter aviso confirmado.
    expect(working.sent).toHaveLength(1);
    const row = ledgerFor(scenario.db, bill.id).find((item) => item.milestone === 'D0');
    expect(row?.state).toBe('sent');
    expect(row?.attempts).toBe(2);
    expect(row?.lastError).toBeNull();

    // Na execução seguinte nada é reenviado.
    const after = await runCycle(scenario.db, working, makeConfig(), shiftDays(TODAY, 2));
    expect(working.sent).toHaveLength(1);
    expect(after.emailsSent).toBe(0);
  });

  it('deve nunca descartar como skipped uma notificação que falhou', async () => {
    const scenario = createScenario();
    const bill = seedBill(scenario, { description: 'Luz', dueDate: shiftDays(TODAY, 1) });
    const failing = new FakeTransport({ failAll: true });

    await runCycle(scenario.db, failing, makeConfig(), shiftDays(TODAY, -2));
    const working = new FakeTransport();
    await runCycle(scenario.db, working, makeConfig(), TODAY);

    const rows = ledgerFor(scenario.db, bill.id);
    // Nenhuma notificação ficou presa em `failed` depois do ciclo.
    expect(rows.filter((row) => row.state === 'failed')).toHaveLength(0);
    // Só o marco que nunca falhou foi descartado como marco perdido.
    const discarded = rows.filter(
      (row) => row.state === 'skipped' && (row.lastError ?? '').startsWith('marco perdido'),
    );
    expect(discarded.map((row) => row.milestone)).toEqual(['D-2']);
    // A notificação que falhou não recebeu motivo de descarte.
    const d3 = rows.find((row) => row.milestone === 'D-3');
    expect(d3?.lastError).toBeNull();
  });

  it('deve manter no máximo um aviso novo por item no caminho normal', async () => {
    const scenario = createScenario();
    seedBill(scenario, { description: 'Luz', dueDate: shiftDays(TODAY, 1) });
    const transport = new FakeTransport();

    const result = await runCycle(scenario.db, transport, makeConfig(), TODAY);

    // Sem falha anterior: 1 e-mail por item por dia.
    expect(transport.sent).toHaveLength(1);
    expect(result.notificationsSelected).toBe(1);
    expect(result.emailsSent).toBe(1);
  });
});

describe('lembretes por e-mail — corretiva: texto do aviso de recuperação (AC-9)', () => {
  it('deve informar a data real do envio e dizer que o marco já havia passado', async () => {
    const scenario = createScenario();
    // Venceu ontem: nenhum marco nominal hoje — o aviso é de recuperação.
    seedBill(scenario, { description: 'Luz', dueDate: shiftDays(TODAY, -1) });
    const transport = new FakeTransport();

    await runCycle(scenario.db, transport, makeConfig(), TODAY);

    expect(transport.sent).toHaveLength(1);
    const message = transport.sent[0];

    // A data mostrada é a data real do envio, não a data antiga do marco.
    expect(message.text).toContain('Aviso enviado em 10/03/2026');
    expect(message.text).not.toContain('Aviso gerado em');
    expect(message.html).toContain('Aviso enviado em 10/03/2026');
    expect(message.html).not.toContain('Aviso gerado em');

    // O aviso deixa explícito que o marco previsto já havia passado.
    expect(message.text).toContain('Este aviso é de recuperação');
    expect(message.text).toContain('marco D-2 (previsto para 07/03/2026) já havia passado');
    expect(message.html).toContain('Este aviso é de recuperação');
    expect(message.html).toContain('já havia passado');
    expect(message.subject).toBe(
      'Finance: 1 conta a pagar precisa ser agendada (D-2 — recuperação)',
    );

    // A data de vencimento continua na lista: é a referência do prazo.
    expect(message.text).toContain('Vencimento: 09/03/2026');
    expect(message.html).toContain('Vencimento: 09/03/2026');
  });

  it('deve manter o assunto nominal quando o marco é do dia', async () => {
    const scenario = createScenario();
    seedBill(scenario, { description: 'Aluguel', dueDate: shiftDays(TODAY, 3) });
    const transport = new FakeTransport();

    await runCycle(scenario.db, transport, makeConfig(), TODAY);

    expect(transport.sent).toHaveLength(1);
    const message = transport.sent[0];
    expect(message.subject).toBe('Finance: 1 conta a pagar precisa ser agendada (D-3)');
    expect(message.text).toContain('Aviso enviado em 10/03/2026');
    expect(message.text).not.toContain('recuperação');
  });
});

describe('agendador de lembretes', () => {
  const clock = () => new Date('2026-03-10T12:00:00Z');

  it('deve executar um catch-up ao iniciar', async () => {
    const scenario = createScenario();
    seedBill(scenario, { description: 'Aluguel', dueDate: shiftDays(TODAY, 3) });
    const transport = new FakeTransport();
    const scheduler = createReminderScheduler({
      db: scenario.db,
      transport,
      config: makeConfig(),
      clock,
    });

    await scheduler.start();
    await scheduler.whenIdle();

    expect(transport.sent).toHaveLength(1);
    expect(milestoneOf(transport.sent[0])).toBe('D-3');
    expect(scheduler.started).toBe(true);

    scheduler.stop();
  });

  it('deve liberar a subida da API antes de o primeiro envio terminar', async () => {
    const scenario = createScenario();
    seedBill(scenario, { description: 'Luz', dueDate: shiftDays(TODAY, 1) });
    const transport = new ControllableTransport();
    transport.block = true;
    const scheduler = createReminderScheduler({
      db: scenario.db,
      transport,
      config: makeConfig(),
      clock,
    });

    try {
      const started = scheduler.start().then(() => 'started' as const);
      const outcome = await Promise.race([
        started,
        new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 100)),
      ]);

      // A subida da API não pode ficar refém de um SMTP lento ou caído.
      expect(outcome).toBe('started');
      expect(transport.sent).toHaveLength(1);
      expect(scheduler.running).toBe(true);

      transport.release();
      await scheduler.whenIdle();
      expect(scheduler.running).toBe(false);
    } finally {
      transport.release();
      scheduler.stop();
    }
  });

  it('deve encerrar de forma idempotente', async () => {
    const scenario = createScenario();
    const transport = new FakeTransport();
    const scheduler = createReminderScheduler({
      db: scenario.db,
      transport,
      config: makeConfig(),
      clock,
    });

    await scheduler.start();
    scheduler.stop();
    expect(() => scheduler.stop()).not.toThrow();
    expect(scheduler.started).toBe(false);
  });

  it('deve não iniciar quando o recurso está desabilitado', async () => {
    const scenario = createScenario();
    seedBill(scenario, { description: 'Aluguel', dueDate: shiftDays(TODAY, 3) });
    const transport = new FakeTransport();
    const scheduler = createReminderScheduler({
      db: scenario.db,
      transport,
      config: makeConfig({ enabled: false, to: null }),
      clock,
    });

    await scheduler.start();

    expect(scheduler.started).toBe(false);
    expect(await scheduler.runNow()).toBeNull();
    expect(transport.sent).toHaveLength(0);
    scheduler.stop();
  });

  it('deve ignorar o ciclo seguinte enquanto o anterior está em andamento', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-03-10T12:00:00Z'));
      const scenario = createScenario();
      seedBill(scenario, { description: 'Luz', dueDate: shiftDays(TODAY, 1) });
      const transport = new ControllableTransport();
      const scheduler = createReminderScheduler({
        db: scenario.db,
        transport,
        config: makeConfig(),
        clock: () => new Date(),
        intervalMinutes: 30,
      });

      await scheduler.start();
      await scheduler.whenIdle();
      expect(transport.sent).toHaveLength(1);
      expect(milestoneOf(transport.sent[0])).toBe('D-1');

      // No dia seguinte o marco D0 sai — e o envio fica bloqueado.
      vi.setSystemTime(new Date('2026-03-11T12:00:00Z'));
      transport.block = true;
      const pending = scheduler.runNow();
      await vi.advanceTimersByTimeAsync(0);
      expect(transport.sent).toHaveLength(2);
      expect(milestoneOf(transport.sent[1])).toBe('D0');

      // O tick do agendador não pode iniciar um terceiro ciclo.
      await vi.advanceTimersByTimeAsync(30 * 60_000);
      expect(transport.sent).toHaveLength(2);

      transport.release();
      await pending;
      scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('lembretes por e-mail — correção: a pré-visualização não consome o aviso (BLOCKER)', () => {
  it('não deve gravar nada no banco com o transporte de simulação', async () => {
    const scenario = createScenario();
    seedBill(scenario, { description: 'Aluguel', dueDate: shiftDays(TODAY, 3) });
    const dryRun = new DryRunTransport();

    const result = await runCycle(scenario.db, dryRun, makeConfig(), TODAY);

    // A mensagem foi preparada e entregue ao transporte (que a guarda em memória).
    expect(dryRun.messages).toHaveLength(1);
    expect(milestoneOf(dryRun.messages[0])).toBe('D-3');
    // O resumo descreve o que **teria** acontecido.
    expect(result.simulated).toBe(true);
    expect(result.notificationsCreated).toBe(1);
    expect(result.notificationsSelected).toBe(1);
    expect(result.emailsSent).toBe(1);
    // **Nada** foi gravado: nem notificação, nem lote, nem `state` alterado.
    expect(ledgerRows(scenario.db)).toHaveLength(0);
    expect(batchRows(scenario.db)).toHaveLength(0);
  });

  it('deve manter o marco elegível e enviar o aviso no ciclo seguinte', async () => {
    const scenario = createScenario();
    const bill = seedBill(scenario, { description: 'Aluguel', dueDate: shiftDays(TODAY, 3) });
    const dryRun = new DryRunTransport();

    await runCycle(scenario.db, dryRun, makeConfig(), TODAY);
    expect(ledgerRows(scenario.db)).toHaveLength(0);

    // Ciclo com transporte que entrega de verdade: o aviso **sai**.
    const real = new FakeTransport();
    const result = await runCycle(scenario.db, real, makeConfig(), TODAY);

    expect(real.sent).toHaveLength(1);
    expect(milestoneOf(real.sent[0])).toBe('D-3');
    expect(result.simulated).toBe(false);
    expect(result.emailsSent).toBe(1);

    const rows = ledgerFor(scenario.db, bill.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe('sent');
    expect(rows[0].sentAt).not.toBeNull();

    const batches = batchRows(scenario.db);
    expect(batches).toHaveLength(1);
    expect(batches[0].state).toBe('sent');
  });

  it('não deve marcar nada como skipped ou failed na simulação', async () => {
    const scenario = createScenario();
    seedBill(scenario, { description: 'Luz', dueDate: shiftDays(TODAY, 1) });
    const dryRun = new DryRunTransport();

    const result = await runCycle(scenario.db, dryRun, makeConfig(), TODAY);

    // O marco D-3 e o D-2 são perdidos: na simulação eles seriam descartados,
    // mas nada é gravado — o ledger continua vazio.
    expect(result.notificationsSkipped).toBe(2);
    expect(result.notificationsFailed).toBe(0);
    expect(ledgerRows(scenario.db)).toHaveLength(0);
  });

  it('não deve consumir o aviso quando o transporte de simulação falha', async () => {
    const scenario = createScenario();
    seedBill(scenario, { description: 'Aluguel', dueDate: shiftDays(TODAY, 3) });
    const dryRun = new DryRunTransport();

    await runCycle(scenario.db, dryRun, makeConfig(), TODAY);

    // A simulação não grava `failed`: o marco continua elegível.
    expect(ledgerRows(scenario.db)).toHaveLength(0);
    expect(batchRows(scenario.db)).toHaveLength(0);
  });
});

describe('lembretes por e-mail — correção: lote já enviado não descarta o item novo (MAJOR)', () => {
  it('deve manter a notificação pendente e registrar o motivo', async () => {
    const scenario = createScenario();
    const first = seedBill(scenario, { description: 'Aluguel', dueDate: shiftDays(TODAY, 3) });
    const transport = new FakeTransport();

    // Primeiro ciclo: o e-mail do marco D-3 sai para a primeira conta.
    await runCycle(scenario.db, transport, makeConfig(), TODAY);
    expect(transport.sent).toHaveLength(1);
    expect(ledgerFor(scenario.db, first.id)[0].state).toBe('sent');

    // Segunda conta é criada **depois** do e-mail: não estava nele.
    const second = seedBill(scenario, { description: 'Condominio', dueDate: shiftDays(TODAY, 3) });

    const result = await runCycle(scenario.db, transport, makeConfig(), TODAY);

    // Nenhum e-mail novo sai (o marco do dia já foi enviado).
    expect(transport.sent).toHaveLength(1);
    expect(result.emailsSent).toBe(0);

    // A notificação do item novo **permanece pendente** (não vira `skipped`).
    const rows = ledgerFor(scenario.db, second.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe('pending');
    expect(rows[0].lastError).toBe(
      'marco ja enviado para outro item; aguardando o proximo ciclo',
    );
    expect(rows[0].sentAt).toBeNull();
  });

  it('deve registrar o motivo da limpeza ao descartar o aviso', async () => {
    const scenario = createScenario();
    const bill = seedBill(scenario, { description: 'Luz', dueDate: shiftDays(TODAY, 3) });
    const failing = new FakeTransport({ failAll: true });

    await runCycle(scenario.db, failing, makeConfig(), TODAY);
    expect(ledgerFor(scenario.db, bill.id)[0].state).toBe('failed');

    // A conta é agendada: o aviso pendente é descartado **com o motivo**.
    updateBill(scenario.db, bill.id, { status: 'AG' });
    await runCycle(scenario.db, new FakeTransport(), makeConfig(), shiftDays(TODAY, 1));

    const row = ledgerFor(scenario.db, bill.id)[0];
    expect(row.state).toBe('skipped');
    expect(row.lastError).toBe('conta não está mais pendente');
  });

  it('deve registrar o motivo quando o vencimento muda', async () => {
    const scenario = createScenario();
    const bill = seedBill(scenario, { description: 'Luz', dueDate: shiftDays(TODAY, 3) });
    const failing = new FakeTransport({ failAll: true });

    await runCycle(scenario.db, failing, makeConfig(), TODAY);
    updateBill(scenario.db, bill.id, { dueDate: shiftDays(TODAY, 4) });
    await runCycle(scenario.db, new FakeTransport(), makeConfig(), TODAY);

    const antigo = ledgerFor(scenario.db, bill.id).filter((row) => row.milestone === 'D-3');
    expect(antigo).toHaveLength(1);
    expect(antigo[0].state).toBe('skipped');
    expect(antigo[0].lastError).toBe('vencimento alterado');
  });

  it('deve registrar o motivo quando a data-alvo sai da janela', async () => {
    const scenario = createScenario();
    const bill = seedBill(scenario, { description: 'Luz', dueDate: shiftDays(TODAY, 3) });
    const failing = new FakeTransport({ failAll: true });

    await runCycle(scenario.db, failing, makeConfig(), TODAY);
    await runCycle(scenario.db, new FakeTransport(), makeConfig(), shiftDays(TODAY, 4));

    const antigo = ledgerFor(scenario.db, bill.id).filter((row) => row.milestone === 'D-3');
    expect(antigo[0].state).toBe('skipped');
    expect(antigo[0].lastError).toBe('data-alvo fora da janela');
  });
});

describe('lembretes por e-mail — sanitização do erro (MAJOR)', () => {
  it('deve remover o endereço IP do servidor SMTP', () => {
    const sanitized = sanitizeReminderError(new Error('connect ECONNREFUSED 10.0.0.5:587'));

    expect(sanitized).not.toContain('10.0.0.5');
    expect(sanitized).toContain('[host]');
  });

  it('deve remover o host do servidor SMTP', () => {
    const sanitized = sanitizeReminderError(
      new Error('Greeting never received from smtp.exemplo.com'),
    );

    expect(sanitized).not.toContain('smtp.exemplo.com');
    expect(sanitized).toContain('[host]');
  });

  it('deve remover o usuário do servidor SMTP', () => {
    const sanitized = sanitizeReminderError(
      new Error('535 5.7.8 Error: authentication failed: user finance'),
    );

    expect(sanitized).not.toContain('finance');
    expect(sanitized).toContain('[redacted]');
  });

  it('deve remover a senha do servidor SMTP', () => {
    const sanitized = sanitizeReminderError(
      new Error('Connection timeout: user "finance" password hunter2'),
    );

    expect(sanitized).not.toContain('hunter2');
    expect(sanitized).not.toContain('finance');
    expect(sanitized).toContain('[redacted]');
  });

  it('deve redigir os valores configurados quando aparecem no texto', () => {
    const sanitized = sanitizeReminderError(
      new Error('falha ao conectar em smtp.exemplo.com: user finance password hunter2'),
      ['smtp.exemplo.com', 'finance', 'hunter2'],
    );

    expect(sanitized).not.toContain('smtp.exemplo.com');
    expect(sanitized).not.toContain('finance');
    expect(sanitized).not.toContain('hunter2');
    expect(sanitized).toContain('[redacted]');
  });

  it('deve remover o valor monetário da mensagem de erro', () => {
    const sanitized = sanitizeReminderError(new Error('conta de R$ 1.234,56 recusada'));

    expect(sanitized).not.toContain('1.234,56');
    expect(sanitized).not.toContain('R$');
    expect(sanitized).toContain('[valor]');
  });

  it('deve redigir a descrição da conta quando ela vaza no erro', async () => {
    const scenario = createScenario();
    const bill = seedBill(scenario, {
      description: 'Aluguel do Joao',
      dueDate: shiftDays(TODAY, 3),
    });
    const transport = new ThrowingTransport(
      new Error('falha ao enviar para Aluguel do Joao'),
    );

    await runCycle(scenario.db, transport, makeConfig(), TODAY);

    const row = ledgerFor(scenario.db, bill.id)[0];
    expect(row.lastError).not.toContain('Joao');
    expect(row.lastError).toContain('[redacted]');
  });

  it('deve usar as credenciais configuradas na sanitização do erro', async () => {
    const scenario = createScenario();
    const bill = seedBill(scenario, { description: 'Aluguel', dueDate: shiftDays(TODAY, 3) });
    const transport = new ThrowingTransport(
      new Error('connect ECONNREFUSED smtp.exemplo.com: user finance password hunter2'),
    );
    const config = makeConfig({
      transport: 'smtp',
      smtp: { host: 'smtp.exemplo.com', port: 587, secure: false, user: 'finance', password: 'hunter2' },
    });

    await runCycle(scenario.db, transport, config, TODAY);

    const row = ledgerFor(scenario.db, bill.id)[0];
    expect(row.lastError).not.toContain('smtp.exemplo.com');
    expect(row.lastError).not.toContain('hunter2');
    expect(row.lastError).not.toContain('finance');
  });
});

describe('lembretes por e-mail — concorrência entre processos (INFO)', () => {
  it('deve tratar a violação da chave única do lote sem derrubar o ciclo', async () => {
    const scenario = createScenario();
    const bill = seedBill(scenario, { description: 'Aluguel', dueDate: shiftDays(TODAY, 3) });

    // Simula a corrida: outro processo grava o lote do marco entre a
    // consulta e a inserção (o gatilho roda antes do INSERT).
    scenario.sqlite.exec(`
      CREATE TRIGGER corrida_lote BEFORE INSERT ON bill_reminder_batches
      WHEN NEW.milestone = 'D-3'
      BEGIN
        INSERT INTO bill_reminder_batches
          (milestone, send_date, state, attempts, item_count, recipient, created_at, updated_at)
        VALUES
          (NEW.milestone, NEW.send_date, 'sent', 1, 0, NEW.recipient, NEW.created_at, NEW.updated_at);
      END;
    `);

    const transport = new FakeTransport();
    const result = await runCycle(scenario.db, transport, makeConfig(), TODAY);

    // O ciclo não quebra: nada foi enviado e o lote existente foi respeitado.
    expect(transport.sent).toHaveLength(0);
    expect(result.emailsSent).toBe(0);
    expect(result.emailsFailed).toBe(0);
    expect(result.batches).toHaveLength(1);
    expect(result.batches[0].state).toBe('skipped');
    expect(result.notificationsSkipped).toBe(0);

    // O perdedor da corrida não consome o aviso do vencedor: a notificação
    // permanece `pending` (nada de `skipped`/`sent` indevido).
    const row = ledgerFor(scenario.db, bill.id)[0];
    expect(row.state).toBe('pending');
    expect(row.lastError).toBeNull();

    // Um novo ciclo também não envia nem consome o aviso enquanto o lote
    // estiver reservado por outro processo.
    const next = await runCycle(scenario.db, transport, makeConfig(), TODAY);
    expect(next.emailsSent).toBe(0);
    expect(transport.sent).toHaveLength(0);
    expect(ledgerFor(scenario.db, bill.id)[0].state).toBe('pending');
  });
});

describe('lembretes por e-mail — limite de tentativas (MINOR)', () => {
  it('deve descartar o aviso quando o limite de tentativas é estourado', async () => {
    const scenario = createScenario();
    const bill = seedBill(scenario, { description: 'Aluguel', dueDate: shiftDays(TODAY, 3) });
    const failing = new FakeTransport({ failAll: true });

    // Cada ciclo tenta de novo; a partir do limite, o aviso é descartado.
    for (let round = 0; round < 5; round += 1) {
      await runCycle(scenario.db, failing, makeConfig(), TODAY);
    }

    const row = ledgerFor(scenario.db, bill.id)[0];
    expect(row.state).toBe('skipped');
    expect(row.attempts).toBe(5);
    expect(row.lastError).toBe('falha persistente: limite de tentativas');
    expect(row.sentAt).toBeNull();
  });
});

describe('lembretes por e-mail — prazo restante no aviso (NIT)', () => {
  it('deve informar quantos dias faltam para o vencimento', async () => {
    const scenario = createScenario();
    seedBill(scenario, { description: 'Aluguel', dueDate: shiftDays(TODAY, 3) });
    const transport = new FakeTransport();

    await runCycle(scenario.db, transport, makeConfig(), TODAY);

    const message = transport.sent[0];
    expect(message.text).toContain('Vencimento: 13/03/2026 (faltam 3 dias)');
    expect(message.html).toContain('Vencimento: 13/03/2026 (faltam 3 dias)');
  });

  it('deve informar quando o item vence hoje', async () => {
    const scenario = createScenario();
    seedBill(scenario, { description: 'Internet', dueDate: TODAY });
    const transport = new FakeTransport();

    await runCycle(scenario.db, transport, makeConfig(), TODAY);

    expect(transport.sent[0].text).toContain('Vencimento: 10/03/2026 (vence hoje)');
  });

  it('deve informar o prazo sem expor valor monetário', async () => {
    const scenario = createScenario();
    seedBill(scenario, {
      description: 'Conta de energia',
      dueDate: shiftDays(TODAY, 3),
      amountCents: SENTINEL_AMOUNT,
    });
    const transport = new FakeTransport();

    await runCycle(scenario.db, transport, makeConfig(), TODAY);

    const message = transport.sent[0];
    for (const content of [message.subject, message.text, message.html]) {
      expect(content).not.toContain('123456');
      expect(content).not.toContain('R$');
    }
  });
});
