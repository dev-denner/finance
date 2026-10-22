import type { AppDatabase } from '../db/client';
import { todayIsoInTimeZone } from '../lib/dates';
import type { BillReminderConfig } from './bill-reminder-config';
import { REMINDER_TIME_ZONE } from './bill-reminder-config';
import {
  noopReminderLogger,
  runBillReminders,
  sanitizeReminderError,
  type ReminderLogger,
  type RunBillRemindersResult,
} from './bill-reminders';
import type { ReminderTransport } from './bill-reminder-transport';

/**
 * Agendador interno dos lembretes.
 *
 * Fica **fora** de `buildApp` (usado pelos testes) e é ligado apenas em
 * `server/src/index.ts`. Recalcula "hoje" em São Paulo a cada ciclo, roda um
 * *catch-up* em segundo plano na subida (sem atrasar a API) e não deixa duas
 * execuções se sobreporem.
 */

export interface ReminderSchedulerOptions {
  db: AppDatabase;
  transport: ReminderTransport | null;
  config: BillReminderConfig;
  logger?: ReminderLogger;
  /** Intervalo entre ciclos, em minutos. Padrão: `config.intervalMinutes`. */
  intervalMinutes?: number;
  /** Relógio injetável (testes). Padrão: `new Date()`. */
  clock?: () => Date;
}

export interface ReminderScheduler {
  /**
   * Inicia o agendamento. O *catch-up* roda em segundo plano: a promessa
   * resolve assim que o timer está armado, **sem esperar** o primeiro envio —
   * um SMTP lento ou caído não atrasa a subida da API.
   */
  start(): Promise<void>;
  /** Encerra o agendamento. Idempotente. */
  stop(): void;
  /** Executa um ciclo agora. Devolve `null` quando desabilitado ou sobreposto. */
  runNow(): Promise<RunBillRemindersResult | null>;
  /** Resolve quando o ciclo em andamento (inclusive o catch-up) terminar. */
  whenIdle(): Promise<void>;
  readonly started: boolean;
  readonly running: boolean;
}

class InternalReminderScheduler implements ReminderScheduler {
  private timer: NodeJS.Timeout | null = null;
  private isStarted = false;
  private isRunning = false;
  /** Ciclo em andamento, para `whenIdle()` e para o encerramento gracioso. */
  private inflight: Promise<RunBillRemindersResult | null> | null = null;

  private readonly db: AppDatabase;
  private readonly transport: ReminderTransport | null;
  private readonly config: BillReminderConfig;
  private readonly logger: ReminderLogger;
  private readonly intervalMinutes: number;
  private readonly clock: () => Date;

  constructor(options: ReminderSchedulerOptions) {
    this.db = options.db;
    this.transport = options.transport;
    this.config = options.config;
    this.logger = options.logger ?? noopReminderLogger;
    this.intervalMinutes = options.intervalMinutes ?? options.config.intervalMinutes;
    this.clock = options.clock ?? (() => new Date());
  }

  get started(): boolean {
    return this.isStarted;
  }

  get running(): boolean {
    return this.isRunning;
  }

  async start(): Promise<void> {
    if (this.isStarted) return;
    if (!this.config.enabled) {
      this.logger.info(
        {},
        'Agendador de lembretes não iniciado (recurso desabilitado).',
      );
      return;
    }
    if (!this.transport) {
      this.logger.info(
        {},
        'Agendador de lembretes não iniciado (nenhum transporte que entregue de verdade).',
      );
      return;
    }
    if (!this.transport.persists) {
      // Defesa em profundidade: um transporte de pré-visualização nunca
      // consome o aviso do dia, mesmo que o núcleo mude.
      this.logger.info(
        {},
        'Agendador de lembretes não iniciado (transporte em modo de pré-visualização).',
      );
      return;
    }

    this.isStarted = true;

    // Armazena o timer **antes** do catch-up e não espera o primeiro ciclo:
    // o envio de e-mail não pode atrasar a subida da API (BUG-02). O
    // `isRunning` continua impedindo sobreposição entre o catch-up e os ticks.
    const intervalMs = Math.max(1, this.intervalMinutes) * 60_000;
    this.timer = setInterval(() => {
      void this.runNow();
    }, intervalMs);
    // O timer não segura o processo aberto.
    this.timer.unref();

    void this.runNow();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.isStarted = false;
  }

  runNow(): Promise<RunBillRemindersResult | null> {
    if (!this.config.enabled || !this.transport) return Promise.resolve(null);
    if (!this.transport.persists) {
      this.logger.warn(
        {},
        'Ciclo de lembretes ignorado (transporte em modo de pré-visualização).',
      );
      return Promise.resolve(null);
    }
    if (this.isRunning) {
      this.logger.warn({}, 'Ciclo de lembretes anterior ainda em andamento; ciclo ignorado.');
      return Promise.resolve(null);
    }

    this.isRunning = true;
    const run = this.executeCycle();
    const tracked = run.finally(() => {
      this.isRunning = false;
    });
    this.inflight = tracked;
    void tracked.then(() => {
      if (this.inflight === tracked) this.inflight = null;
    });
    return tracked;
  }

  async whenIdle(): Promise<void> {
    const pending = this.inflight;
    if (pending) await pending;
  }

  private async executeCycle(): Promise<RunBillRemindersResult | null> {
    const transport = this.transport;
    if (!transport) return null;
    try {
      const now = this.clock();
      const today = todayIsoInTimeZone(REMINDER_TIME_ZONE, now);
      return await runBillReminders({
        db: this.db,
        transport,
        config: this.config,
        today,
        now,
        logger: this.logger,
      });
    } catch (error) {
      this.logger.error(
        { error: sanitizeReminderError(error) },
        'Falha ao executar o ciclo de lembretes.',
      );
      return null;
    }
  }
}

/** Cria o agendador interno de lembretes. */
export function createReminderScheduler(options: ReminderSchedulerOptions): ReminderScheduler {
  return new InternalReminderScheduler(options);
}
