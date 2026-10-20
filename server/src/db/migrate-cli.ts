import path from 'node:path';
import { openMigratedDatabase } from './client';

const databasePath =
  process.env.DATABASE_PATH ?? path.resolve(__dirname, '../../data/finance.db');
const handle = openMigratedDatabase(databasePath);
console.log(`Migrações aplicadas em ${databasePath}`);
handle.sqlite.close();
