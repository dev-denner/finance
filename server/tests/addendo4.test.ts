import { describe, expect, it } from 'vitest';
import { addMonthsIso, parseDateValue } from '../src/lib/dates';
import type { DueDateSource } from '../src/lib/dates';
import {
  deriveDueDateFromPurchase,
  isCashPurchaseText,
  parseInstallments,
} from '../src/lib/installments';
import { transactionFingerprint } from '../src/services/import';
import { suggestCategory, persistCategoryAlias } from '../src/services/category-matching';
import {
  importWorkbook,
  previewImport,
  REQUIRED_FIELDS,
} from '../src/services/import';
import { createTestDatabase, makeCsv, csvBuffer } from './helpers';
import * as schema from '../src/db/schema';
import { ensureLookup } from '../src/services/lookups';

describe('addendo4 - datas', () => {
  it('addMonthsIso adiciona meses com clamp de fim de mês e ano bissexto', () => {
    expect(addMonthsIso('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonthsIso('2024-01-31', 1)).toBe('2024-02-29');
    expect(addMonthsIso('2026-03-15', 2)).toBe('2026-05-15');
    expect(addMonthsIso('data invalida', 1)).toBeNull();
  });

  it('deriveDueDateFromPurchase deriva vencimento da compra', () => {
    expect(deriveDueDateFromPurchase('2026-01-10', 1)).toBe('2026-01-10');
    expect(deriveDueDateFromPurchase('2026-01-10', 3)).toBe('2026-03-10');
    expect(deriveDueDateFromPurchase('2026-01-31', 2)).toBe('2026-02-28');
  });
});

describe('addendo4 - parcelas', () => {
  it('reconhece formatos de parcela e compra à vista', () => {
    const cases: Array<[string, number | null, number | null, boolean]> = [
      ['Parcela 1/10', 1, 10, false],
      ['Parcela 5/12', 5, 12, false],
      ['Parcela 01/06', 1, 6, false],
      ['1/10', 1, 10, false],
      ['01/10', 1, 10, false],
      ['Parcela 3 de 12', 3, 12, false],
    ];
    for (const [text, n, t, cash] of cases) {
      const result = parseInstallments(text, { description: text });
      expect(result.value.number).toBe(n);
      expect(result.value.total).toBe(t);
      expect(result.cashPurchase).toBe(cash);
    }
    const cash = parseInstallments('Compra à vista', { description: 'Compra à vista' });
    expect(cash.value.number).toBeNull();
    expect(cash.value.total).toBeNull();
    expect(cash.cashPurchase).toBe(true);
    expect(isCashPurchaseText('Compra à vista')).toBe(true);
  });

  it('não trata serial do Excel como parcela', () => {
    const result = parseInstallments(46023);
    expect(result.value.number).toBeNull();
    expect(result.value.total).toBeNull();
  });
});

describe('addendo4 - category matching', () => {
  it('sugere por correspondência exata/normalizada/alias/similaridade/contexto', () => {
    const db = createTestDatabase().db;
    const mercado = ensureLookup(db, 'category', 'Mercado');
    ensureLookup(db, 'category', 'Supermercado');
    ensureLookup(db, 'category', 'Pagamento de cartão');

    const exact = suggestCategory(db, 'Mercado', 'Compra', 100);
    expect(exact.targetCategoryId).toBe(mercado.id);
    expect(exact.confidence).toBe('high');

    const normalized = suggestCategory(db, 'mercado', 'Compra', 100);
    expect(normalized.targetCategoryId).toBe(mercado.id);

    persistCategoryAlias(db, 'MercadoX', mercado.id);
    const alias = suggestCategory(db, 'MercadoX', 'Compra', 100);
    expect(alias.method).toBe('alias');
    expect(alias.targetCategoryId).toBe(mercado.id);

    const similar = suggestCategory(db, 'Supermerc', 'Compra', 100);
    expect(similar.targetCategoryId).not.toBeNull();

    const contextual = suggestCategory(db, 'Pagamento', 'pagamento de fatura cartão', 100);
    expect(contextual.method).toBe('contextual');
  });
});

describe('addendo4 - import', () => {
  it('REQUIRED_FIELDS não exige dueDate/paymentMethod', () => {
    expect(REQUIRED_FIELDS).toEqual(['description', 'amount']);
  });

  it('deriva vencimento da compra e define dueDateSource', () => {
    const csv = makeCsv(
      ['10/01/2026;Compra;100,00;Cartão;1/3;Mercado'],
      'Data Compra;Compra;Valor;Pagamento;Parcelas;Categorias',
    );
    const db = createTestDatabase();
    const preview = previewImport(db.db, csv, 't.csv');
    const row = preview.rows[0];
    expect(row.values.dueDate).toBe('2026-01-10');
    expect(row.values.dueDateSource).toBe('estimated_from_installment');
    expect(row.values.estimatedFirstInstallmentDate).toBe('2026-01-10');
    expect(row.values.cashPurchase).toBe(false);
  });

  it('compra à vista define cashPurchase e estimated null', () => {
    const csv = makeCsv(
      ['10/01/2026;Compra à vista;100,00;Cartão;Mercado'],
      'Data Compra;Compra;Valor;Pagamento;Categorias',
    );
    const db = createTestDatabase();
    const preview = previewImport(db.db, csv, 't.csv');
    const row = preview.rows[0];
    expect(row.values.cashPurchase).toBe(true);
    expect(row.values.estimatedFirstInstallmentDate).toBeNull();
  });

  it('importWorkbook exige destino quando paymentMethod nulo', () => {
    const csv = makeCsv(
      ['10/01/2026;10/01/2026;Compra;100,00;;Mercado'],
      'Data Compra;Vencimento;Compra;Valor;Pagamento;Categorias',
    );
    const db = createTestDatabase();
    const buffer = csv;
    expect(() =>
      importWorkbook(db.db, buffer, 't.csv', {
        mapping: {
          purchaseDate: 0,
          dueDate: 1,
          description: 2,
          amount: 3,
          paymentMethod: 4,
          category: 5,
        },
      }),
    ).toThrow();
  });

  it('importWorkbook usa destino e persiste alias em accept', () => {
    const db = createTestDatabase();
    ensureLookup(db.db, 'payment', 'Conta Destino');
    const destino = db.db.select().from(schema.paymentMethods).all().find((p: any) => p.name === 'Conta Destino')!;
    const mercado = ensureLookup(db.db, 'category', 'Mercado');
    ensureLookup(db.db, 'category', 'Supermercado');

    const csv = makeCsv(
      ['10/01/2026;10/01/2026;Compra;100,00;;Mercado'],
      'Data Compra;Vencimento;Compra;Valor;Pagamento;Categorias',
    );
    const preview = previewImport(db.db, csv, 't.csv');
    const suggestion = preview.rows[0].categorySuggestion;
    const summary = importWorkbook(db.db, csv, 't.csv', {
      mapping: preview.mapping,
      destinationPaymentMethodId: destino.id,
      categoryDecisions: {
        Mercado: { action: 'accept', sourceCategory: 'Mercado', targetCategoryId: mercado.id },
      },
    });
    expect(summary.importedRows).toBe(1);

    // alias persisted? target same as source normalized -> no alias because distinct false; test distinct target
    const db2 = createTestDatabase();
    ensureLookup(db2.db, 'payment', 'Conta Destino');
    const destino2 = db2.db.select().from(schema.paymentMethods).all().find((p: any) => p.name === 'Conta Destino')!;
    ensureLookup(db2.db, 'category', 'Mercado');
    const superm = ensureLookup(db2.db, 'category', 'Supermercado');
    const csv2 = makeCsv(
      ['10/01/2026;10/01/2026;Compra;100,00;;Mercado'],
      'Data Compra;Vencimento;Compra;Valor;Pagamento;Categorias',
    );
    importWorkbook(db2.db, csv2, 't.csv', {
      mapping: preview.mapping,
      destinationPaymentMethodId: destino2.id,
      categoryDecisions: {
        Mercado: { action: 'use', sourceCategory: 'Mercado', targetCategoryId: superm.id },
      },
    });
    const aliasRow = db2.db.select().from(schema.categoryImportAliases).all();
    expect(aliasRow.length).toBe(1);
  });

  it('transactionFingerprint usa string vazia para paymentMethod nulo', () => {
    const fp = transactionFingerprint({
      purchaseDate: '2026-01-01',
      dueDate: '2026-01-01',
      description: 'Compra',
      amountCents: 10000,
      paymentMethod: '',
      category: 'Mercado',
      installmentNumber: null,
      installmentTotal: null,
      transfer: null,
    });
    expect(typeof fp).toBe('string');
  });
});

describe('addendo4 - preview categorySuggestions', () => {
  it('agrupa por categoria de origem com count', () => {
    const db = createTestDatabase();
    const csv = makeCsv(
      [
        '10/01/2026;10/01/2026;Compra A;100,00;Pix;Mercado',
        '11/01/2026;11/01/2026;Compra B;50,00;Pix;Mercado',
      ],
      'Data Compra;Vencimento;Compra;Valor;Pagamento;Categorias',
    );
    const preview = previewImport(db.db, csv, 't.csv');
    expect(preview.categorySuggestions.length).toBeGreaterThan(0);
    expect(preview.categorySuggestions[0].count).toBe(2);
  });
});

describe('addendo4 - datas (bordas)', () => {
  it('addMonthsIso lida com meses negativos, clamp e entradas inválidas', () => {
    expect(addMonthsIso('2026-03-15', -2)).toBe('2026-01-15');
    expect(addMonthsIso('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonthsIso('2026-03-31', 1)).toBe('2026-04-30');
    expect(addMonthsIso('data invalida', 1)).toBeNull();
    expect(addMonthsIso('2026-01-01', 1.5)).toBeNull();
    expect(addMonthsIso('2026-01-01', Number.NaN)).toBeNull();
  });

  it('deriveDueDateFromPurchase valida entrada e deriva vencimento', () => {
    expect(deriveDueDateFromPurchase('2026-01-10', 1)).toBe('2026-01-10');
    expect(deriveDueDateFromPurchase('2026-01-10', 3)).toBe('2026-03-10');
    expect(deriveDueDateFromPurchase('2026-01-31', 2)).toBe('2026-02-28');
    expect(deriveDueDateFromPurchase('2026-01-10', null)).toBeNull();
    expect(deriveDueDateFromPurchase('2026-01-10', 0)).toBeNull();
    expect(deriveDueDateFromPurchase('data invalida', 2)).toBeNull();
  });
});

describe('addendo4 - compra à vista', () => {
  it('isCashPurchaseText reconhece variações e rejeita demais', () => {
    expect(isCashPurchaseText('Compra à vista')).toBe(true);
    expect(isCashPurchaseText('compra avista')).toBe(true);
    expect(isCashPurchaseText('VISTA')).toBe(true);
    expect(isCashPurchaseText('Mercado')).toBe(false);
    expect(isCashPurchaseText('')).toBe(false);
    expect(isCashPurchaseText(null)).toBe(false);
  });

  it('parseInstallments propaga cashPurchase a partir da coluna ou descrição', () => {
    const fromColumn = parseInstallments('Compra à vista', { description: 'Mercado' });
    expect(fromColumn.cashPurchase).toBe(true);
    expect(fromColumn.value).toEqual({ number: null, total: null });

    const fromDescription = parseInstallments('', { description: 'Compra à vista' });
    expect(fromDescription.cashPurchase).toBe(true);

    const normal = parseInstallments('1/3', { description: 'Mercado' });
    expect(normal.cashPurchase).toBe(false);
  });
});

describe('addendo4 - category matching (bordas)', () => {
  it('persistCategoryAlias não cria alias para origem vazia', () => {
    const db = createTestDatabase().db;
    const mercado = ensureLookup(db, 'category', 'Mercado');
    persistCategoryAlias(db, '', mercado.id);
    expect(db.select().from(schema.categoryImportAliases).all()).toHaveLength(0);
  });

  it('persistCategoryAlias atualiza alias existente', () => {
    const db = createTestDatabase().db;
    const mercado = ensureLookup(db, 'category', 'Mercado');
    const superm = ensureLookup(db, 'category', 'Supermercado');
    persistCategoryAlias(db, 'MercadoX', mercado.id);
    persistCategoryAlias(db, 'MercadoX', superm.id);
    const rows = db.select().from(schema.categoryImportAliases).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].targetCategoryId).toBe(superm.id);
  });

  it('suggestCategory retorna none sem correspondência confiável', () => {
    const db = createTestDatabase().db;
    const result = suggestCategory(db, 'CategoriaInexistenteXYZ', 'Compra', 100);
    expect(result.method).toBe('none');
    expect(result.targetCategoryId).toBeNull();
    expect(result.confidence).toBe('low');
  });

  it('suggestCategory usa similaridade textual e fornece alternativas', () => {
    const db = createTestDatabase().db;
    ensureLookup(db, 'category', 'Supermercado');
    const result = suggestCategory(db, 'Supermerc', 'Compra', 100);
    expect(result.method).toBe('text_similarity');
    expect(result.targetCategoryId).not.toBeNull();
    expect(result.alternatives.length).toBeGreaterThan(0);
  });

  it('suggestCategory não usa contexto quando descrição não indica pagamento', () => {
    const db = createTestDatabase().db;
    ensureLookup(db, 'category', 'Pagamento de cartão');
    const result = suggestCategory(db, 'Pagamento', 'compra de mercado', 100);
    expect(result.method).not.toBe('contextual');
  });
});

describe('addendo4 - import (bordas)', () => {
  it('compra à vista define dueDateSource derived_from_cash_purchase', () => {
    const csv = makeCsv(
      ['10/01/2026;Compra à vista;100,00;Cartão;Mercado'],
      'Data Compra;Compra;Valor;Pagamento;Categorias',
    );
    const db = createTestDatabase();
    const preview = previewImport(db.db, csv, 't.csv');
    const row = preview.rows[0];
    expect(row.values.cashPurchase).toBe(true);
    expect(row.values.dueDate).toBe('2026-01-10');
    expect(row.values.dueDateSource).toBe('derived_from_cash_purchase');
    expect(row.values.estimatedFirstInstallmentDate).toBeNull();
  });

  it('vencimento do arquivo define dueDateSource file e estimativa', () => {
    const csv = makeCsv(
      ['10/01/2026;20/02/2026;Compra;100,00;Cartão;2/5;Mercado'],
      'Data Compra;Vencimento;Compra;Valor;Pagamento;Parcelas;Categorias',
    );
    const db = createTestDatabase();
    const preview = previewImport(db.db, csv, 't.csv');
    const row = preview.rows[0];
    expect(row.values.dueDate).toBe('2026-02-20');
    expect(row.values.dueDateSource).toBe('file');
    expect(row.values.estimatedFirstInstallmentDate).toBe('2026-01-20');
  });

  it('importWorkbook rejeita destino inexistente', () => {
    const csv = makeCsv(
      ['10/01/2026;10/01/2026;Compra;100,00;;Mercado'],
      'Data Compra;Vencimento;Compra;Valor;Pagamento;Categorias',
    );
    const db = createTestDatabase();
    const preview = previewImport(db.db, csv, 't.csv');
    expect(() =>
      importWorkbook(db.db, csv, 't.csv', {
        mapping: preview.mapping,
        destinationPaymentMethodId: 999999,
      }),
    ).toThrow();
  });

  it('importWorkbook persiste alias na ação accept com alvo distinto', () => {
    const db = createTestDatabase();
    ensureLookup(db.db, 'payment', 'Conta Destino');
    const destino = db.db.select().from(schema.paymentMethods).all().find((p: any) => p.name === 'Conta Destino')!;
    ensureLookup(db.db, 'category', 'Mercado');
    const superm = ensureLookup(db.db, 'category', 'Supermercado');

    const csv = makeCsv(
      ['10/01/2026;10/01/2026;Compra;100,00;;Mercado'],
      'Data Compra;Vencimento;Compra;Valor;Pagamento;Categorias',
    );
    const preview = previewImport(db.db, csv, 't.csv');
    importWorkbook(db.db, csv, 't.csv', {
      mapping: preview.mapping,
      destinationPaymentMethodId: destino.id,
      categoryDecisions: {
        Mercado: { action: 'accept', sourceCategory: 'Mercado', targetCategoryId: superm.id },
      },
    });
    const aliasRow = db.db.select().from(schema.categoryImportAliases).all();
    expect(aliasRow.length).toBe(1);
  });

  it('importWorkbook aplica decisão create de categoria', () => {
    const db = createTestDatabase();
    ensureLookup(db.db, 'payment', 'Conta Destino');
    const destino = db.db.select().from(schema.paymentMethods).all().find((p: any) => p.name === 'Conta Destino')!;

    const csv = makeCsv(
      ['10/01/2026;10/01/2026;Compra;100,00;;Mercado'],
      'Data Compra;Vencimento;Compra;Valor;Pagamento;Categorias',
    );
    const preview = previewImport(db.db, csv, 't.csv');
    const summary = importWorkbook(db.db, csv, 't.csv', {
      mapping: preview.mapping,
      destinationPaymentMethodId: destino.id,
      categoryDecisions: {
        Mercado: { action: 'create', sourceCategory: 'Mercado', newCategoryName: 'Mercado Novo' },
      },
    });
    expect(summary.importedRows).toBe(1);
    const created = db.db.select().from(schema.categories).all().find((c: any) => c.name === 'Mercado Novo');
    expect(created).toBeDefined();
  });

  it('transactionFingerprint é determinístico e usa vazio para pagamento nulo', () => {
    const fp = transactionFingerprint({
      purchaseDate: '2026-01-01',
      dueDate: '2026-01-01',
      description: 'Compra',
      amountCents: 10000,
      paymentMethod: '',
      category: 'Mercado',
      installmentNumber: null,
      installmentTotal: null,
      transfer: null,
    });
    expect(fp).toBe('2026-01-01|2026-01-01|compra|10000||mercado|||');
  });
});

describe('addendo4 - preview categorySuggestions', () => {
  it('expõe método e confiança nas sugestões agrupadas', () => {
    const db = createTestDatabase();
    ensureLookup(db.db, 'category', 'Mercado');
    const csv = makeCsv(
      ['10/01/2026;10/01/2026;Compra;100,00;Pix;Mercado'],
      'Data Compra;Vencimento;Compra;Valor;Pagamento;Categorias',
    );
    const preview = previewImport(db.db, csv, 't.csv');
    expect(preview.categorySuggestions[0].method).toBe('exact');
    expect(preview.categorySuggestions[0].confidence).toBe('high');
  });
});