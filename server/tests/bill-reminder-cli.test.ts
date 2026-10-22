import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openMigratedDatabase, type DatabaseHandle } from '../src/db/client';
import { billReminderBatches, billReminderNotifications } from '../src/db/schema';
import type { BillReminderConfig } from '../src/services/bill-reminder-config';
import { parseCliArgs, runCli, type CliDependencies } from '../src/services/bill-reminder-cli';
import { createBill } from '../src/services/bills';
import { ensureLookup } from '../src/services/lookups';
import { FakeTransport, type ReminderTransport } from '../src/services/bill-reminder-transport';

/**
 * CLI dos lembretes por e-mail.
 *
 * Cobertura:
 * - parsing de `--today=AAAA-MM-DD` e `--today=DD/MM/AAAA`;
 * - `--dry-run` e `--help`;
 * - argumento desconhecido com erro claro;
 * - `--dry-run` **não consome** o marco (o aviso continua elegível);
 * - código de saída 1 quando o envio falha;
 * - o resumo impresso traz as contagens.
 *
 * Nenhum teste toca a rede: o transporte é sempre um dublê em memória e o
 * `globalThis.fetch` é substituído por uma função que lança.
 */

const TODAY = '2026-03-10';
const RECIPIENT = 'lembretes@exemplo.invalid';

const fetchOriginal = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = (() => {
    throw new Error('A rede está bloqueada nos testes da CLI de lembretes.');
  }) as typeof globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = fetchOriginal;
});

let tempRoot: string;
let databasePath: string;

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'finance-reminder-cli-'));
  databasePath = path.join(tempRoot, 'finance.db');
});

