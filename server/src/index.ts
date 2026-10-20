import path from 'node:path';
import { buildApp } from './app';
import { openMigratedDatabase } from './db/client';

async function main() {
  const databasePath =
    process.env.DATABASE_PATH ?? path.resolve(__dirname, '../data/finance.db');
  const port = Number(process.env.PORT ?? 3001);
  const host = process.env.HOST ?? '127.0.0.1';

  const handle = openMigratedDatabase(databasePath);
  const staticDir = path.resolve(__dirname, '../../client/dist');
  const app = await buildApp({ db: handle.db, logger: true, staticDir });

  const shutdown = async () => {
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
