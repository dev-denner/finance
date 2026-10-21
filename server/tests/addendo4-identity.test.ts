import { describe, expect, it } from 'vitest';
import * as schema from '../src/db/schema';
import { importWorkbook, previewImport } from '../src/services/import';
import { ensureLookup } from '../src/services/lookups';
import { buildCategoryDecisions } from '../../client/src/lib/import-decisions';
import { buildApp } from '../src/app';
import { createTestDatabase, makeCsv } from './helpers';

const HEADER = 'Data compra;Lançamento;Categoria;parcela;Valor;Pagamento';

/**
 * Reproduz o contrato real da interface:
 * - a prévia é calculada com a identidade (conta de destino + decisões);
 * - a importação envia `skipDuplicates: false`, `rejectedRows` e a lista
 *   explícita de duplicatas aceitas.
 */
function previewWithIdentity(
  db: ReturnType<typeof createTestDatabase>['db'],
  csv: Buffer,
  filename: string,
  identity: {
    destinationPaymentMethodId: number | null;
    chosen?: Parameters<typeof buildCategoryDecisions>[1];
  },
) {
  const first = previewImport(db, csv, filename);
  const decisions = buildCategoryDecisions(first.categorySuggestions, identity.chosen ?? {});
  const preview = previewImport(
    db,
    csv,
    filename,
    first.mapping,
    undefined,
    undefined,
    undefined,
    {
      destinationPaymentMethodId: identity.destinationPaymentMethodId,
      categoryDecisions: decisions,
    },
  );
  return { mapping: first.mapping, preview, decisions };
}

/** Duplicatas exatas que o usuário liberou explicitamente. */
function includedDuplicates(
  preview: ReturnType<typeof previewWithIdentity>['preview'],
  skipDuplicates: boolean,
  extra: number[] = [],
) {
  const rows = preview.rows
    .filter((row) => row.duplicate?.kind === 'exact')
    .map((row) => row.rowNumber);
  return skipDuplicates ? [...extra] : [...new Set([...rows, ...extra])].sort((a, b) => a - b);
}

