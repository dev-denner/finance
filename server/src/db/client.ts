import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { normalizeName } from '../lib/normalize';
import * as schema from './schema';

export type AppDatabase = BetterSQLite3Database<typeof schema>;

export interface DatabaseHandle {
  db: AppDatabase;
  sqlite: Database.Database;
}

const migrationsFolder = path.resolve(__dirname, '../../drizzle');

export function createDatabase(filename: string): DatabaseHandle {
  if (filename !== ':memory:') {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
  }

  const sqlite = new Database(filename);
  // Busca textual sem diferenciar caixa/acentos, alinhada à normalização de nomes.
  sqlite.function('normalize_search', { deterministic: true }, (value: unknown) =>
    value === null || value === undefined ? null : normalizeName(String(value)),
  );
  sqlite.pragma('foreign_keys = ON');
  // CLI e backend podem abrir o mesmo arquivo ao mesmo tempo: espera até 5 s
  // por um write lock em vez de falhar com SQLITE_BUSY. (O better-sqlite3 já
  // usa 5 s por padrão; explícito para não depender do default do driver.)
  sqlite.pragma('busy_timeout = 5000');
  if (filename !== ':memory:') {
    sqlite.pragma('journal_mode = WAL');
    sqlite.pragma('synchronous = NORMAL');
  }

  const db = drizzle(sqlite, { schema });
  return { db, sqlite };
}

export function runMigrations(handle: DatabaseHandle): void {
  migrate(handle.db, { migrationsFolder });
}

export function openMigratedDatabase(filename: string): DatabaseHandle {
  const handle = createDatabase(filename);
  runMigrations(handle);
  return handle;
}
