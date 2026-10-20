import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseHandle } from '../src/db/client';
import { normalizeName } from '../src/lib/normalize';
import {
  createLookup,
  deleteLookup,
  ensureLookup,
  listLookups,
  renameLookup,
} from '../src/services/lookups';
import { seedTransaction } from './helpers';
import { createTestDatabase } from './helpers';

describe('normalização e cadastros auxiliares', () => {
  it('ignora caixa, acentos e espaços redundantes', () => {
    expect(normalizeName('  Cartão   de CRÉDITO ')).toBe('cartao de credito');
    expect(normalizeName('SAÚDE')).toBe('saude');
    expect(normalizeName('Não   informado')).toBe('nao informado');
  });

  it('preserva o nome original de exibição ao encontrar registros equivalentes', () => {
    const handle = createTestDatabase();
    const first = ensureLookup(handle.db, 'category', '  Alimentação  Saudável ');
    const second = ensureLookup(handle.db, 'category', 'alimentacao saudavel');

    expect(first.id).toBe(second.id);
    expect(second.name).toBe('Alimentação Saudável');
    handle.sqlite.close();
  });

  it('impede duplicidade normalizada na criação e renomeação', () => {
    const handle = createTestDatabase();
    createLookup(handle.db, 'category', 'Mercado');
    expect(() => createLookup(handle.db, 'category', '  MÉRCADO ')).toThrow(/já existe/i);

    const health = createLookup(handle.db, 'category', 'Saúde');
    expect(() => renameLookup(handle.db, 'category', health.id, 'mercado')).toThrow(/já existe/i);
    handle.sqlite.close();
  });

  describe('integridade dos relacionamentos', () => {
    let handle: DatabaseHandle;

    beforeEach(() => {
      handle = createTestDatabase();
    });

    afterEach(() => {
      handle.sqlite.close();
    });

    it('conta o uso e bloqueia exclusão de registro em uso', () => {
      seedTransaction(handle.db, {
        dueDate: '2026-01-10',
        amount: '-R$ 100,00',
        category: 'Mercado',
        payment: 'Pix',
      });

      const category = listLookups(handle.db, 'category').find(
        (item) => item.name === 'Mercado',
      );
      expect(category?.usageCount).toBe(1);
      expect(() => deleteLookup(handle.db, 'category', category!.id)).toThrow(/em uso/i);
    });

    it('reatribui os lançamentos antes de excluir', () => {
      const transaction = seedTransaction(handle.db, {
        dueDate: '2026-01-10',
        amount: '-R$ 100,00',
        category: 'Mercado',
        payment: 'Pix',
      });
      const mercado = listLookups(handle.db, 'category').find((item) => item.name === 'Mercado')!;
      const casa = createLookup(handle.db, 'category', 'Casa');

      const result = deleteLookup(handle.db, 'category', mercado.id, casa.id);
      expect(result.reassigned).toBe(1);

      const updated = handle.sqlite
        .prepare('select category_id from transactions where id = ?')
        .get(transaction.id) as { category_id: number };
      expect(updated.category_id).toBe(casa.id);
      expect(listLookups(handle.db, 'category').map((item) => item.name)).toEqual(['Casa']);
    });
  });
});