describe('addendo4 - identidade entre prévia e importação', () => {
  it('reimportar o mesmo arquivo com as mesmas decisões não gera duplicidades', () => {
    const db = createTestDatabase().db;
    const destino = ensureLookup(db, 'payment', 'Conta Destino');
    const csv = makeCsv(
      [
        '01/02/2024;Compra A;OUTROS;À vista;R$ 20,00;',
        '02/02/2024;Compra B;OUTROS;À vista;R$ 30,00;',
      ],
      HEADER,
    );

    const first = previewWithIdentity(db, csv, 'id.csv', {
      destinationPaymentMethodId: destino.id,
    });
    const firstImport = importWorkbook(db, csv, 'id.csv', {
      mapping: first.mapping,
      destinationPaymentMethodId: destino.id,
      categoryDecisions: first.decisions,
      skipDuplicates: false,
      includedDuplicateRows: includedDuplicates(first.preview, true),
    });
    expect(firstImport.importedRows).toBe(2);
    expect(db.select().from(schema.transactions).all()).toHaveLength(2);

    // Reimportação: a prévia precisa marcar tudo como duplicata exata.
    const second = previewWithIdentity(db, csv, 'id.csv', {
      destinationPaymentMethodId: destino.id,
    });
    expect(second.preview.rows.map((row) => row.duplicate?.kind)).toEqual(['exact', 'exact']);

    const secondImport = importWorkbook(db, csv, 'id.csv', {
      mapping: second.mapping,
      destinationPaymentMethodId: destino.id,
      categoryDecisions: second.decisions,
      skipDuplicates: false,
      includedDuplicateRows: includedDuplicates(second.preview, true),
    });
    expect(secondImport.importedRows).toBe(0);
    expect(db.select().from(schema.transactions).all()).toHaveLength(2);
  });

  it('o servidor ignora duplicatas exatas que o usuário não liberou', () => {
    const db = createTestDatabase().db;
    const destino = ensureLookup(db, 'payment', 'Conta Destino');
    const csv = makeCsv(['01/02/2024;Compra A;OUTROS;À vista;R$ 20,00;'], HEADER);

    const first = previewWithIdentity(db, csv, 'srv.csv', {
      destinationPaymentMethodId: destino.id,
    });
    importWorkbook(db, csv, 'srv.csv', {
      mapping: first.mapping,
      destinationPaymentMethodId: destino.id,
      categoryDecisions: first.decisions,
      skipDuplicates: false,
    });

    // O cliente esqueceu de montar a lista de duplicatas aceitas: o servidor
    // precisa barrar a duplicidade mesmo com skipDuplicates: false.
    const second = previewWithIdentity(db, csv, 'srv.csv', {
      destinationPaymentMethodId: destino.id,
    });
    const summary = importWorkbook(db, csv, 'srv.csv', {
      mapping: second.mapping,
      destinationPaymentMethodId: destino.id,
      categoryDecisions: second.decisions,
      skipDuplicates: false,
      includedDuplicateRows: [],
    });
    expect(summary.importedRows).toBe(0);
    expect(summary.skippedDuplicates).toBe(1);
    expect(db.select().from(schema.transactions).all()).toHaveLength(1);
  });

  it('duplicata liberada explicitamente é importada', () => {
    const db = createTestDatabase().db;
    const destino = ensureLookup(db, 'payment', 'Conta Destino');
    const csv = makeCsv(['01/02/2024;Compra A;OUTROS;À vista;R$ 20,00;'], HEADER);

    const first = previewWithIdentity(db, csv, 'srv2.csv', {
      destinationPaymentMethodId: destino.id,
    });
    importWorkbook(db, csv, 'srv2.csv', {
      mapping: first.mapping,
      destinationPaymentMethodId: destino.id,
      categoryDecisions: first.decisions,
      skipDuplicates: false,
    });

    const second = previewWithIdentity(db, csv, 'srv2.csv', {
      destinationPaymentMethodId: destino.id,
    });
    const rowNumber = second.preview.rows[0].rowNumber;
    const summary = importWorkbook(db, csv, 'srv2.csv', {
      mapping: second.mapping,
      destinationPaymentMethodId: destino.id,
      categoryDecisions: second.decisions,
      skipDuplicates: false,
      includedDuplicateRows: [rowNumber],
    });
    expect(summary.importedRows).toBe(1);
    expect(summary.skippedDuplicates).toBe(0);
    expect(db.select().from(schema.transactions).all()).toHaveLength(2);
  });

  it('mudar a conta de destino muda a identidade da duplicidade', () => {
    const db = createTestDatabase().db;
    const contaA = ensureLookup(db, 'payment', 'Conta A');
    const contaB = ensureLookup(db, 'payment', 'Conta B');
    const csv = makeCsv(['01/02/2024;Compra A;OUTROS;À vista;R$ 20,00;'], HEADER);

    const comA = previewWithIdentity(db, csv, 'troca.csv', {
      destinationPaymentMethodId: contaA.id,
    });
    importWorkbook(db, csv, 'troca.csv', {
      mapping: comA.mapping,
      destinationPaymentMethodId: contaA.id,
      categoryDecisions: comA.decisions,
      skipDuplicates: false,
    });

    // Mesma conta: duplicata exata.
    const repetirA = previewWithIdentity(db, csv, 'troca.csv', {
      destinationPaymentMethodId: contaA.id,
    });
    expect(repetirA.preview.rows[0].duplicate?.kind).toBe('exact');

    // Conta diferente: identidade diferente, não é a mesma transação.
    const comB = previewWithIdentity(db, csv, 'troca.csv', {
      destinationPaymentMethodId: contaB.id,
    });
    expect(comB.preview.rows[0].duplicate?.kind).not.toBe('exact');
  });

  it('mudar a categoria de destino muda a identidade da duplicidade', () => {
    const db = createTestDatabase().db;
    const destino = ensureLookup(db, 'payment', 'Conta Destino');
    const mercado = ensureLookup(db, 'category', 'Mercado');
    const mercearia = ensureLookup(db, 'category', 'Mercearia');
    const csv = makeCsv(['01/02/2024;Compra A;Mercadinho;À vista;R$ 20,00;'], HEADER);

    const comDecisao = previewWithIdentity(db, csv, 'cat.csv', {
      destinationPaymentMethodId: destino.id,
      chosen: { mercadinho: { action: 'use', targetCategoryId: mercado.id } },
    });
    importWorkbook(db, csv, 'cat.csv', {
      mapping: comDecisao.mapping,
      destinationPaymentMethodId: destino.id,
      categoryDecisions: comDecisao.decisions,
      skipDuplicates: false,
    });
    const stored = db.select().from(schema.transactions).all();
    expect(stored).toHaveLength(1);
    expect(stored[0].categoryId).toBe(mercado.id);

    // Com a mesma decisão, a reimportação é duplicata exata.
    const repetir = previewWithIdentity(db, csv, 'cat.csv', {
      destinationPaymentMethodId: destino.id,
      chosen: { mercadinho: { action: 'use', targetCategoryId: mercado.id } },
    });
    expect(repetir.preview.rows[0].duplicate?.kind).toBe('exact');

    // Com outra categoria de destino, a identidade muda: não é a mesma
    // transação e a duplicidade não pode ser tratada como exata.
    const outra = previewWithIdentity(db, csv, 'cat.csv', {
      destinationPaymentMethodId: destino.id,
      chosen: { mercadinho: { action: 'use', targetCategoryId: mercearia.id } },
    });
    expect(outra.preview.rows[0].duplicate?.kind).not.toBe('exact');
  });
});

