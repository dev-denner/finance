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
import { persistCategoryAlias } from '../src/services/category-matching';
import { categoryImportAliases, purchaseItems, purchases } from '../src/db/schema';
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

  it('permite classificar explicitamente contas novas sem inferir pelo prefixo', () => {
    const handle = createTestDatabase();
    try {
      const account = createLookup(handle.db, 'payment', 'CC nova carteira', null, null, 'wallet');
      const renamed = renameLookup(handle.db, 'payment', account.id, 'Conta atualizada', null, null, 'debit');
      const imported = ensureLookup(handle.db, 'payment', 'CD conta via importação');
      expect(account.balanceType).toBe('wallet');
      expect(renamed.balanceType).toBe('debit');
      expect(imported.balanceType).toBe('unclassified');
    } finally { handle.sqlite.close(); }
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

    it('conta e reatribui categorias usadas em compras e itens', () => {
      const original = createLookup(handle.db, 'category', 'Mercado');
      const destination = createLookup(handle.db, 'category', 'Eletrônicos');
      const purchase = handle.db.insert(purchases).values({
        accessKey: '1'.repeat(44), supplierName: 'Loja de teste', supplierCnpj: '12345678000195',
        invoiceNumber: '10', series: '1', issuedAt: '2026-01-01T10:00:00Z', totalCents: 2000,
        invoiceDiscountCents: 0, paymentMethod: null, categoryId: original.id,
      }).returning({ id: purchases.id }).get();
      handle.db.insert(purchaseItems).values({
        purchaseId: purchase.id, position: 1, description: 'Item sintético', quantity: '1', unit: 'UN',
        unitPriceCents: 2000, discountCents: null, totalCents: 2000, categoryId: original.id,
      }).run();

      expect(listLookups(handle.db, 'category').find((entry) => entry.id === original.id)?.usageCount).toBe(2);
      expect(deleteLookup(handle.db, 'category', original.id, destination.id)).toEqual({ reassigned: 2 });
      expect(handle.db.select({ categoryId: purchases.categoryId }).from(purchases).get()?.categoryId).toBe(destination.id);
      expect(handle.db.select({ categoryId: purchaseItems.categoryId }).from(purchaseItems).get()?.categoryId).toBe(destination.id);
    });

    it('exclui categoria sem uso sem tentar reatribuir alias', () => {
      const semUso = createLookup(handle.db, 'category', 'Categoria Sem Uso');
      persistCategoryAlias(handle.db, 'Origem Sem Uso', semUso.id);
      expect(
        handle.db.select().from(categoryImportAliases).all(),
      ).toHaveLength(1);
      const result = deleteLookup(handle.db, 'category', semUso.id);
      expect(result.reassigned).toBe(0);
      expect(listLookups(handle.db, 'category').map((item) => item.name)).not.toContain(
        'Categoria Sem Uso',
      );
      // ON DELETE cascade remove o alias sem tentar gravar target indefinido.
      expect(handle.db.select().from(categoryImportAliases).all()).toHaveLength(0);
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

    it('reatribui o alias da categoria excluída para o novo destino', () => {
      const transaction = seedTransaction(handle.db, {
        dueDate: '2026-01-10',
        amount: '-R$ 100,00',
        category: 'Mercado',
        payment: 'Pix',
      });
      expect(transaction.id).toBeGreaterThan(0);
      const mercado = listLookups(handle.db, 'category').find((item) => item.name === 'Mercado')!;
      const casa = createLookup(handle.db, 'category', 'Casa');
      persistCategoryAlias(handle.db, 'Mercadinho', mercado.id);

      const result = deleteLookup(handle.db, 'category', mercado.id, casa.id);
      expect(result.reassigned).toBe(1);
      const aliases = handle.db.select().from(categoryImportAliases).all();
      expect(aliases).toHaveLength(1);
      expect(aliases[0].targetCategoryId).toBe(casa.id);
    });
  });
});
