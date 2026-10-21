import { describe, expect, it } from 'vitest';
import { addMonthsIso } from '../src/lib/dates';
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
import { createTestDatabase, makeCsv } from './helpers';
import * as schema from '../src/db/schema';
import { ensureLookup } from '../src/services/lookups';
import { buildCategoryDecisions } from '../../client/src/lib/import-decisions';
import { buildApp } from '../src/app';

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

  it('não confunde nome de estabelecimento com compra à vista', () => {
    expect(isCashPurchaseText('Loja Vista')).toBe(false);
    expect(isCashPurchaseText('Ótica A Vista')).toBe(false);
    expect(isCashPurchaseText('Vista')).toBe(true);
    expect(isCashPurchaseText('compra a vista')).toBe(true);

    const db = createTestDatabase();
    const csv = makeCsv(
      ['10/01/2024;Loja Vista;Mercado;Parcela 5/12;R$ 100,00'],
      'Data compra;Lançamento;Categoria;parcela;Valor',
    );
    const preview = previewImport(db.db, csv, 't.csv');
    const values = preview.rows[0].values;
    expect(values.installmentNumber).toBe(5);
    expect(values.installmentTotal).toBe(12);
    expect(values.dueDate).toBe('2024-05-10');
    expect(values.dueDateSource).toBe('estimated_from_installment');
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
    const destino = ensureLookup(db.db, 'payment', 'Conta Destino');
    const mercado = ensureLookup(db.db, 'category', 'Mercado');
    ensureLookup(db.db, 'category', 'Supermercado');

    const csv = makeCsv(
      ['10/01/2026;10/01/2026;Compra;100,00;;Mercado'],
      'Data Compra;Vencimento;Compra;Valor;Pagamento;Categorias',
    );
    const preview = previewImport(db.db, csv, 't.csv');
    const summary = importWorkbook(db.db, csv, 't.csv', {
      mapping: preview.mapping,
      destinationPaymentMethodId: destino.id,
      categoryDecisions: {
        Mercado: {
          action: 'accept',
          sourceCategory: 'Mercado',
          targetCategoryId: mercado.id,
          confirmed: true,
        },
      },
    });
    expect(summary.importedRows).toBe(1);

    // Alias só é criado quando o alvo tem nome normalizado diferente da origem.
    const db2 = createTestDatabase();
    const destino2 = ensureLookup(db2.db, 'payment', 'Conta Destino');
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
        Mercado: {
          action: 'use',
          sourceCategory: 'Mercado',
          targetCategoryId: superm.id,
          confirmed: true,
        },
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
    const destino = ensureLookup(db.db, 'payment', 'Conta Destino');
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
        Mercado: {
          action: 'accept',
          sourceCategory: 'Mercado',
          targetCategoryId: superm.id,
          confirmed: true,
        },
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

describe('addendo4 - importação completa pela interface', () => {
  it('importa Data compra | Lançamento | Categoria | parcela | Valor com conta e revisão de categorias', () => {
    const db = createTestDatabase().db;
    const destino = ensureLookup(db, 'payment', 'Conta Destino');
    const construcao = ensureLookup(db, 'category', 'Construção');
    const pagamentoCartao = ensureLookup(db, 'category', 'Pagamento de cartão');

    const header = 'Data compra;Lançamento;Categoria;parcela;Valor';
    const csv = makeCsv(
      [
        '01/02/2024;Loja Exemplo A;CONSTRUCAO;Parcela 1/10;R$ 12,34',
        '02/02/2024;Fornecedor Exemplo;OUTROS;Compra à vista;-R$ 99,90',
        '03/02/2024;Pagamento Fatura;PAGAMENTO_RECEBIDO;Compra à vista;R$ 1.500,00',
        '10/01/2024;Loja Exemplo B;OUTROS;Parcela 5/10;-R$ 45,67',
      ],
      header,
    );

    const preview = previewImport(db, csv, 'fatura-exemplo.csv');
    expect(preview.mapping.paymentMethod ?? null).toBeNull();
    expect(preview.mapping.dueDate ?? null).toBeNull();
    expect(preview.rows.every((row) => row.errors.length === 0)).toBe(true);
    expect(preview.rows[0].values.dueDate).toBe('2024-02-01');
    expect(preview.rows[0].values.dueDateSource).toBe('estimated_from_installment');
    expect(preview.rows[1].values.dueDate).toBe('2024-02-02');
    expect(preview.rows[1].values.dueDateSource).toBe('derived_from_cash_purchase');
    expect(preview.rows[3].values.dueDate).toBe('2024-05-10');

    const decisions = buildCategoryDecisions(preview.categorySuggestions, {
      // Simula o usuário confirmando explicitamente a equivalência contextual.
      pagamento_recebido: {
        action: 'accept',
        sourceCategory: 'PAGAMENTO_RECEBIDO',
        targetCategoryId: pagamentoCartao.id,
      },
    });
    expect(decisions.pagamento_recebido.confirmed).toBe(true);
    expect(
      preview.categorySuggestions.find((group) => group.sourceNormalized === 'pagamento_recebido')
        ?.method,
    ).toBe('contextual');
    const summary = importWorkbook(db, csv, 'fatura-exemplo.csv', {
      mapping: preview.mapping,
      destinationPaymentMethodId: destino.id,
      categoryDecisions: decisions,
    });
    expect(summary.importedRows).toBe(4);

    const stored = db.select().from(schema.transactions).all();
    expect(stored).toHaveLength(4);
    expect(stored.every((row) => row.paymentMethodId === destino.id)).toBe(true);
    const byDescription = new Map(stored.map((row) => [row.description, row]));

    const pagamento = byDescription.get('Pagamento Fatura')!;
    expect(pagamento.amountCents).toBe(150000);
    expect(pagamento.categoryId).toBe(pagamentoCartao.id);
    expect(byDescription.get('Fornecedor Exemplo')!.amountCents).toBe(-9990);
    expect(byDescription.get('Fornecedor Exemplo')!.dueDateSource).toBe(
      'derived_from_cash_purchase',
    );
    expect(byDescription.get('Loja Exemplo B')!.dueDate).toBe('2024-05-10');
    expect(byDescription.get('Loja Exemplo B')!.amountCents).toBe(-4567);
    expect(byDescription.get('Loja Exemplo A')!.categoryId).toBe(construcao.id);

    const aliases = db
      .select()
      .from(schema.categoryImportAliases)
      .all()
      .map((alias) => alias.sourceNormalizedName);
    expect(aliases).toContain('pagamento_recebido');

    // Reimportação pelo mesmo caminho da tela: prévia com conta e decisões
    // marca duplicidades, e a importação recebe essas linhas em rejectedRows.
    const previewAgain = previewImport(
      db,
      csv,
      'fatura-exemplo.csv',
      preview.mapping,
      undefined,
      undefined,
      undefined,
      { destinationPaymentMethodId: destino.id, categoryDecisions: decisions },
    );
    expect(previewAgain.rows.every((row) => row.duplicate?.kind === 'exact')).toBe(true);
    const rejectedRows = previewAgain.rows
      .filter((row) => row.duplicate?.kind === 'exact')
      .map((row) => row.rowNumber);

    const second = importWorkbook(db, csv, 'fatura-exemplo.csv', {
      mapping: preview.mapping,
      destinationPaymentMethodId: destino.id,
      categoryDecisions: decisions,
      skipDuplicates: false,
      rejectedRows,
    });
    expect(second.importedRows).toBe(0);
    expect(second.explicitRejections).toBe(4);
    expect(db.select().from(schema.transactions).all()).toHaveLength(4);
  });

  it('não persiste alias para sugestão automática não confirmada', () => {
    const db = createTestDatabase().db;
    const destino = ensureLookup(db, 'payment', 'Conta Destino');
    const cartao = ensureLookup(db, 'category', 'Pagamento de cartão');
    const csv = makeCsv(
      ['03/02/2024;Pagamento Fatura;PAGAMENTO_RECEBIDO;Compra à vista;R$ 1.500,00'],
      'Data compra;Lançamento;Categoria;parcela;Valor',
    );
    const preview = previewImport(db, csv, 't.csv');
    const decisions = buildCategoryDecisions(preview.categorySuggestions, {});
    expect(decisions.pagamento_recebido.action).toBe('accept');
    expect(decisions.pagamento_recebido.confirmed).toBe(false);

    importWorkbook(db, csv, 't.csv', {
      mapping: preview.mapping,
      destinationPaymentMethodId: destino.id,
      categoryDecisions: decisions,
    });
    // A categoria sugerida foi aplicada no lote, mas sem aprendizado permanente.
    const stored = db.select().from(schema.transactions).all();
    expect(stored[0].categoryId).toBe(cartao.id);
    expect(db.select().from(schema.categoryImportAliases).all()).toHaveLength(0);
  });

  it('permite importar duplicata intencional quando a linha não é rejeitada', () => {
    const db = createTestDatabase().db;
    const destino = ensureLookup(db, 'payment', 'Conta Destino');
    const csv = makeCsv(
      ['05/03/2024;Mercado X;Mercado;Parcela 1/2;R$ 20,00'],
      'Data compra;Lançamento;Categoria;parcela;Valor',
    );
    const preview = previewImport(db, csv, 'd.csv');
    const decisions = buildCategoryDecisions(preview.categorySuggestions, {});
    const options = {
      mapping: preview.mapping,
      destinationPaymentMethodId: destino.id,
      categoryDecisions: decisions,
      skipDuplicates: false,
    } as const;

    importWorkbook(db, csv, 'd.csv', options);
    const again = previewImport(
      db,
      csv,
      'd.csv',
      preview.mapping,
      undefined,
      undefined,
      undefined,
      { destinationPaymentMethodId: destino.id, categoryDecisions: decisions },
    );
    expect(again.rows[0].duplicate?.kind).toBe('exact');

    // Usuário revisou a prévia e decidiu importar mesmo assim, sem rejeitar.
    const summary = importWorkbook(db, csv, 'd.csv', { ...options, rejectedRows: [] });
    expect(summary.importedRows).toBe(1);
    expect(summary.skippedDuplicates).toBe(0);
    expect(db.select().from(schema.transactions).all()).toHaveLength(2);
  });

  it('aplica a conta de destino somente às linhas sem conta do arquivo', () => {
    const db = createTestDatabase().db;
    const arquivo = ensureLookup(db, 'payment', 'Cartão do arquivo');
    const destino = ensureLookup(db, 'payment', 'Conta Destino');
    const csv = makeCsv(
      [
        '01/04/2024;Compra A;Mercado;Parcela 1/2;R$ 10,00;Cartão do arquivo',
        '02/04/2024;Compra B;Mercado;Parcela 1/2;R$ 20,00;',
      ],
      'Data compra;Lançamento;Categoria;parcela;Valor;Pagamento',
    );
    const preview = previewImport(
      db,
      csv,
      'p.csv',
      undefined,
      undefined,
      undefined,
      undefined,
      { destinationPaymentMethodId: destino.id },
    );
    expect(preview.rows[0].values.paymentMethod).toBe('Cartão do arquivo');
    // A linha sem conta continua sem conta na prévia; o destino é aplicado
    // somente na gravação e apenas a ela.
    expect(preview.rows[1].values.paymentMethod).toBeNull();

    // Sem destino, a importação é bloqueada pela linha sem conta.
    expect(() =>
      importWorkbook(db, csv, 'p.csv', {
        mapping: preview.mapping,
        categoryDecisions: buildCategoryDecisions(preview.categorySuggestions, {}),
      }),
    ).toThrow(/Informe a conta\/forma de pagamento de destino/);

    importWorkbook(db, csv, 'p.csv', {
      mapping: preview.mapping,
      destinationPaymentMethodId: destino.id,
      categoryDecisions: buildCategoryDecisions(preview.categorySuggestions, {}),
    });
    const stored = db.select().from(schema.transactions).all();
    const byDescription = new Map(stored.map((row) => [row.description, row]));
    expect(byDescription.get('Compra A')!.paymentMethodId).toBe(arquivo.id);
    expect(byDescription.get('Compra B')!.paymentMethodId).toBe(destino.id);
  });

  it('rejeita decisão de categoria com destino inexistente ou ausente', () => {
    const db = createTestDatabase().db;
    const destino = ensureLookup(db, 'payment', 'Conta Destino');
    ensureLookup(db, 'category', 'Mercado');
    const csv = makeCsv(
      ['01/05/2024;Compra;Mercado;Parcela 1/2;R$ 10,00'],
      'Data compra;Lançamento;Categoria;parcela;Valor',
    );
    const preview = previewImport(db, csv, 'i.csv');
    expect(() =>
      previewImport(db, csv, 'i.csv', preview.mapping, undefined, undefined, undefined, {
        destinationPaymentMethodId: destino.id,
        categoryDecisions: {
          Mercado: {
            action: 'accept',
            sourceCategory: 'Mercado',
            targetCategoryId: 999_999,
          },
        },
      }),
    ).toThrow(/Decisão de categoria inválida/);

    expect(() =>
      importWorkbook(db, csv, 'i.csv', {
        mapping: preview.mapping,
        destinationPaymentMethodId: destino.id,
        categoryDecisions: {
          Mercado: { action: 'accept', sourceCategory: 'Mercado', targetCategoryId: null },
        },
      }),
    ).toThrow(/Decisão de categoria inválida/);

    // Nada foi gravado nem criado silenciosamente.
    expect(db.select().from(schema.transactions).all()).toHaveLength(0);
    expect(db.select().from(schema.categoryImportAliases).all()).toHaveLength(0);
  });

  it('identifica vencimento fallback da compra quando não há parcela', () => {
    const db = createTestDatabase().db;
    const csv = makeCsv(
      ['07/06/2024;Compra sem parcela;Mercado;;R$ 10,00'],
      'Data compra;Lançamento;Categoria;parcela;Valor',
    );
    const preview = previewImport(db, csv, 'f.csv');
    expect(preview.rows[0].values.dueDate).toBe('2024-06-07');
    expect(preview.rows[0].values.dueDateSource).toBe('derived_from_purchase_fallback');
  });

  it('mantém paridade de duplicidade quando o arquivo já tem coluna de pagamento', () => {
    const db = createTestDatabase().db;
    ensureLookup(db, 'payment', 'Conta A');
    ensureLookup(db, 'category', 'Supermercado');

    const csv = makeCsv(
      ['01/02/2024;Supermerc;Supermerc;Parcela 1/3;Conta A;R$ 30,00'],
      'Data compra;Lançamento;Categoria;Parcela;Pagamento;Valor',
    );
    const preview = previewImport(db, csv, 'com-conta.csv');
    expect(preview.mapping.paymentMethod).not.toBeUndefined();
    const decisions = buildCategoryDecisions(preview.categorySuggestions, {});

    importWorkbook(db, csv, 'com-conta.csv', {
      mapping: preview.mapping,
      categoryDecisions: decisions,
    });
    expect(db.select().from(schema.transactions).all()).toHaveLength(1);

    // Sem conta de destino: a prévia usa apenas a conta do arquivo.
    const previewAgain = previewImport(
      db,
      csv,
      'com-conta.csv',
      preview.mapping,
      undefined,
      undefined,
      undefined,
      { destinationPaymentMethodId: null, categoryDecisions: decisions },
    );
    expect(previewAgain.rows.every((row) => row.duplicate?.kind === 'exact')).toBe(true);
  });

  it('nunca aceita automaticamente sugestão ambígua ou de baixa confiança', () => {
    const baseGroup = {
      sourceCategory: 'Origem',
      sourceNormalized: 'origem',
      count: 1,
      targetCategoryId: 7,
      targetCategoryName: 'Destino',
      reason: 'teste',
      method: 'text_similarity',
      alternatives: [],
    };

    const low = buildCategoryDecisions(
      [{ ...baseGroup, confidence: 'low', ambiguous: false }],
      {},
    );
    expect(low.origem.action).toBe('create');
    expect(low.origem.confirmed).toBe(false);

    const ambiguous = buildCategoryDecisions(
      [{ ...baseGroup, confidence: 'high', ambiguous: true }],
      {},
    );
    expect(ambiguous.origem.action).toBe('create');
    expect(ambiguous.origem.targetCategoryId).toBeUndefined();
    expect(ambiguous.origem.confirmed).toBe(false);
  });

  it('marca grupo ambíguo quando linhas da mesma origem têm sugestões diferentes', () => {
    const db = createTestDatabase().db;
    const destino = ensureLookup(db, 'payment', 'Conta Destino');
    const cartao = ensureLookup(db, 'category', 'Pagamento de cartão');
    ensureLookup(db, 'category', 'Pagamento de fornecedor');

    const csv = makeCsv(
      [
        '01/02/2024;Pagamento fatura cartão;Pagamento;Parcela 1/2;R$ 10,00',
        '02/02/2024;Pagamento fornecedor;Pagamento;Parcela 1/2;R$ 20,00',
      ],
      'Data compra;Lançamento;Categoria;parcela;Valor',
    );
    const preview = previewImport(db, csv, 't.csv');
    const group = preview.categorySuggestions.find(
      (item) => item.sourceNormalized === 'pagamento',
    )!;
    expect(group.count).toBe(2);
    expect(group.ambiguous).toBe(true);

    const decisions = buildCategoryDecisions(preview.categorySuggestions, {});
    expect(decisions.pagamento.action).toBe('create');
    expect(decisions.pagamento.confirmed).toBe(false);

    importWorkbook(db, csv, 't.csv', {
      mapping: preview.mapping,
      destinationPaymentMethodId: destino.id,
      categoryDecisions: decisions,
    });
    const pagamento = db
      .select()
      .from(schema.categories)
      .all()
      .find((category) => category.name === 'Pagamento')!;
    const stored = db.select().from(schema.transactions).all();
    expect(stored).toHaveLength(2);
    expect(stored.every((row) => row.categoryId === pagamento.id)).toBe(true);
    expect(stored.every((row) => row.categoryId !== cartao.id)).toBe(true);
    expect(db.select().from(schema.categoryImportAliases).all()).toHaveLength(0);
  });
});

describe('addendo4 - rotas de categoria', () => {
  function multipart(parts: { name: string; value: string; filename?: string }[]): {
    payload: string;
    headers: Record<string, string>;
  } {
    const boundary = 'addendo4boundary';
    const body = parts
      .map((part) => {
        const disposition = part.filename
          ? `form-data; name="${part.name}"; filename="${part.filename}"`
          : `form-data; name="${part.name}"`;
        const contentType = part.filename ? 'Content-Type: text/csv\r\n' : '';
        return `--${boundary}\r\nContent-Disposition: ${disposition}\r\n${contentType}\r\n${part.value}\r\n`;
      })
      .join('');
    return {
      payload: `${body}--${boundary}--\r\n`,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    };
  }

  it('retorna 400 para payload de categoria inválido', async () => {
    const handle = createTestDatabase();
    const app = await buildApp({ db: handle.db, logger: false });
    const csv = makeCsv(
      ['01/02/2024;Compra;Mercado;Parcela 1/2;R$ 10,00'],
      'Data compra;Lançamento;Categoria;parcela;Valor',
    ).toString('utf8');
    try {
      const invalidAction = multipart([
        { name: 'file', value: csv, filename: 'i.csv' },
        {
          name: 'categoryDecisions',
          value: JSON.stringify({ Mercado: { action: 'inventar', sourceCategory: 'Mercado' } }),
        },
      ]);
      const actionResponse = await app.inject({
        method: 'POST',
        url: '/api/imports/preview',
        payload: invalidAction.payload,
        headers: invalidAction.headers,
      });
      expect(actionResponse.statusCode).toBe(400);

      const missingTarget = multipart([
        { name: 'file', value: csv, filename: 'i.csv' },
        {
          name: 'categoryDecisions',
          value: JSON.stringify({
            Mercado: { action: 'accept', sourceCategory: 'Mercado', targetCategoryId: null },
          }),
        },
      ]);
      const missingResponse = await app.inject({
        method: 'POST',
        url: '/api/imports/preview',
        payload: missingTarget.payload,
        headers: missingTarget.headers,
      });
      expect(missingResponse.statusCode).toBe(400);

      const unknownTarget = multipart([
        { name: 'file', value: csv, filename: 'i.csv' },
        {
          name: 'categoryDecisions',
          value: JSON.stringify({
            Mercado: { action: 'accept', sourceCategory: 'Mercado', targetCategoryId: 999_999 },
          }),
        },
      ]);
      const unknownResponse = await app.inject({
        method: 'POST',
        url: '/api/imports/preview',
        payload: unknownTarget.payload,
        headers: unknownTarget.headers,
      });
      expect(unknownResponse.statusCode).toBe(400);

      expect(handle.db.select().from(schema.transactions).all()).toHaveLength(0);
    } finally {
      await app.close();
    }
  });
});
