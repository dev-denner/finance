import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, runMigrations, type DatabaseHandle } from '../src/db/client';
import { listLookups, renameLookup, createLookup } from '../src/services/lookups';
import { createTestDatabase, seedTransaction } from './helpers';

describe('cores das categorias', () => {
  let handle: DatabaseHandle;

  beforeEach(() => {
    handle = createTestDatabase();
  });

  afterEach(() => {
    handle.sqlite.close();
  });

  it('persiste a cor informada em formato minúsculo #rrggbb', () => {
    const created = createLookup(handle.db, 'category', 'Alimentação', '#FF8800');
    expect(created.color).toBe('#ff8800');

    const listed = listLookups(handle.db, 'category').find((item) => item.id === created.id);
    expect(listed?.color).toBe('#ff8800');
  });

  it('permite criar categorias sem cor (automática)', () => {
    const created = createLookup(handle.db, 'category', 'Sem Cor');
    expect(created.color).toBeNull();

    const listed = listLookups(handle.db, 'category').find((item) => item.id === created.id);
    expect(listed?.color).toBeNull();
  });

  it('atualiza, preserva e limpa a cor ao renomear a categoria', () => {
    const created = createLookup(handle.db, 'category', 'Lazer', '#123456');

    const renamed = renameLookup(handle.db, 'category', created.id, 'Lazer e Hobby');
    expect(renamed.color).toBe('#123456');

    const recolored = renameLookup(handle.db, 'category', created.id, 'Lazer', '#ABCDEF');
    expect(recolored.color).toBe('#abcdef');

    const cleared = renameLookup(handle.db, 'category', created.id, 'Lazer', null);
    expect(cleared.color).toBeNull();
  });

  it('rejeita cor fora do padrão hexadecimal', () => {
    expect(() => createLookup(handle.db, 'category', 'Inválida', 'azul')).toThrow(/Cor inválida/i);
    expect(() => createLookup(handle.db, 'category', 'Inválida', '#12345')).toThrow(
      /Cor inválida/i,
    );
  });

  it('mantém formas de pagamento sem cor', () => {
    const created = createLookup(handle.db, 'payment', 'Cartão', '#FF0000');
    expect(created.color).toBeNull();
    const listed = listLookups(handle.db, 'payment').find((item) => item.id === created.id);
    expect(listed?.color).toBeNull();
  });
});

describe('integridade após migrações', () => {
  const filePath = path.join(
    os.tmpdir(),
    `finance-migracao-${Date.now()}-${Math.random().toString(16).slice(2)}.db`,
  );

  afterEach(() => {
    for (const suffix of ['', '-wal', '-shm']) {
      fs.rmSync(`${filePath}${suffix}`, { force: true });
    }
  });

  it('preserva dados e estrutura ao reaplicar as migrações', () => {
    const first = createDatabase(filePath);
    runMigrations(first);
    const category = createLookup(first.db, 'category', 'Viagem', '#00aa55');
    seedTransaction(first.db, {
      dueDate: '2026-02-01',
      amount: '-R$ 250,00',
      description: 'Passagem',
      category: 'Viagem',
      payment: 'Cartão',
    });
    const before = first.sqlite
      .prepare('select count(*) as total from transactions')
      .get() as { total: number };
    first.sqlite.close();

    // Reabrir e reaplicar: deve ser idempotente e manter tudo.
    const second = createDatabase(filePath);
    runMigrations(second);

    const after = second.sqlite
      .prepare('select count(*) as total from transactions')
      .get() as { total: number };
    expect(after.total).toBe(before.total);

    const columns = (
      second.sqlite.prepare('pragma table_info(categories)').all() as { name: string }[]
    ).map((column) => column.name);
    expect(columns).toContain('color');

    const restored = listLookups(second.db, 'category').find((item) => item.id === category.id);
    expect(restored?.color).toBe('#00aa55');

    const objects = (
      second.sqlite
        .prepare(
          "select name from sqlite_master where type in ('table','trigger','index') and name like 'transfers%'",
        )
        .all() as { name: string }[]
    ).map((row) => row.name);
    expect(objects).toContain('transfers');
    expect(objects).toContain('transfers_outgoing_transaction_uq');
    expect(objects).toContain('transfers_membership_unique_insert');
    expect(objects).toContain('transfers_pair_check_insert');

    second.sqlite.close();
  });
});
