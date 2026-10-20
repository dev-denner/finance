import { describe, expect, it } from 'vitest';
import { estimateFirstInstallmentDate } from '../src/lib/installments';
import { buildApp } from '../src/app';
import {
  deleteMappingTemplate,
  importWorkbook,
  listImportBatches,
  listMappingTemplates,
  previewImport,
  saveMappingTemplate,
  suggestMapping,
  suggestMappingDetailed,
} from '../src/services/import';
import type { ImportOptions } from '../src/services/import';
import { getTransaction } from '../src/services/transactions';
import { createTestDatabase, makeCsv } from './helpers';

const EXAMPLE_ROW_NAMES = [
  'Uolcursos',
  'Casas Bahia - NuPay',
  'Joripratas',
  'Constance',
] as const;

function exampleCsv(): Buffer {
  return makeCsv(
    [
      '24/11/2025;CC Nubank Jessica;Uolcursos;3/12;-362,49;Educação',
      '24/11/2025;CC Nubank Jessica;Casas Bahia - NuPay;4/10;-139,89;Compras',
      '24/11/2025;CC Nubank Jessica;Joripratas;2/5;-127,20;Compras',
      '24/11/2025;CC Nubank Jessica;Constance;6/6;-121,66;Vestuário',
    ],
    'data;cartao;descricao;parcela;valor;categoria',
  );
}

function exampleRowByName(name: string) {
  const buffer = exampleCsv();
  const db = createTestDatabase();
  const preview = previewImport(db.db, buffer, 'exemplo.csv');
  const row = preview.rows.find((item) => item.values.description === name);
  if (!row) throw new Error(`Linha ${name} ausente na prévia.`);
  return { preview, row, handle: db };
}

describe('estimativa da data da primeira parcela', () => {
  it('calcula 3/12, 4/10, 2/5 e 6/6 a partir de 24/11/2025', () => {
    const due = '2025-11-24';
    expect(estimateFirstInstallmentDate(due, 3, 12)).toBe('2025-09-24');
    expect(estimateFirstInstallmentDate(due, 4, 10)).toBe('2025-08-24');
    expect(estimateFirstInstallmentDate(due, 2, 5)).toBe('2025-10-24');
    expect(estimateFirstInstallmentDate(due, 6, 6)).toBe('2025-06-24');
  });

  it('atravessa mudanças de ano', () => {
    expect(estimateFirstInstallmentDate('2026-03-10', 5, 8)).toBe('2025-11-10');
    expect(estimateFirstInstallmentDate('2026-01-15', 3, 12)).toBe('2025-11-15');
  });

  it('usa aritmética de calendário em datas de fim de mês', () => {
    expect(estimateFirstInstallmentDate('2026-03-31', 2, 6)).toBe('2026-02-28');
    expect(estimateFirstInstallmentDate('2025-03-31', 2, 6)).toBe('2025-02-28');
    expect(estimateFirstInstallmentDate('2025-08-31', 3, 12)).toBe('2025-06-30');
  });

  it('respeita anos bissextos', () => {
    expect(estimateFirstInstallmentDate('2024-03-31', 2, 6)).toBe('2024-02-29');
    expect(estimateFirstInstallmentDate('2024-02-29', 13, 24)).toBe('2023-02-28');
  });

  it('não calcula sem parcela válida', () => {
    expect(estimateFirstInstallmentDate('2025-11-24', null, null)).toBeNull();
    expect(estimateFirstInstallmentDate(null, 3, 12)).toBeNull();
    expect(estimateFirstInstallmentDate('sem data', 3, 12)).toBeNull();
  });

  it('não calcula em pares inválidos', () => {
    expect(estimateFirstInstallmentDate('2025-11-24', 0, 12)).toBeNull();
    expect(estimateFirstInstallmentDate('2025-11-24', 7, 6)).toBeNull();
  });
});

