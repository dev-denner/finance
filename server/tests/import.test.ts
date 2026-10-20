import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import type { DatabaseHandle } from '../src/db/client';
import { listLookups } from '../src/services/lookups';
import {
  importWorkbook,
  previewImport,
  readWorkbook,
  suggestMapping,
} from '../src/services/import';
import { createTestDatabase, makeCsv } from './helpers';

const HEADER =
  'Data Compra;Vencimento;Compra;Valor;Pagamento;Parcelas;Categorias;Transf';

describe('importação CSV/Excel', () => {
  let handle: DatabaseHandle;

  beforeEach(() => {
    handle = createTestDatabase();
  });

  afterEach(() => {
    handle.sqlite.close();
  });

  it('lê cabeçalhos, sugere mapeamento e interpreta a prévia', () => {
    const file = makeCsv(
      [
        '05/01/2026;10/01/2026;Supermercado;-R$ 450,25;Cartão Nubank;1/3;Mercado;',
        '07/01/2026;12/01/2026;Salário;R$ 8.500,00;Conta Itaú;;Salário;',
      ],
      HEADER,
    );

    const preview = previewImport(handle.db, file, 'lancamentos.csv');
    expect(preview.totalRows).toBe(2);
    expect(preview.validRows).toBe(2);
    expect(preview.invalidRows).toBe(0);
    expect(preview.mapping).toMatchObject({
      purchaseDate: 0,
      dueDate: 1,
      description: 2,
      amount: 3,
      paymentMethod: 4,
      installments: 5,
      category: 6,
      transfer: 7,
    });
    expect(preview.rows[0].values).toMatchObject({
      purchaseDate: '2026-01-05',
      dueDate: '2026-01-10',
      description: 'Supermercado',
      amountCents: -45025,
      paymentMethod: 'Cartão Nubank',
      category: 'Mercado',
      installmentNumber: 1,
      installmentTotal: 3,
      transfer: null,
    });
    expect(preview.rows[1].values.amountCents).toBe(850000);
  });

  it('grava em transação, cria entidades e preserva o nome original', () => {
    const file = makeCsv(
      [
        '05/01/2026;10/01/2026;Supermercado;-R$ 450,25;Cartão Nubank;1/3;alimentação;',
        '06/01/2026;11/01/2026;Padaria;-R$ 20,00;cartao nubank;;ALIMENTACAO;',
        '07/01/2026;12/01/2026;Salário;R$ 8.500,00;Conta Itaú;;Salário;',
      ],
      HEADER,
    );

    const preview = previewImport(handle.db, file, 'lancamentos.csv');
    const summary = importWorkbook(handle.db, file, 'lancamentos.csv', {
      mapping: preview.mapping,
      skipDuplicates: true,
    });

    expect(summary).toMatchObject({
      totalRows: 3,
      importedRows: 3,
      rejectedRows: 0,
      invalidRows: 0,
    });
    expect(summary.batchId).toBeGreaterThan(0);
    expect(summary.createdCategories).toEqual(['alimentação', 'Salário']);
    expect(summary.createdPaymentMethods).toEqual(['Cartão Nubank', 'Conta Itaú']);
    expect(summary.firstDueDate).toBe('2026-01-10');
    expect(summary.lastDueDate).toBe('2026-01-12');

    const categories = listLookups(handle.db, 'category').map((item) => item.name);
    expect(categories).toContain('alimentação');
    expect(categories).not.toContain('ALIMENTACAO');
    expect(categories).toContain('Salário');

    const stored = handle.sqlite
      .prepare('select count(*) as total from transactions')
      .get() as { total: number };
    expect(stored.total).toBe(3);
  });

  it('rejeita linhas inválidas e permite corrigi-las antes da gravação', () => {
    const file = makeCsv(
      [
        '31/02/2026;10/03/2026;Data inválida;-R$ 100,00;Pix;;Mercado;',
        '05/01/2026;10/01/2026;Valor ambíguo;1,250;Pix;;Mercado;',
        '06/01/2026;11/01/2026;Válida;-R$ 30,00;Pix;;Mercado;',
      ],
      HEADER,
    );

    const preview = previewImport(handle.db, file, 'erros.csv');
    expect(preview.invalidRows).toBe(2);
    expect(preview.validRows).toBe(1);
    expect(preview.rows[0].errors.join(' ')).toMatch(/Data inválida/i);
    expect(preview.rows[1].errors.join(' ')).toMatch(/ambíguo/i);

    const rejected = importWorkbook(handle.db, file, 'erros.csv', {
      mapping: preview.mapping,
      skipDuplicates: true,
    });
    expect(rejected.importedRows).toBe(1);
    expect(rejected.rejectedRows).toBe(2);
    expect(rejected.invalidRows).toBe(2);

    const corrected = importWorkbook(handle.db, file, 'erros.csv', {
      mapping: preview.mapping,
      skipDuplicates: true,
      overrides: {
        '2': {
          purchaseDate: '01/03/2026',
          dueDate: '10/03/2026',
        },
        '3': {
          amount: '-R$ 125,00',
        },
      },
    });
    expect(corrected.importedRows).toBe(2);
    expect(corrected.invalidRows).toBe(0);

    const stored = handle.sqlite
      .prepare('select amount_cents from transactions order by id')
      .all() as { amount_cents: number }[];
    expect(stored.map((row) => row.amount_cents)).toContain(-12500);
  });

  it('detecta duplicidade no banco e no próprio arquivo', () => {
    const file = makeCsv(
      [
        '05/01/2026;10/01/2026;Mercado;-R$ 100,00;Pix;;Mercado;',
        '05/01/2026;10/01/2026;Mercado;-R$ 100,00;Pix;;Mercado;',
      ],
      HEADER,
    );

    const preview = previewImport(handle.db, file, 'duplicadas.csv');
    expect(preview.duplicateRows).toBe(1);
    expect(preview.rows[0].duplicate).toBeNull();
    expect(preview.rows[1].duplicate?.kind).toBe('exact');
    expect(preview.rows[1].duplicate?.source).toBe('file');
    expect(preview.rows[1].duplicate?.counterpartRowNumber).toBe(2);

    const first = importWorkbook(handle.db, file, 'duplicadas.csv', {
      mapping: preview.mapping,
      skipDuplicates: true,
    });
    expect(first.importedRows).toBe(1);
    expect(first.skippedDuplicates).toBe(1);

    const repeated = importWorkbook(handle.db, file, 'duplicadas.csv', {
      mapping: preview.mapping,
      skipDuplicates: true,
    });
    expect(repeated.importedRows).toBe(0);
    expect(repeated.duplicateRows).toBe(2);
    expect(repeated.skippedDuplicates).toBe(2);
    expect(repeated.rejectedRows).toBe(2);
  });

  it('permite importar novamente quando duplicidades não são ignoradas', () => {
    const file = makeCsv(
      ['05/01/2026;10/01/2026;Mercado;-R$ 100,00;Pix;;Mercado;'],
      HEADER,
    );
    const preview = previewImport(handle.db, file, 'repetida.csv');
    importWorkbook(handle.db, file, 'repetida.csv', {
      mapping: preview.mapping,
      skipDuplicates: true,
    });
    const again = importWorkbook(handle.db, file, 'repetida.csv', {
      mapping: preview.mapping,
      skipDuplicates: false,
    });
    expect(again.importedRows).toBe(1);
    expect(again.duplicateRows).toBe(1);
    expect(again.skippedDuplicates).toBe(0);

    const stored = handle.sqlite
      .prepare('select count(*) as total from transactions')
      .get() as { total: number };
    expect(stored.total).toBe(2);
  });

  it('respeita rejeições manuais e normaliza transferências', () => {
    const file = makeCsv(
      [
        '05/01/2026;10/01/2026;Conta A;-R$ 100,00;Pix;;Mercado;Não',
        '06/01/2026;11/01/2026;Conta B;-R$ 200,00;Pix;;Mercado;Sim',
      ],
      HEADER,
    );
    const preview = previewImport(handle.db, file, 'transferencias.csv');
    expect(preview.rows[0].values.transfer).toBeNull();
    expect(preview.rows[1].values.transfer).toBe('Sim');

    const summary = importWorkbook(handle.db, file, 'transferencias.csv', {
      mapping: preview.mapping,
      skipDuplicates: true,
      rejectedRows: [preview.rows[0].rowNumber],
    });
    expect(summary.importedRows).toBe(1);
    expect(summary.explicitRejections).toBe(1);
    expect(summary.rejectedRows).toBe(1);

    const stored = handle.sqlite
      .prepare('select transfer from transactions limit 1')
      .get() as { transfer: string | null };
    expect(stored.transfer).toBe('Sim');
  });

  it('exige o mapeamento das colunas obrigatórias', () => {
    const file = makeCsv(['05/01/2026;10/01/2026;Mercado;-R$ 100,00;Pix;;Mercado;'], HEADER);
    const suggestions = suggestMapping(['Data Compra', 'Vencimento', 'Compra', 'Pagamento']);
    const preview = previewImport(handle.db, file, 'sem-valor.csv', suggestions);
    expect(preview.mappingErrors).toHaveLength(1);
    expect(preview.mappingErrors[0]).toMatch(/Valor/);
    expect(() =>
      importWorkbook(handle.db, file, 'sem-valor.csv', {
        mapping: suggestions,
        skipDuplicates: true,
      }),
    ).toThrow(/Mapeamento/i);
  });

  it('lê arquivos XLSX', () => {
    const matrix = [
      ['Data Compra', 'Vencimento', 'Compra', 'Valor', 'Pagamento', 'Parcelas', 'Categorias', 'Transf'],
      ['05/01/2026', '10/01/2026', 'Curso', -250.5, 'Cartão', '2/4', 'Educação', ''],
    ];
    const sheet = XLSX.utils.aoa_to_sheet(matrix);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, 'Lançamentos');
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer;

    const preview = previewImport(handle.db, buffer, 'planilha.xlsx');
    expect(preview.sheetName).toBe('Lançamentos');
    expect(preview.rows[0].values.amountCents).toBe(-25050);
    expect(preview.rows[0].values.category).toBe('Educação');

    const summary = importWorkbook(handle.db, buffer, 'planilha.xlsx', {
      mapping: preview.mapping,
      skipDuplicates: true,
    });
    expect(summary.importedRows).toBe(1);
  });

  it('detecta CSV em codificação Windows-1252 e delimitador ponto e vírgula', () => {
    const content = [
      'Data Compra;Vencimento;Compra;Valor;Pagamento;Parcelas;Categorias;Transf',
      '05/01/2026;10/01/2026;Farmácia;-R$ 30,00;Cartão;1;Saúde;',
    ].join('\r\n');
    const latin1 = Buffer.from(content, 'latin1');

    const workbook = readWorkbook(latin1, 'latin1.csv');
    expect(workbook.headers[0]).toBe('Data Compra');
    const preview = previewImport(handle.db, latin1, 'latin1.csv');
    expect(preview.rows[0].values.description).toBe('Farmácia');
    expect(preview.rows[0].values.paymentMethod).toBe('Cartão');
    expect(preview.rows[0].values.category).toBe('Saúde');
  });
});
