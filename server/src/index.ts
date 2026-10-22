import path from 'node:path';
import { buildApp } from './app';
import { openMigratedDatabase } from './db/client';
import { loadBillReminderConfig } from './services/bill-reminder-config';
import { createReminderScheduler, type ReminderScheduler } from './services/bill-reminder-scheduler';
import { createSmtpTransport } from './services/bill-reminder-smtp';
import type { ReminderTransport } from './services/bill-reminder-transport';

async function main() {
  const databasePath =
    process.env.DATABASE_PATH ?? path.resolve(__dirname, '../data/finance.db');
  const port = Number(process.env.PORT ?? 3001);
  const host = process.env.HOST ?? '127.0.0.1';

  const handle = openMigratedDatabase(databasePath);
  const staticDir = path.resolve(__dirname, '../../client/dist');
  const app = await buildApp({ db: handle.db, logger: true, staticDir });

  // O agendador de lembretes vive **aqui** (e só aqui): `buildApp` é usado
  // pelos testes e nunca deve registrar timer.
  let scheduler: ReminderScheduler | null = null;
  try {
    const config = loadBillReminderConfig();
    // O agendador só sobe com transporte que **entrega de verdade** (smtp).
    // Com `dry-run` os lembretes ficam em modo de pré-visualização: nenhum
    // agendador, nenhum consumo do aviso do dia (defesa em profundidade — o
    // núcleo também se recusa a gravar nesse modo).
    const transport: ReminderTransport | null =
      config.enabled && config.transport === 'smtp' ? createSmtpTransport(config) : null;
    if (config.enabled && config.transport !== 'smtp') {
      app.log.info(
        'Lembretes por e-mail em modo de pré-visualização (dry-run): nenhum aviso é enviado.',
      );
    }
    scheduler = createReminderScheduler({
      db: handle.db,
      transport,
      config,
      logger: app.log,
    });
    await scheduler.start();
  } catch (error) {
    app.log.error(
      { err: error },
      'Lembretes por e-mail desabilitados por erro de configuração.',
    );
    scheduler = null;
  }

  const shutdown = async () => {
    scheduler?.stop();
    await app.close();
    handle.sqlite.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await app.listen({ port, host });
  app.log.info(`Banco SQLite: ${databasePath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