describe('mapeamento flexível de colunas', () => {
  it('reconhece o arquivo de exemplo com colunas em outra ordem', () => {
    const preview = previewImport(createTestDatabase().db, exampleCsv(), 'exemplo.csv');
    expect(preview.mappingErrors).toEqual([]);
    expect(preview.mapping).toEqual({
      purchaseDate: null,
      dueDate: 0,
      description: 2,
      amount: 4,
      paymentMethod: 1,
      installments: 3,
      category: 5,
      transfer: null,
    });
    expect(preview.totalRows).toBe(4);
    expect(preview.validRows).toBe(4);
  });

  it('reconhece cabeçalhos com acentos, caixa e variações de nome', () => {
    const buffer = makeCsv(
      ['20/09/2025;24/11/2025;Uolcursos;-362,49;CC Nubank;3/12;Educação'],
      'Data Compra;VENCIMENTO;Descrição;Valor;Cartão;Prestação;Categorias',
    );
    const preview = previewImport(createTestDatabase().db, buffer, 'variado.csv');
    expect(preview.mappingErrors).toEqual([]);
    expect(suggestMapping(preview.headers)).toEqual({
      purchaseDate: 0,
      dueDate: 1,
      description: 2,
      amount: 3,
      paymentMethod: 4,
      installments: 5,
      category: 6,
      transfer: null,
    });
  });

  it('assume coluna genérica "data" como vencimento e avisa', () => {
    const suggestion = suggestMappingDetailed(['data', 'cartao', 'valor']);
    expect(suggestion.mapping.dueDate).toBe(0);
    expect(suggestion.mapping.purchaseDate).toBeNull();
    expect(
      suggestion.warnings.some(
        (warning) => warning.level === 'info' && warning.message.includes('Vencimento'),
      ),
    ).toBe(true);
  });

  it('interpreta "data" como compra quando o vencimento já tem coluna', () => {
    const suggestion = suggestMappingDetailed(['data', 'vencimento', 'valor']);
    expect(suggestion.mapping.dueDate).toBe(1);
    expect(suggestion.mapping.purchaseDate).toBe(0);
  });

  it('confirma preset de ambas as datas explicitas preservado', () => {
    const suggestion = suggestMappingDetailed(['data compra', 'vencimento', 'valor']);
    expect(suggestion.mapping.purchaseDate).toBe(0);
    expect(suggestion.mapping.dueDate).toBe(1);
  });

  it('marca correspondências por semelhança e colunas sem campo', () => {
    const suggestion = suggestMappingDetailed(['Data da Compra Original', 'valor pago', 'obs']);
    expect(suggestion.mapping.purchaseDate).toBe(0);
    expect(suggestion.mapping.amount).toBe(1);
    expect(
      suggestion.warnings.filter((warning) => warning.level === 'warning').length,
    ).toBeGreaterThanOrEqual(2);
    expect(suggestion.warnings.some((warning) => warning.message.includes('obs'))).toBe(true);
  });
});

describe('fallback e preservação da data de compra', () => {
  it('deriva a data de compra do vencimento quando o arquivo não a traz', () => {
    const db = createTestDatabase();
    const buffer = makeCsv(
      ['24/11/2025;Uolcursos (Parcela 3 de 12);-362,49;CC Nubank;Educação'],
      'data;descricao;valor;pagamento;categorias',
    );
    const preview = previewImport(db.db, buffer, 'sem-compra.csv');
    expect(preview.mappingErrors).toEqual([]);
    const row = preview.rows[0];
    expect(row.values.purchaseDate).toBe('2025-11-24');
    expect(row.values.purchaseDateSource).toBe('due_date_fallback');
    expect(row.values.dueDate).toBe('2025-11-24');
    expect(row.values.estimatedFirstInstallmentDate).toBe('2025-09-24');
  });

  it('preserva a data de compra real informada no arquivo', () => {
    const db = createTestDatabase();
    const buffer = makeCsv(
      ['20/09/2025;24/11/2025;Uolcursos;-362,49;CC Nubank;3/12;Educação'],
      'Data Compra;Vencimento;Compra;Valor;Pagamento;Parcelas;Categorias',
    );
    const preview = previewImport(db.db, buffer, 'com-compra.csv');
    const row = preview.rows[0];
    expect(row.values.purchaseDateSource).toBe('file');
    expect(row.values.purchaseDate).toBe('2025-09-20');
    expect(row.values.dueDate).toBe('2025-11-24');
    expect(row.values.estimatedFirstInstallmentDate).toBe('2025-09-24');
  });

  it('continua sendo erro quando a data de compra está presente porém inválida', () => {
    const db = createTestDatabase();
    const buffer = makeCsv(
      ['data ruim;24/11/2025;Uolcursos;-362,49'],
      'Data Compra;Vencimento;Compra;Valor',
    );
    const preview = previewImport(db.db, buffer, 'ruim.csv');
    expect(preview.rows[0].errors.some((message) => message.includes('Data Compra'))).toBe(true);
  });

  it('sem parcelas válidas não há estimativa e a data real permanece', () => {
    const db = createTestDatabase();
    const buffer = makeCsv(
      ['05/10/2025;30/10/2025;Mercado;-120,00'],
      'Data Compra;Vencimento;Compra;Valor',
    );
    const preview = previewImport(db.db, buffer, 'sem-parcela.csv');
    const row = preview.rows[0];
    expect(row.values.installmentNumber).toBeNull();
    expect(row.values.installmentTotal).toBeNull();
    expect(row.values.estimatedFirstInstallmentDate).toBeNull();
    expect(row.values.purchaseDate).toBe('2025-10-05');
    expect(row.values.purchaseDateSource).toBe('file');
  });
});

