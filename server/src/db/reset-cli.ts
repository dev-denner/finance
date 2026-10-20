import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { createDatabase } from './client';
import {
  ALL_RESET_TABLES,
  CONFIRMATION_PHRASE,
  DATA_RESET_TABLES,
  assertResetAllowed,
  collectCounts,
  runDatabaseReset,
  type DatabaseResetMode,
} from './reset';

const databasePath = path.resolve(
  process.env.DATABASE_PATH ?? path.resolve(__dirname, '../../data/finance.db'),
);
const backupDir = path.resolve(process.env.BACKUP_DIR ?? path.resolve(__dirname, '../../backups'));

async function main() {
  const modeArg = process.argv[2];
  if (modeArg !== 'data' && modeArg !== 'all') {
    console.error('Uso: npm run db:reset:data (movimentações) | npm run db:reset:all (completo)');
    process.exit(1);
  }
  const mode: DatabaseResetMode = modeArg;

  if (!fs.existsSync(databasePath)) {
    console.error(`Banco não encontrado em ${databasePath}.`);
    process.exit(1);
  }

  const allowProduction = process.env.DATABASE_RESET_ALLOW_PRODUCTION === 'true';
  assertResetAllowed(process.env.NODE_ENV, allowProduction);

  // Contagens pré-reset apenas para exibir o escopo exato da operação.
  const preview = createDatabase(databasePath);
  const scope = collectCounts(preview.sqlite, mode === 'all' ? ALL_RESET_TABLES : DATA_RESET_TABLES);
  const preserved = collectCounts(preview.sqlite, mode === 'data' ? ['categories', 'payment_methods'] : []);
  preview.sqlite.close();

  console.log('Procedimento de reset do banco SQLite do Finance (desenvolvimento).');
  console.log(`Banco: ${databasePath}`);
  console.log(
    mode === 'all'
      ? 'Modo: reset completo (movimentações + categorias + formas de pagamento).'
      : 'Modo: reset de movimentações (categorias e formas de pagamento preservados).',
  );
  console.log('Escopo que será APAGADO:');
  for (const { table, count } of scope) {
    console.log(`  - ${table}: ${count} registro(s)`);
  }
  if (preserved.length > 0) {
    console.log('Escopo que será PRESERVADO:');
    for (const { table, count } of preserved) {
      console.log(`  - ${table}: ${count} registro(s)`);
    }
  }
  console.log(`Backups serão gravados em: ${backupDir}`);
  console.log('Recomendado: mantenha o aplicativo parado durante o reset.');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (
      await rl.question(`Digite ${CONFIRMATION_PHRASE} para confirmar (qualquer outro valor cancela): `)
    ).trim();
    if (answer !== CONFIRMATION_PHRASE) {
      console.log('Cancelado. Nenhuma alteração foi feita.');
      return;
    }

    const summary = runDatabaseReset({
      databasePath,
      backupDir,
      mode,
      confirmation: answer,
      allowProduction,
      nodeEnv: process.env.NODE_ENV,
    });

    console.log('Reset concluído.');
    for (const { table, count } of summary.deleted) {
      console.log(`  - ${table}: ${count} registro(s) apagado(s)`);
    }
    console.log(`Backup pré-reset: ${summary.backupPath}`);
    console.log('Integridade verificada; migrações oficiais aplicadas.');
  } finally {
    rl.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