describe('addendo4 - conta de destino', () => {
  it('detecta a linha sem conta mesmo com a coluna de pagamento no arquivo', () => {
    const db = createTestDatabase().db;
    const destino = ensureLookup(db, 'payment', 'Conta Destino');
    const cartao = ensureLookup(db, 'payment', 'Cartão Crédito');
    const csv = makeCsv(
      [
        '01/02/2024;Linha Com Conta;OUTROS;À vista;R$ 10,00;Cartão Crédito',
        '02/02/2024;Linha Sem Conta;OUTROS;À vista;R$ 20,00;',
      ],
      HEADER,
    );

    const preview = previewImport(db, csv, 'destino.csv');
    expect(preview.mapping.paymentMethod).not.toBeNull();
    expect(preview.rows[0].values.paymentMethod).toBe('Cartão Crédito');
    expect(preview.rows[1].values.paymentMethod).toBeNull();

    const decisions = buildCategoryDecisions(preview.categorySuggestions, {});
    const summary = importWorkbook(db, csv, 'destino.csv', {
      mapping: preview.mapping,
      destinationPaymentMethodId: destino.id,
      categoryDecisions: decisions,
      skipDuplicates: false,
    });
    expect(summary.importedRows).toBe(2);

    const stored = db.select().from(schema.transactions).all();
    const byDescription = new Map(stored.map((row) => [row.description, row]));
    expect(byDescription.get('Linha Com Conta')!.paymentMethodId).toBe(cartao.id);
    expect(byDescription.get('Linha Sem Conta')!.paymentMethodId).toBe(destino.id);
  });

  it('bloqueia a importação quando falta a conta de destino', () => {
    const db = createTestDatabase().db;
    const csv = makeCsv(['02/02/2024;Linha Sem Conta;OUTROS;À vista;R$ 20,00;'], HEADER);
    const preview = previewImport(db, csv, 'sem-destino.csv');
    expect(() =>
      importWorkbook(db, csv, 'sem-destino.csv', {
        mapping: preview.mapping,
        categoryDecisions: buildCategoryDecisions(preview.categorySuggestions, {}),
        skipDuplicates: false,
      }),
    ).toThrow(/Informe a conta\/forma de pagamento de destino/);
  });
});

