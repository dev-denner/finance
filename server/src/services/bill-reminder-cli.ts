import path from 'node:path';
import { openMigratedDatabase } from '../db/client';
import { parseIsoDate } from '../lib/dates';
import { loadBillReminderConfig, type BillReminderConfig } from './bill-reminder-config';
import {
  runBillReminders,
  type ReminderLogger,
  type RunBillRemindersResult,
} from './bill-reminders';
import { createSmtpTransport } from './bill-reminder-smtp';
import { DryRunTransport, type ReminderTransport } from './bill-reminder-transport';

/**
 * CLI dos lembretes por e-mail.
 *
 * Usa exatamente o mesmo núcleo do agendador interno (`runBillReminders`).
 * Sem argumentos, usa o transporte configurado no ambiente; com `--dry-run`,
 * imprime o e-mail em vez de enviar.
 *
 *   npm run reminders:run [-- --today=AAAA-MM-DD] [--dry-run]
 *
 * O `--dry-run` é uma **simulação pura**: nada é gravado no banco, então o
 * aviso do dia **não é consumido** e continua elegível para o ciclo com o
 * transporte que entrega de verdade.
 */

const USAGE = [
  'Uso: npm run reminders:run [-- --today=AAAA-MM-DD] [--dry-run]',
  '',
  '  --today=AAAA-MM-DD  Data de referência do ciclo (padrão: hoje em São Paulo).',
  '                      Aceita também DD/MM/AAAA.',
  '  --dry-run           Simula o ciclo e imprime o e-mail (não envia e não grava).',
  '  --help              Mostra esta ajuda.',
].join('\n');

export interface CliOptions {
  today: string | null;
  dryRun: boolean;
  help: boolean;
}

/**
 * Lê os argumentos da linha de comando. Argumento desconhecido gera erro
 * explícito (a CLI nunca ignora o que não conhece).
 */
export function parseCliArgs(argv: string[]): CliOptions {
  const options: CliOptions = { today: null, dryRun: false, help: false };

  for (const arg of argv) {
    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg.startsWith('--today=')) {
      options.today = arg.slice('--today='.length);
      continue;
    }
    throw new Error(`Argumento desconhecido: ${arg}. Use --help para ver as opções.`);
  }

  return options;
}

export interface CliDependencies {
  /** Ambiente lido pela configuração dos lembretes. */
  env: NodeJS.ProcessEnv;
  /** Saída normal (resumo e e-mails da simulação). */
  write: (text: string) => void;
  /** Saída de erro. */
  writeError: (text: string) => void;
  /** Banco usado no ciclo. */
  databasePath: string;
  /** Fábrica do transporte (testes injetam um dublê; nunca há rede). */
  createTransport?: (config: BillReminderConfig) => ReminderTransport;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createLogger(deps: CliDependencies): ReminderLogger {
  return {
    info: (_details, message) => {
      if (message) deps.write(`${message}\n`);
    },
    warn: (_details, message) => {
      if (message) deps.write(`Aviso: ${message}\n`);
    },
    error: (_details, message) => {
      if (message) deps.writeError(`Erro: ${message}\n`);
    },
  };
}

function printSummary(result: RunBillRemindersResult, deps: CliDependencies): void {
  const write = deps.write;
  write('Resumo dos lembretes\n');
  write(
    `  Data de referência: ${result.today} (janela ${result.windowStart} a ${result.windowEnd})\n`,
  );
  write(`  Modo: ${result.simulated ? 'simulação (nada foi gravado)' : 'envio real'}\n`);
  write(`  Contas pendentes na janela: ${result.eligibleBills}\n`);
  write(`  Notificações criadas: ${result.notificationsCreated}\n`);
  write(`  Notificações ignoradas (skipped): ${result.notificationsSkipped}\n`);
  write(`  Itens selecionados: ${result.notificationsSelected}\n`);
  write(`  E-mails enviados: ${result.emailsSent}\n`);
  write(`  E-mails com falha: ${result.emailsFailed}\n`);
  write(`  Avisos confirmados: ${result.notificationsSent}\n`);
  write(`  Avisos com falha: ${result.notificationsFailed}\n`);
}

function printMessages(
  messages: { to: string; subject: string; text: string; html: string; messageId: string }[],
  deps: CliDependencies,
): void {
  const write = deps.write;
  if (messages.length === 0) {
    write('Nenhum e-mail a exibir (nada seria enviado neste ciclo).\n');
    return;
  }
  messages.forEach((message, index) => {
    write(`\n--- E-mail ${index + 1} (dry-run) ---\n`);
    write(`Para: ${message.to}\n`);
    write(`Assunto: ${message.subject}\n`);
    write(`Message-ID: ${message.messageId}\n`);
    write('--- texto ---\n');
    write(`${message.text}\n`);
    write('--- html ---\n');
    write(`${message.html}\n`);
  });
}

/**
 * Executa a CLI e devolve o **código de saída** (0 = sucesso, 1 = falha).
 * A função é pura em relação ao ambiente: tudo o que ela usa é injetado.
 */
export async function runCli(argv: string[], deps: CliDependencies): Promise<number> {
  let options: CliOptions;
  try {
    options = parseCliArgs(argv);
  } catch (error) {
    deps.writeError(`Erro: ${messageOf(error)}\n`);
    return 1;
  }

  if (options.help) {
    deps.write(`${USAGE}\n`);
    return 0;
  }

  if (options.today !== null) {
    const parsed = parseIsoDate(options.today);
    if (!parsed.ok) {
      deps.writeError(
        `Erro: --today inválido (${options.today}). Use AAAA-MM-DD ou DD/MM/AAAA.\n`,
      );
      return 1;
    }
    options.today = parsed.value;
  }

  const config = loadBillReminderConfig(deps.env);
  if (!config.enabled) {
    deps.write('Lembretes por e-mail desabilitados: defina BILL_REMINDER_TO para ativá-los.\n');
    return 0;
  }

  // `--dry-run` sempre vence: nenhum e-mail real pode sair por engano.
  const useDryRun = options.dryRun || config.transport !== 'smtp';
  const transport: ReminderTransport = useDryRun
    ? new DryRunTransport()
    : (deps.createTransport ?? ((cfg: BillReminderConfig) => createSmtpTransport(cfg)))(config);

  const handle = openMigratedDatabase(deps.databasePath);
  try {
    const result = await runBillReminders({
      db: handle.db,
      transport,
      config,
      today: options.today ?? undefined,
      logger: createLogger(deps),
    });
    printSummary(result, deps);
    if (transport instanceof DryRunTransport) {
      printMessages(transport.messages, deps);
    }
    return result.emailsFailed > 0 ? 1 : 0;
  } finally {
    handle.sqlite.close();
  }
}

/** `true` quando este arquivo é o ponto de entrada do processo. */
function isMainModule(): boolean {
  if (typeof require === 'undefined' || typeof module === 'undefined') return false;
  return require.main === module;
}

if (isMainModule()) {
  const deps: CliDependencies = {
    env: process.env,
    write: (text) => process.stdout.write(text),
    writeError: (text) => process.stderr.write(text),
    databasePath:
      process.env.DATABASE_PATH ?? path.resolve(__dirname, '../../data/finance.db'),
  };

  runCli(process.argv.slice(2), deps)
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      deps.writeError(`Erro: ${messageOf(error)}\n`);
      process.exitCode = 1;
    });
}
