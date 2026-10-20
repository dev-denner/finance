import fs from 'node:fs';
import path from 'node:path';
import { createDatabase } from './client';

const databasePath =
  process.env.DATABASE_PATH ?? path.resolve(__dirname, '../../data/finance.db');
const backupDir = process.env.BACKUP_DIR ?? path.resolve(__dirname, '../../backups');

if (!fs.existsSync(databasePath)) {
  console.error(`Banco não encontrado em ${databasePath}. Inicie o app ou rode as migrações antes.`);
  process.exit(1);
}

fs.mkdirSync(backupDir, { recursive: true });

const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const target = path.join(backupDir, `finance-${timestamp}.db`);

const handle = createDatabase(databasePath);
try {
  // Gera um arquivo consistente mesmo com o app em execução (lê um snapshot).
  handle.sqlite.prepare('VACUUM INTO ?').run(target);
} finally {
  handle.sqlite.close();
}

console.log(`Backup criado em ${target}`);
