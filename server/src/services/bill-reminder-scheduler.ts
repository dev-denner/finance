import type { AppDatabase } from '../db/client';
import { todayIsoInTimeZone } from '../lib/dates';
import type { BillReminderConfig } from './bill-reminder-config';
import { REMINDER_TIME_ZONE } from './bill-reminder-config';
import {
  noopReminderLogger,
  runBillReminders,
  type ReminderLogger,
  type RunBillRemindersResult,
} from './bill-reminders';
import type { ReminderTransport } from './bill-reminder-transport';

/**
 * Agendador interno dos lembretes.
 *
 * Fica **fora** de `buildApp` (usado pelos testes) e é ligado apenas em
 * `server/src/index.ts`. Recalcula "hoje" em São Paulo a cada ciclo, roda um
 * *catch-up* na subida e não deixa duas execuções se sobreporem.
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
  /** Inicia o agendamento (executa um catch-up antes do primeiro tick). */
  start(): Promise<void>;
  /** Encerra o agendamento. Idempotente. */
  stop(): void;
  /** Executa um ciclo agora. Devolve `null` quando desabilitado ou sobreposto. */
  runNow(): Promise<RunBillRemindersResult | null>;
  readonly started: boolean;
  readonly running: boolean;
}

class InternalReminderScheduler implements ReminderScheduler {
  private timer: NodeJS.Timeout | null = null;
  private isStarted = false;
  private isRunning = false;

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
    await this.runNow();

    const intervalMs = Math.max(1, this.intervalMinutes) * 60_000;
    this.timer = setInterval(() => {
      void this.runNow();
    }, intervalMs);
    // O timer não segura o processo aberto.
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.isStarted = false;
  }

  async runNow(): Promise<RunBillRemindersResult | null> {
    if (!this.config.enabled || !this.transport) return null;
    if (!this.transport.persists) {
      this.logger.warn(
        {},
        'Ciclo de lembretes ignorado (transporte em modo de pré-visualização).',
      );
      return null;
    }
    if (this.isRunning) {
      this.logger.warn({}, 'Ciclo de lembretes anterior ainda em andamento; ciclo ignorado.');
      return null;
    }

    this.isRunning = true;
    try {
      const now = this.clock();
      const today = todayIsoInTimeZone(REMINDER_TIME_ZONE, now);
      return await runBillReminders({
        db: this.db,
        transport: this.transport,
        config: this.config,
        today,
        now,
        logger: this.logger,
      });
    } catch (error) {
      this.logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        'Falha ao executar o ciclo de lembretes.',
      );
      return null;
    } finally {
      this.isRunning = false;
    }
  }
}

/** Cria o agendador interno de lembretes. */
export function createReminderScheduler(options: ReminderSchedulerOptions): ReminderScheduler {
  return new InternalReminderScheduler(options);
}
