import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { RESTORE_CONFIRMATION_PHRASE, restoreDatabaseBackup } from './reset';

const databasePath = path.resolve(
  process.env.DATABASE_PATH ?? path.resolve(__dirname, '../../data/finance.db'),
);
const backupDir = path.resolve(process.env.BACKUP_DIR ?? path.resolve(__dirname, '../../backups'));

function listBackups(): string[] {
  if (!fs.existsSync(backupDir)) {
    return [];
  }
  return fs
    .readdirSync(backupDir)
    .filter((name) => name.endsWith('.db'))
    .sort()
    .reverse()
    .map((name) => path.join(backupDir, name));
}

async function main() {
  console.log('Procedimento de restauração de backup do Finance.');
  console.log(`Banco atual: ${databasePath}`);
  console.log('Recomendado: mantenha o aplicativo parado durante a restauração.');

  const arg = process.argv[2];
  let backupPath: string | null = null;
  if (arg) {
    backupPath = path.isAbsolute(arg) ? arg : path.resolve(backupDir, arg);
  } else {
    const backups = listBackups();
    if (backups.length === 0) {
      console.error(`Nenhum backup encontrado em ${backupDir}.`);
      process.exit(1);
    }
    console.log('Backups disponíveis (mais recente primeiro):');
    backups.forEach((file, index) => console.log(`  ${index + 1}. ${path.basename(file)}`));

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question('Número do backup a restaurar (vazio cancela): ');
    rl.close();
    const index = Number(answer.trim());
    if (!answer.trim() || !Number.isInteger(index) || index < 1 || index > backups.length) {
      console.log('Cancelado. Nenhuma alteração foi feita.');
      return;
    }
    backupPath = backups[index - 1];
  }

  if (!backupPath || !fs.existsSync(backupPath)) {
    console.error(`Backup não encontrado em ${backupPath}.`);
    process.exit(1);
  }

  console.log(`Backup selecionado: ${backupPath}`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (
      await rl.question(
        `Digite ${RESTORE_CONFIRMATION_PHRASE} para substituir o banco atual (qualquer outro valor cancela): `,
      )
    ).trim();
    if (answer !== RESTORE_CONFIRMATION_PHRASE) {
      console.log('Cancelado. Nenhuma alteração foi feita.');
      return;
    }

    const summary = restoreDatabaseBackup({
      databasePath,
      backupPath,
      backupDir,
      confirmation: answer,
      allowProduction: process.env.DATABASE_RESET_ALLOW_PRODUCTION === 'true',
      nodeEnv: process.env.NODE_ENV,
    });

    console.log('Restauração concluída e integridade verificada.');
    console.log(`Banco restaurado a partir de: ${summary.backupPath}`);
    if (summary.previousBackupPath) {
      console.log(`Backup de segurança do estado anterior: ${summary.previousBackupPath}`);
    }
    if (summary.previousPath) {
      console.log(`Cópia bruta do banco substituído: ${summary.previousPath}`);
    }
  } finally {
    rl.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