describe('interface do arquivo de exemplo', () => {
  it('apresenta vencimento, origem e data estimada corretas por linha', () => {
    const expectations: Record<string, string | null> = {
      Uolcursos: '2025-09-24',
      'Casas Bahia - NuPay': '2025-08-24',
      Joripratas: '2025-10-24',
      Constance: '2025-06-24',
    };
    for (const name of EXAMPLE_ROW_NAMES) {
      const { row } = exampleRowByName(name);
      expect(row.values.dueDate, name).toBe('2025-11-24');
      expect(row.values.purchaseDateSource, name).toBe('due_date_fallback');
      expect(row.values.installmentSource, name).toBe('column');
      expect(row.values.estimatedFirstInstallmentDate, name).toBe(expectations[name]);
    }
  });

  it('persistencia preserva dados originais, origem da data e lote com modelo', () => {
    const db = createTestDatabase();
    const buffer = exampleCsv();
    const preview = previewImport(db.db, buffer, 'exemplo.csv');
    const summary = importWorkbook(db.db, buffer, 'exemplo.csv', {
      mapping: {},
      skipDuplicates: false,
    });
    expect(summary.importedRows).toBe(4);

    const row = db.sqlite
      .prepare(
        'SELECT purchase_date, purchase_date_source, due_date, amount_cents FROM transactions WHERE description = ?',
      )
      .get('Uolcursos') as
      | { purchase_date: string; purchase_date_source: string | null; due_date: string; amount_cents: number }
      | undefined;
    expect(row).toBeDefined();
    expect(row?.purchase_date).toBe('2025-11-24');
    expect(row?.purchase_date_source).toBe('due_date_fallback');
    expect(row?.due_date).toBe('2025-11-24');
    expect(row?.amount_cents).toBe(-36249);

    const id = db.sqlite
      .prepare('SELECT id FROM transactions WHERE description = ?')
      .get('Uolcursos') as { id: number } | undefined;
    const dto = getTransaction(db.db, id!.id);
    expect(dto.purchaseDateSource).toBe('due_date_fallback');
    expect(dto.estimatedFirstInstallmentDate).toBe('2025-09-24');
    expect(dto.dueDate).toBe('2025-11-24');
    expect(preview.mappingErrors).toEqual([]);
  });

  it('recupera parcelas pela descrição quando a coluna está vazia', () => {
    const db = createTestDatabase();
    const buffer = makeCsv(
      ['24/11/2025;CC Nubank Jessica;Uolcursos (Parcela 3 de 12);-362,49;Educação'],
      'data;pagamento;descricao;valor;categorias',
    );
    const preview = previewImport(db.db, buffer, 'por-descricao.csv');
    const row = preview.rows[0];
    expect(row.values.installmentNumber).toBe(3);
    expect(row.values.installmentTotal).toBe(12);
    expect(row.values.installmentSource).toBe('description');
    expect(row.values.estimatedFirstInstallmentDate).toBe('2025-09-24');
  });

  it('linha sem data de compra mantém o mesmo rastro na importação', () => {
    const db = createTestDatabase();
    const buffer = makeCsv(
      ['24/11/2025;CC Nubank Jessica;Casas Bahia - NuPay;4/10;-139,89;Compras'],
      'data;cartao;descricao;parcela;valor;categoria',
    );
    const options: ImportOptions = {
      mapping: {},
      skipDuplicates: false,
    };
    importWorkbook(db.db, buffer, 'exemplo-unico.csv', options);
    const row = db.sqlite
      .prepare(
        'SELECT purchase_date_source, description, amount_cents FROM transactions WHERE description = ?',
      )
      .get('Casas Bahia - NuPay') as
      | { purchase_date_source: string | null; description: string; amount_cents: number }
      | undefined;
    expect(row?.purchase_date_source).toBe('due_date_fallback');
    expect(row?.description).toBe('Casas Bahia - NuPay');
    expect(row?.amount_cents).toBe(-13989);
  });
});