describe('addendo4 - categorias e aliases', () => {
  it('sugestão automática não persiste alias', () => {
    const db = createTestDatabase().db;
    const destino = ensureLookup(db, 'payment', 'Conta Destino');
    const cartao = ensureLookup(db, 'category', 'Pagamento de cartão');
    const csv = makeCsv(
      ['03/02/2024;Pagamento Fatura;PAGAMENTO_RECEBIDO;À vista;R$ 1.500,00;'],
      HEADER,
    );
    const preview = previewImport(db, csv, 'alias.csv');
    const decisions = buildCategoryDecisions(preview.categorySuggestions, {});
    expect(decisions.pagamento_recebido.action).toBe('accept');
    expect(decisions.pagamento_recebido.confirmed).toBe(false);

    importWorkbook(db, csv, 'alias.csv', {
      mapping: preview.mapping,
      destinationPaymentMethodId: destino.id,
      categoryDecisions: decisions,
      skipDuplicates: false,
    });
    const stored = db.select().from(schema.transactions).all();
    expect(stored[0].categoryId).toBe(cartao.id);
    expect(db.select().from(schema.categoryImportAliases).all()).toHaveLength(0);
  });

  it('confirmação explícita persiste o alias', () => {
    const db = createTestDatabase().db;
    const destino = ensureLookup(db, 'payment', 'Conta Destino');
    const cartao = ensureLookup(db, 'category', 'Pagamento de cartão');
    const csv = makeCsv(
      ['03/02/2024;Pagamento Fatura;PAGAMENTO_RECEBIDO;À vista;R$ 1.500,00;'],
      HEADER,
    );
    const preview = previewImport(db, csv, 'alias2.csv');
    const decisions = buildCategoryDecisions(preview.categorySuggestions, {
      pagamento_recebido: {
        action: 'accept',
        sourceCategory: 'PAGAMENTO_RECEBIDO',
        targetCategoryId: cartao.id,
      },
    });
    expect(decisions.pagamento_recebido.confirmed).toBe(true);

    importWorkbook(db, csv, 'alias2.csv', {
      mapping: preview.mapping,
      destinationPaymentMethodId: destino.id,
      categoryDecisions: decisions,
      skipDuplicates: false,
    });
    const aliases = db.select().from(schema.categoryImportAliases).all();
    expect(aliases.map((alias) => alias.sourceNormalizedName)).toContain('pagamento_recebido');
  });

  it('rejeita decisão de categoria com destino inexistente', () => {
    const db = createTestDatabase().db;
    const destino = ensureLookup(db, 'payment', 'Conta Destino');
    const csv = makeCsv(['01/02/2024;Compra A;Mercado;À vista;R$ 20,00;'], HEADER);
    const preview = previewImport(db, csv, 'invalida.csv');
    expect(() =>
      importWorkbook(db, csv, 'invalida.csv', {
        mapping: preview.mapping,
        destinationPaymentMethodId: destino.id,
        categoryDecisions: {
          mercado: { action: 'use', targetCategoryId: 999999, sourceCategory: 'Mercado' },
        },
        skipDuplicates: false,
      }),
    ).toThrow(/categoria de destino não existe/i);
  });

  it('decisão create preserva o nome escolhido para a nova categoria', () => {
    const db = createTestDatabase().db;
    const destino = ensureLookup(db, 'payment', 'Conta Destino');
    const csv = makeCsv(['01/02/2024;Compra A;Mercadinho;À vista;R$ 20,00;'], HEADER);
    const preview = previewImport(db, csv, 'create.csv');
    const decisions = buildCategoryDecisions(preview.categorySuggestions, {
      mercadinho: { action: 'create', newCategoryName: 'Supermercado' },
    });
    expect(decisions.mercadinho.newCategoryName).toBe('Supermercado');

    importWorkbook(db, csv, 'create.csv', {
      mapping: preview.mapping,
      destinationPaymentMethodId: destino.id,
      categoryDecisions: decisions,
      skipDuplicates: false,
    });
    const names = db.select().from(schema.categories).all().map((category) => category.name);
    expect(names).toContain('Supermercado');
    expect(names).not.toContain('Mercadinho');
  });
});

