import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseHandle } from '../src/db/client';
import { openMigratedDatabase } from '../src/db/client';
import { billReminderBatches, billReminderNotifications } from '../src/db/schema';
import { addDaysIso } from '../src/lib/dates';
import { createBill } from '../src/services/bills';
import type { BillReminderConfig } from '../src/services/bill-reminder-config';
import { runBillReminders } from '../src/services/bill-reminders';
import {
  FakeTransport,
  type ReminderMessage,
  type ReminderTransport,
} from '../src/services/bill-reminder-transport';
import { ensureLookup } from '../src/services/lookups';

/**
 * Concorrência CLI × agendador.
 *
 * Duas conexões independentes no **mesmo arquivo** SQLite representam os dois
 * processos (é exatamente o cenário do BUG-01 encontrado pelo QA: CLI e
 * backend abertos ao mesmo tempo). O banco é sempre temporário — nunca
 * `server/data/finance.db` — e o transporte nunca abre rede.
 *
 * Contrato da correção:
 * - o lote é o `claim` atômico: lote `pending` recente pertence a quem está
 *   enviando; outro processo **não** reenvia;
 * - retentativa só a partir de `failed`, com `UPDATE` condicional;
 * - lote `pending` abandonado (processo interrompido) é retomado apenas depois
 *   da janela de abandono, por compare-and-swap;
 * - o perdedor da corrida nunca altera o estado das notificações.
 */

const TODAY = '2026-03-10';
const RECIPIENT = 'lembretes@exemplo.invalid';
/**
 * Janela de abandono do claim, em minutos. É um contrato observável: um lote
 * `pending` mais novo que isso está "em voo"; mais velho pode ser retomado.
 * Espelha `STALE_BATCH_CLAIM_MINUTES` do núcleo.
 */
const STALE_CLAIM_MINUTES = 30;

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

function shiftDays(date: string, days: number): string {
  const shifted = addDaysIso(date, days);
  if (!shifted) throw new Error(`Data inválida: ${date}`);
  return shifted;
}

/** Transporte que sinaliza quando entrou no envio e só termina após `release()`. */
class GateTransport implements ReminderTransport {
  readonly kind = 'gate';
  readonly persists = true;
  readonly sent: ReminderMessage[] = [];

  private releaseGate!: () => void;
  private readonly gate = new Promise<void>((resolve) => {
    this.releaseGate = resolve;
  });
  private signalEntered!: () => void;
  readonly entered = new Promise<void>((resolve) => {
    this.signalEntered = resolve;
  });

  async send(message: ReminderMessage): Promise<void> {
    this.sent.push(message);
    this.signalEntered();
    await this.gate;
  }

  release(): void {
    this.releaseGate();
  }
}