describe('compatibilidade com duplicidades', () => {
  it('segunda importação do mesmo arquivo todas as linhas saltadas como duplicadas', () => {
    const db = createTestDatabase();
    const buffer = exampleCsv();
    const options: ImportOptions = { mapping: {}, skipDuplicates: true };

    const first = importWorkbook(db.db, buffer, 'exemplo.csv', options);
    expect(first.importedRows).toBe(4);
    expect(first.skippedDuplicates).toBe(0);

    const second = importWorkbook(db.db, buffer, 'exemplo.csv', options);
    expect(second.importedRows).toBe(0);
    expect(second.skippedDuplicates).toBe(4);
    expect(second.duplicateRows).toBe(4);
  });

  it('linhas com data de compra real também são comparáveis ao banco', () => {
    const db = createTestDatabase();
    const buffer = makeCsv(
      ['20/09/2025;24/11/2025;Uolcursos;-362,49;CC Nubank;3/12;Educação'],
      'Data Compra;Vencimento;Compra;Valor;Pagamento;Parcelas;Categorias',
    );
    const first = importWorkbook(db.db, buffer, 'com-compra.csv', { mapping: {} });
    expect(first.importedRows).toBe(1);

    const previewSecond = previewImport(db.db, buffer, 'com-compra.csv');
    expect(previewSecond.rows[0].duplicate?.kind).toBe('exact');
  });
});