describe('addendo4 - parcelas, datas e valores', () => {
  it('calcula o vencimento pela parcela e pela compra à vista', () => {
    const db = createTestDatabase().db;
    const destino = ensureLookup(db, 'payment', 'Conta Destino');
    const csv = makeCsv(
      [
        '01/02/2024;Parcelada;OUTROS;Parcela 1/10;R$ 12,34;',
        '02/02/2024;Avista;OUTROS;Compra à vista;R$ 5,00;',
        '03/02/2024;SemParcela;OUTROS;;R$ 7,00;',
      ],
      HEADER,
    );
    const preview = previewImport(db, csv, 'datas.csv');
    // Parcela 1/10 vence no mês da compra; a 3/10 desloca dois meses.
    expect(preview.rows[0].values.dueDate).toBe('2024-02-01');
    expect(preview.rows[0].values.dueDateSource).toBe('estimated_from_installment');
    expect(preview.rows[1].values.dueDate).toBe('2024-02-02');
    expect(preview.rows[1].values.dueDateSource).toBe('derived_from_cash_purchase');
    expect(preview.rows[2].values.dueDate).toBe('2024-02-03');
    expect(preview.rows[2].values.dueDateSource).toBe('derived_from_purchase_fallback');

    const decisions = buildCategoryDecisions(preview.categorySuggestions, {});
    importWorkbook(db, csv, 'datas.csv', {
      mapping: preview.mapping,
      destinationPaymentMethodId: destino.id,
      categoryDecisions: decisions,
      skipDuplicates: false,
    });
    const stored = db.select().from(schema.transactions).all();
    const byDescription = new Map(stored.map((row) => [row.description, row]));
    expect(byDescription.get('Parcelada')!.dueDate).toBe('2024-02-01');
    expect(byDescription.get('Avista')!.dueDate).toBe('2024-02-02');
    expect(byDescription.get('SemParcela')!.dueDate).toBe('2024-02-03');
  });

  it('preserva valores negativos e centavos', () => {
    const db = createTestDatabase().db;
    const destino = ensureLookup(db, 'payment', 'Conta Destino');
    const csv = makeCsv(
      [
        '01/02/2024;Credito;OUTROS;À vista;R$ 1.234,56;',
        '02/02/2024;Debito;OUTROS;À vista;-R$ 99,90;',
        '03/02/2024;Centavos;OUTROS;À vista;R$ 0,01;',
      ],
      HEADER,
    );
    const preview = previewImport(db, csv, 'valores.csv');
    expect(preview.rows.map((row) => row.values.amountCents)).toEqual([123456, -9990, 1]);

    const decisions = buildCategoryDecisions(preview.categorySuggestions, {});
    importWorkbook(db, csv, 'valores.csv', {
      mapping: preview.mapping,
      destinationPaymentMethodId: destino.id,
      categoryDecisions: decisions,
      skipDuplicates: false,
    });
    const stored = db
      .select()
      .from(schema.transactions)
      .all()
      .map((row) => row.amountCents)
      .sort((a, b) => a - b);
    expect(stored).toEqual([-9990, 1, 123456]);
  });
});

describe('addendo4 - rota de importação', () => {
  function multipart(parts: { name: string; value: string; filename?: string }[]): {
    payload: string;
    headers: Record<string, string>;
  } {
    const boundary = 'addendo4identityboundary';
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

  it('a rota respeita a lista explícita de duplicatas aceitas', async () => {
    const handle = createTestDatabase();
    const app = await buildApp({ db: handle.db, logger: false });
    const destino = ensureLookup(handle.db, 'payment', 'Conta Destino');
    const csv = makeCsv(
      ['01/02/2024;Compra A;OUTROS;À vista;R$ 20,00;'],
      HEADER,
    ).toString('utf8');
    const base = [
      { name: 'file', value: csv, filename: 'rota.csv' },
      { name: 'mapping', value: JSON.stringify({}) },
      { name: 'skipDuplicates', value: 'false' },
      { name: 'destinationPaymentMethodId', value: String(destino.id) },
    ];
    try {
      const primeira = multipart(base);
      const primeiraResponse = await app.inject({
        method: 'POST',
        url: '/api/imports',
        payload: primeira.payload,
        headers: primeira.headers,
      });
      expect(primeiraResponse.statusCode).toBe(201);
      expect(primeiraResponse.json().importedRows).toBe(1);

      // Lista vazia: o servidor barra a duplicidade.
      const barrada = multipart([...base, { name: 'includedDuplicateRows', value: '[]' }]);
      const barradaResponse = await app.inject({
        method: 'POST',
        url: '/api/imports',
        payload: barrada.payload,
        headers: barrada.headers,
      });
      expect(barradaResponse.statusCode).toBe(201);
      expect(barradaResponse.json().importedRows).toBe(0);
      expect(barradaResponse.json().skippedDuplicates).toBe(1);

      // Lista com a linha: o usuário pediu, a duplicidade entra.
      const liberada = multipart([
        ...base,
        { name: 'includedDuplicateRows', value: JSON.stringify([2]) },
      ]);
      const liberadaResponse = await app.inject({
        method: 'POST',
        url: '/api/imports',
        payload: liberada.payload,
        headers: liberada.headers,
      });
      expect(liberadaResponse.statusCode).toBe(201);
      expect(liberadaResponse.json().importedRows).toBe(1);
      expect(handle.db.select().from(schema.transactions).all()).toHaveLength(2);
    } finally {
      await app.close();
    }
  });
});