describe('lembretes — concorrência CLI × agendador', () => {
  let directory: string;
  let handles: DatabaseHandle[] = [];

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'finance-reminders-'));
  });

  afterEach(() => {
    for (const handle of handles) {
      try {
        handle.sqlite.close();
      } catch {
        // Conexão já fechada pelo teste.
      }
    }
    handles = [];
    fs.rmSync(directory, { recursive: true, force: true });
  });

  function openConnections(): { cli: DatabaseHandle; scheduler: DatabaseHandle } {
    const file = path.join(directory, 'finance.db');
    const cli = openMigratedDatabase(file);
    const scheduler = openMigratedDatabase(file);
    handles.push(cli, scheduler);
    return { cli, scheduler };
  }

  function seedBill(handle: DatabaseHandle, dueDate = shiftDays(TODAY, 3)) {
    const category = ensureLookup(handle.db, 'category', 'Moradia');
    return createBill(handle.db, {
      description: 'Aluguel',
      amountCents: 1000,
      dueDate,
      categoryId: category.id,
      status: '',
    });
  }

  it('não envia duas vezes o mesmo item/marco quando a CLI roda durante o envio do agendador', async () => {
    const { cli, scheduler } = openConnections();
    const bill = seedBill(cli);
    const schedulerTransport = new GateTransport();
    const cliTransport = new FakeTransport();

    const schedulerRun = runBillReminders({
      db: scheduler.db,
      transport: schedulerTransport,
      config: makeConfig(),
      today: TODAY,
    });

    let released = false;
    try {
      // O agendador já reservou o lote e está parado dentro do envio.
      await schedulerTransport.entered;

      const cliResult = await runBillReminders({
        db: cli.db,
        transport: cliTransport,
        config: makeConfig(),
        today: TODAY,
      });

      // O segundo processo não pode obter autorização para enviar o mesmo marco.
      expect(cliTransport.sent).toHaveLength(0);
      expect(cliResult.emailsSent).toBe(0);

      // E não pode "consumir" o aviso que o primeiro está enviando.
      const during = cli.db.select().from(billReminderNotifications).all();
      expect(during).toHaveLength(1);
      expect(during[0].state).toBe('pending');

      schedulerTransport.release();
      released = true;
      const schedulerResult = await schedulerRun;
      expect(schedulerResult.emailsSent).toBe(1);
      expect(schedulerTransport.sent).toHaveLength(1);
    } finally {
      if (!released) schedulerTransport.release();
      await schedulerRun.catch(() => undefined);
    }

    const rows = cli.db.select().from(billReminderNotifications).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].billId).toBe(bill.id);
    expect(rows[0].state).toBe('sent');
    expect(rows[0].attempts).toBe(1);

    const batches = cli.db.select().from(billReminderBatches).all();
    expect(batches).toHaveLength(1);
    expect(batches[0].state).toBe('sent');
    expect(batches[0].attempts).toBe(1);

    // Execução repetida depois do sucesso continua sem reenviar.
    const later = new FakeTransport();
    await runBillReminders({
      db: cli.db,
      transport: later,
      config: makeConfig(),
      today: TODAY,
    });
    expect(later.sent).toHaveLength(0);
  });

  it('retenta em outro processo depois de falha de transporte sem duplicar o aviso confirmado', async () => {
    const { cli, scheduler } = openConnections();
    seedBill(cli);
    const failing = new FakeTransport({ failAll: true });

    const first = await runBillReminders({
      db: cli.db,
      transport: failing,
      config: makeConfig(),
      today: TODAY,
    });
    expect(first.emailsFailed).toBe(1);

    const retry = new FakeTransport();
    const second = await runBillReminders({
      db: scheduler.db,
      transport: retry,
      config: makeConfig(),
      today: TODAY,
    });
    expect(second.emailsSent).toBe(1);
    expect(retry.sent).toHaveLength(1);

    const row = cli.db.select().from(billReminderNotifications).get();
    expect(row?.state).toBe('sent');
    expect(row?.attempts).toBe(2);

    const batch = cli.db.select().from(billReminderBatches).get();
    expect(batch?.state).toBe('sent');
    expect(batch?.attempts).toBe(2);

    const third = new FakeTransport();
    await runBillReminders({
      db: cli.db,
      transport: third,
      config: makeConfig(),
      today: TODAY,
    });
    expect(third.sent).toHaveLength(0);
  });

  it('não reenvia um lote pending recente que outro processo está enviando', async () => {
    const { cli, scheduler } = openConnections();
    const bill = seedBill(cli);
    const dueDate = shiftDays(TODAY, 3);
    const nowIso = new Date().toISOString();
    cli.db
      .insert(billReminderBatches)
      .values({
        milestone: 'D-3',
        sendDate: TODAY,
        state: 'pending',
        attempts: 1,
        itemCount: 1,
        recipient: RECIPIENT,
        createdAt: nowIso,
        updatedAt: nowIso,
      })
      .run();
    cli.db
      .insert(billReminderNotifications)
      .values({
        billId: bill.id,
        milestone: 'D-3',
        dueDate,
        sendDate: TODAY,
        state: 'pending',
        attempts: 0,
        createdAt: nowIso,
        updatedAt: nowIso,
      })
      .run();

    const transport = new FakeTransport();
    const result = await runBillReminders({
      db: scheduler.db,
      transport,
      config: makeConfig(),
      today: TODAY,
      now: new Date(nowIso),
    });

    expect(transport.sent).toHaveLength(0);
    expect(result.emailsSent).toBe(0);
    expect(result.batches).toHaveLength(1);
    expect(result.batches[0].state).toBe('skipped');

    // O lote em voo continua pertencendo ao outro processo.
    expect(cli.db.select().from(billReminderNotifications).get()?.state).toBe('pending');
  });

  it('recupera lote pending abandonado depois da janela de abandono', async () => {
    const { cli, scheduler } = openConnections();
    const bill = seedBill(cli);
    const dueDate = shiftDays(TODAY, 3);
    const reference = new Date(`${TODAY}T12:00:00Z`);
    const oldIso = new Date(
      reference.getTime() - (STALE_CLAIM_MINUTES + 1) * 60_000,
    ).toISOString();
    cli.db
      .insert(billReminderBatches)
      .values({
        milestone: 'D-3',
        sendDate: TODAY,
        state: 'pending',
        attempts: 1,
        itemCount: 1,
        recipient: RECIPIENT,
        createdAt: oldIso,
        updatedAt: oldIso,
      })
      .run();
    cli.db
      .insert(billReminderNotifications)
      .values({
        billId: bill.id,
        milestone: 'D-3',
        dueDate,
        sendDate: TODAY,
        state: 'pending',
        attempts: 0,
        createdAt: oldIso,
        updatedAt: oldIso,
      })
      .run();

    const transport = new FakeTransport();
    const result = await runBillReminders({
      db: scheduler.db,
      transport,
      config: makeConfig(),
      today: TODAY,
      now: reference,
    });

    expect(result.emailsSent).toBe(1);
    expect(transport.sent).toHaveLength(1);

    const row = cli.db.select().from(billReminderNotifications).get();
    expect(row?.state).toBe('sent');
    expect(row?.attempts).toBe(1);

    const batch = cli.db.select().from(billReminderBatches).get();
    expect(batch?.state).toBe('sent');
    // 1 tentativa abandonada + 1 retomada.
    expect(batch?.attempts).toBe(2);
  });
});