describe('modelos de mapeamento', () => {
  const BASE_HEADERS = ['data', 'cartao', 'descricao', 'parcela', 'valor', 'categoria'];

  function saveExampleTemplate(db: ReturnType<typeof createTestDatabase>) {
    return saveMappingTemplate(db.db, {
      name: 'Cartão Nubank',
      headers: BASE_HEADERS,
      mapping: {
        purchaseDate: null,
        dueDate: 0,
        paymentMethod: 1,
        description: 2,
        installments: 3,
        amount: 4,
        category: 5,
        transfer: null,
      },
    });
  }

  function permutedCsv(): Buffer {
    // Mesas colunas do arquivo de exemplo, em outra ordem: cabeçalhos iguais.
    const rows = [
      'CC Nubank Jessica;-362,49;Educação;24/11/2025;Uolcursos;3/12',
      'CC Nubank Jessica;-139,89;Compras;24/11/2025;Casas Bahia - NuPay;4/10',
      'CC Nubank Jessica;-127,20;Compras;24/11/2025;Joripratas;2/5',
      'CC Nubank Jessica;-121,66;Vestuário;24/11/2025;Constance;6/6',
    ];
    return makeCsv(rows, 'cartao;valor;categoria;data;descricao;parcela');
  }

  it('modelo reaproveitado automaticamente com colunas em outra ordem', () => {
    const db = createTestDatabase();
    const template = saveExampleTemplate(db);

    const buffer = permutedCsv();
    const preview = previewImport(db.db, buffer, 'permutado.csv');
    expect(preview.appliedTemplate).toEqual({ id: template.id, name: 'Cartão Nubank' });
    expect(preview.mappingErrors).toEqual([]);
    expect(preview.mapping).toEqual({
      purchaseDate: null,
      dueDate: 3,
      description: 4,
      amount: 1,
      paymentMethod: 0,
      installments: 5,
      category: 2,
      transfer: null,
    });
    expect(
      preview.rows.map((row) => row.values.estimatedFirstInstallmentDate),
    ).toEqual([
      '2025-09-24',
      '2025-08-24',
      '2025-10-24',
      '2025-06-24',
    ]);

    const summary = importWorkbook(db.db, buffer, 'permutado.csv', { mapping: {} });
    expect(summary.importedRows).toBe(4);
    const batch = listImportBatches(db.db, 10)[0];
    expect(batch.templateName).toBe('Cartão Nubank');
  });

  it('modelos guardam cabeçalhos, não posições: atualizar pelo mesmo nome', () => {
    const db = createTestDatabase();
    const created = saveExampleTemplate(db);
    expect(created.mapping.dueDate).toBe('data');
    expect(created.mapping.installments).toBe('parcela');

    const updated = saveMappingTemplate(db.db, {
      name: 'cartão nubank',
      // Mesmo formato com colunas em outra ordem: os NOMES salvos não mudam.
      headers: ['cartao', 'valor', 'categoria', 'data', 'descricao', 'parcela'],
      mapping: {
        purchaseDate: null,
        dueDate: 3,
        paymentMethod: 0,
        description: 4,
        installments: 5,
        amount: 1,
        category: 2,
        transfer: null,
      },
    });
    expect(updated.id).toBe(created.id);
    expect(updated.mapping.dueDate).toBe('data');
    expect(updated.mapping.installments).toBe('parcela');
    expect(listMappingTemplates(db.db)).toHaveLength(1);
  });

  it('templateId explícito no preview e exclusão', () => {
    const db = createTestDatabase();
    const template = saveExampleTemplate(db);

    const buffer = makeCsv(
      ['24/11/2025;CC Nubank Jessica;Uolcursos;3/12;-362,49;Educação'],
      BASE_HEADERS.join(';'),
    );
    const forced = previewImport(
      db.db,
      buffer,
      'exemplo.csv',
      undefined,
      undefined,
      undefined,
      template.id,
    );
    expect(forced.appliedTemplate?.id).toBe(template.id);
    expect(forced.mappingErrors).toEqual([]);

    deleteMappingTemplate(db.db, template.id);
    expect(listMappingTemplates(db.db)).toHaveLength(1 - 1);
  });

  it('arquivos com formato distinto não adotam um modelo salvo', () => {
    const db = createTestDatabase();
    saveExampleTemplate(db);
    const other = makeCsv(
      ['20/09/2025;24/11/2025;Uolcursos;-362,49;CC Nubank;3/12'],
      'Data Compra;Vencimento;Compra;Valor;Pagamento;Parcelas',
    );
    const preview = previewImport(db.db, other, 'outro.csv');
    expect(preview.appliedTemplate).toBeNull();
    expect(preview.mappingErrors).toEqual([]);
    expect(preview.mapping.purchaseDate).toBe(0);
    expect(preview.mapping.dueDate).toBe(1);
  });
});

describe('valores e normalização preservados', () => {
  it('csv de exemplo sem data de compra carrega valores e categorias intactos', () => {
    const { row } = exampleRowByName('Constance');
    expect(row.values.description).toBe('Constance');
    expect(row.values.category).toBe('Vestuário');
    expect(row.values.paymentMethod).toBe('CC Nubank Jessica');
    expect(row.values.amountCents).toBe(-12166);
    expect(row.values.installmentNumber).toBe(6);
    expect(row.values.installmentTotal).toBe(6);
    expect(row.raw.dueDate).toBe('24/11/2025');
  });
});

describe('seriais de data do Excel', () => {
  it('converte seriais de data do Excel normalizando o vencimento preservado', () => {
    const db = createTestDatabase();
    // 46021 = 30/12/2025. Sem coluna de parcelas, não há estimativa.
    const buffer = makeCsv(
      ['46021;46021;Teste;-100,00;CC Nubank'],
      'Vencimento;Data Compra;Compra;Valor;Pagamento',
    );
    const preview = previewImport(db.db, buffer, 'serial.csv');
    expect(preview.mappingErrors).toEqual([]);
    const row = preview.rows[0];
    expect(row.values.dueDate).toBe('2025-12-30');
    expect(row.values.purchaseDate).toBe('2025-12-30');
    expect(row.values.purchaseDateSource).toBe('file');
    expect(row.values.estimatedFirstInstallmentDate).toBeNull();
  });

  it('serial de data na coluna de parcelas nunca vira número de parcela', () => {
    const db = createTestDatabase();
    // 46021 é um serial válido de data; a coluna Parcelas com esse valor não
    // deve ser interpretada como parcela por suposição.
    const buffer = makeCsv(
      ['24/11/2025;24/11/2025;Teste;-100,00;CC Nubank;46021'],
      'Data Compra;Vencimento;Compra;Valor;Pagamento;Parcelas',
    );
    const preview = previewImport(db.db, buffer, 'serial-parcela.csv');
    const row = preview.rows[0];
    expect(row.values.installmentNumber).toBeNull();
    expect(row.values.installmentTotal).toBeNull();
    expect(row.errors.length).toBeGreaterThan(0);
    expect(row.values.estimatedFirstInstallmentDate).toBeNull();
  });
});