afterEach(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

/** Cria o banco com uma conta pendente que vence em 3 dias. */
function seedDatabase(): DatabaseHandle {
  const handle = openMigratedDatabase(databasePath);
  const category = ensureLookup(handle.db, 'category', 'Moradia');
  createBill(handle.db, {
    description: 'Aluguel',
    amountCents: 1000,
    dueDate: '2026-03-13',
    categoryId: category.id,
    status: '',
  });
  handle.sqlite.close();
  return handle;
}

interface DepsBundle {
  deps: CliDependencies;
  out: string[];
  err: string[];
}

function makeDeps(options: {
  env?: NodeJS.ProcessEnv;
  createTransport?: (config: BillReminderConfig) => ReminderTransport;
} = {}): DepsBundle {
  const out: string[] = [];
  const err: string[] = [];
  const deps: CliDependencies = {
    env: {
      BILL_REMINDER_TO: RECIPIENT,
      BILL_REMINDER_TRANSPORT: 'smtp',
      BILL_REMINDER_SMTP_HOST: 'smtp.invalid',
      BILL_REMINDER_SMTP_PORT: '587',
      BILL_REMINDER_SMTP_USER: 'usuario-teste',
      BILL_REMINDER_SMTP_PASSWORD: 'senha-teste',
      ...(options.env ?? {}),
    },
    write: (text) => {
      out.push(text);
    },
    writeError: (text) => {
      err.push(text);
    },
    databasePath,
  };
  if (options.createTransport) deps.createTransport = options.createTransport;
  return { deps, out, err };
}

function readRows() {
  const handle = openMigratedDatabase(databasePath);
  try {
    return {
      notifications: handle.db.select().from(billReminderNotifications).all(),
      batches: handle.db.select().from(billReminderBatches).all(),
    };
  } finally {
    handle.sqlite.close();
  }
}

describe('CLI de lembretes — parsing dos argumentos', () => {
  it('deve aceitar --today no formato ISO', () => {
    expect(parseCliArgs(['--today=2026-03-10'])).toEqual({
      today: '2026-03-10',
      dryRun: false,
      help: false,
    });
  });

  it('deve aceitar --today no formato brasileiro', () => {
    expect(parseCliArgs(['--today=10/03/2026']).today).toBe('10/03/2026');
  });

  it('deve reconhecer --dry-run e --help', () => {
    expect(parseCliArgs(['--dry-run']).dryRun).toBe(true);
    expect(parseCliArgs(['--help']).help).toBe(true);
    expect(parseCliArgs(['-h']).help).toBe(true);
  });

  it('deve rejeitar argumento desconhecido com erro claro', () => {
    expect(() => parseCliArgs(['--agora'])).toThrow(/Argumento desconhecido: --agora/);
  });

  it('deve normalizar a data brasileira na execução', async () => {
    seedDatabase();
    const { deps, out } = makeDeps({ createTransport: () => new FakeTransport() });

    const code = await runCli(['--today=10/03/2026'], deps);

    expect(code).toBe(0);
    expect(out.join('')).toContain('Data de referência: 2026-03-10');
  });

  it('deve rejeitar data inválida com código de saída 1', async () => {
    seedDatabase();
    const { deps, err } = makeDeps({ createTransport: () => new FakeTransport() });

    const code = await runCli(['--today=32/13/2026'], deps);

    expect(code).toBe(1);
    expect(err.join('')).toContain('--today inválido');
  });
});

describe('CLI de lembretes — ajuda e erros', () => {
  it('deve mostrar a ajuda e sair com código 0', async () => {
    const { deps, out } = makeDeps();

    const code = await runCli(['--help'], deps);

    expect(code).toBe(0);
    const output = out.join('');
    expect(output).toContain('Uso: npm run reminders:run');
    expect(output).toContain('--dry-run');
  });

  it('deve sair com código 1 em argumento desconhecido', async () => {
    const { deps, err } = makeDeps();

    const code = await runCli(['--agora'], deps);

    expect(code).toBe(1);
    expect(err.join('')).toContain('Argumento desconhecido: --agora');
  });

  it('deve avisar quando o recurso está desabilitado', async () => {
    const { deps, out } = makeDeps({ env: { BILL_REMINDER_TO: '' } });

    const code = await runCli([], deps);

    expect(code).toBe(0);
    expect(out.join('')).toContain('desabilitados');
  });
});

describe('CLI de lembretes — simulação não consome o marco', () => {
  it('deve imprimir o e-mail sem gravar nada no banco', async () => {
    seedDatabase();
    const { deps, out } = makeDeps();

    const code = await runCli(['--today=2026-03-10', '--dry-run'], deps);

    expect(code).toBe(0);
    const output = out.join('');
    expect(output).toContain('Aluguel');
    expect(output).toContain('--- E-mail 1 (dry-run) ---');
    expect(output).toContain('Modo: simulação (nada foi gravado)');

    const { notifications, batches } = readRows();
    expect(notifications).toHaveLength(0);
    expect(batches).toHaveLength(0);
  });

  it('deve enviar o aviso no ciclo seguinte com transporte que entrega', async () => {
    seedDatabase();
    const dryRun = makeDeps();
    expect(await runCli(['--today=2026-03-10', '--dry-run'], dryRun.deps)).toBe(0);
    expect(readRows().notifications).toHaveLength(0);

    const transport = new FakeTransport();
    const real = makeDeps({ createTransport: () => transport });
    const code = await runCli(['--today=2026-03-10'], real.deps);

    expect(code).toBe(0);
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0].text).toContain('Aluguel');

    const { notifications, batches } = readRows();
    expect(notifications).toHaveLength(1);
    expect(notifications[0].state).toBe('sent');
    expect(batches).toHaveLength(1);
    expect(batches[0].state).toBe('sent');
  });

  it('deve permitir rodar a CLI junto com o backend (claim atômico no banco)', async () => {
    seedDatabase();
    const { deps, out } = makeDeps({ createTransport: () => new FakeTransport() });

    await runCli([], deps);

    // O aviso obsoleto saiu: a reserva do lote no banco impede o reenvio do
    // mesmo marco enquanto o outro processo está no envio.
    expect(out.join('')).not.toContain('não rode a CLI com o backend no ar');
  });
});

describe('CLI de lembretes — resultado do ciclo', () => {
  it('deve imprimir o resumo com as contagens', async () => {
    seedDatabase();
    const { deps, out } = makeDeps({ createTransport: () => new FakeTransport() });

    const code = await runCli(['--today=2026-03-10'], deps);

    expect(code).toBe(0);
    const output = out.join('');
    expect(output).toContain('Resumo dos lembretes');
    expect(output).toContain('Contas pendentes na janela: 1');
    expect(output).toContain('Notificações criadas: 1');
    expect(output).toContain('E-mails enviados: 1');
    expect(output).toContain('E-mails com falha: 0');
    expect(output).toContain('Avisos confirmados: 1');
  });

  it('deve sair com código 1 quando o envio falha', async () => {
    seedDatabase();
    const failing = new FakeTransport({ failAll: true });
    const { deps, out } = makeDeps({ createTransport: () => failing });

    const code = await runCli(['--today=2026-03-10'], deps);

    expect(code).toBe(1);
    expect(out.join('')).toContain('E-mails com falha: 1');
  });
});