describe('rotas de importação (ponta a ponta)', () => {
  function multipart(parts: { name: string; value: string; filename?: string }[]): {
    payload: string;
    headers: Record<string, string>;
  } {
    const boundary = 'financetestboundary';
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

  it('aplica modelo salvo por templateId via multipart no preview', async () => {
    const db = createTestDatabase();
    const app = await buildApp({ db: db.db, logger: false });
    try {
      const save = await app.inject({
        method: 'POST',
        url: '/api/imports/mappings',
        payload: {
          name: 'Cartão Nubank',
          headers: ['data', 'cartao', 'descricao', 'parcela', 'valor', 'categoria'],
          mapping: {
            purchaseDate: null,
            dueDate: 0,
            paymentMethod: 1,
            description: 2,
            installments: 3,
            amount: 4,
            category: 5,
            transfer: null,
          },
        },
      });
      expect(save.statusCode).toBe(200);
      const template = save.json().template;
      expect(template.id).toBeGreaterThan(0);

      const form = multipart([
        { name: 'file', value: exampleCsv().toString('utf8'), filename: 'exemplo.csv' },
        { name: 'templateId', value: String(template.id) },
      ]);
      const response = await app.inject({
        method: 'POST',
        url: '/api/imports/preview',
        payload: form.payload,
        headers: form.headers,
      });
      expect(response.statusCode).toBe(200);
      const preview = response.json();
      expect(preview.appliedTemplate).toEqual({ id: template.id, name: 'Cartão Nubank' });
      expect(preview.mappingErrors).toEqual([]);
      expect(preview.rows).toHaveLength(4);
      expect(preview.rows[0].values.estimatedFirstInstallmentDate).toBe('2025-09-24');

      const list = await app.inject({ method: 'GET', url: '/api/imports/mappings' });
      expect(list.json().templates).toHaveLength(1);

      const removed = await app.inject({
        method: 'DELETE',
        url: `/api/imports/mappings/${template.id}`,
      });
      expect(removed.statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: '/api/imports/mappings' })).json().templates).toHaveLength(0);
    } finally {
      await app.close();
      db.sqlite.close();
    }
  });

  it('importação registra o lote com o modelo utilizado e preserva origens', async () => {
    const db = createTestDatabase();
    const app = await buildApp({ db: db.db, logger: false });
    try {
      const save = await app.inject({
        method: 'POST',
        url: '/api/imports/mappings',
        payload: {
          name: 'Exemplo Addendo 3',
          headers: ['data', 'cartao', 'descricao', 'parcela', 'valor', 'categoria'],
          mapping: {
            purchaseDate: null,
            dueDate: 0,
            paymentMethod: 1,
            description: 2,
            installments: 3,
            amount: 4,
            category: 5,
            transfer: null,
          },
        },
      });
      const template = save.json().template;

      const form = multipart([
        { name: 'file', value: exampleCsv().toString('utf8'), filename: 'exemplo.csv' },
        { name: 'mapping', value: '{}' },
        { name: 'skipDuplicates', value: 'false' },
        { name: 'rejectedRows', value: '[]' },
        { name: 'templateId', value: String(template.id) },
      ]);
      const response = await app.inject({
        method: 'POST',
        url: '/api/imports',
        payload: form.payload,
        headers: form.headers,
      });
      expect(response.statusCode).toBe(201);
      const summary = response.json();
      expect(summary.importedRows).toBe(4);

      const batches = await app.inject({ method: 'GET', url: '/api/imports' });
      expect(batches.json().batches[0].templateName).toBe('Exemplo Addendo 3');

      const tx = db.sqlite
        .prepare('SELECT purchase_date_source FROM transactions WHERE description = ?')
        .get('Constance') as { purchase_date_source: string | null } | undefined;
      expect(tx?.purchase_date_source).toBe('due_date_fallback');
    } finally {
      await app.close();
      db.sqlite.close();
    }
  });
});
