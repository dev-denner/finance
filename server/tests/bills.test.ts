import { describe, expect, it } from 'vitest';
import { advanceMonth } from '../src/services/bills';
import {
  createBill,
  deleteBill,
  getBill,
  listBills,
  repeatBill,
  setBillStatus,
  updateBill,
} from '../src/services/bills';
import { importBills, previewBillsImport } from '../src/services/bills-import';
import { createTestDatabase, makeCsv } from './helpers';
import { ensureLookup } from '../src/services/lookups';

describe('contas a pagar — CRUD e estados', () => {
  it('cria, edita, lista por mês e exclui', () => {
    const db = createTestDatabase();
    const category = ensureLookup(db.db, 'category', 'Moradia');
    const created = createBill(db.db, {
      description: 'Condomínio',
      amountCents: 78200,
      dueDate: '2026-10-10',
      categoryId: category.id,
      status: '',
    });
    expect(created.status).toBe('');
    expect(created.amountCents).toBe(78200);

    const updated = updateBill(db.db, created.id, { amountCents: 80000, status: 'AG' });
    expect(updated.amountCents).toBe(80000);
    expect(updated.status).toBe('AG');

    const { bills } = listBills(db.db, 2026, 10);
    expect(bills).toHaveLength(1);
    expect(bills[0].id).toBe(created.id);

    deleteBill(db.db, created.id);
    expect(() => getBill(db.db, created.id)).toThrow();
  });

  it('rejeita valor não positivo', () => {
    const db = createTestDatabase();
    const category = ensureLookup(db.db, 'category', 'Moradia');
    expect(() =>
      createBill(db.db, {
        description: 'X',
        amountCents: 0,
        dueDate: '2026-10-10',
        categoryId: category.id,
      }),
    ).toThrow();
    expect(() =>
      createBill(db.db, {
        description: 'X',
        amountCents: -10,
        dueDate: '2026-10-10',
        categoryId: category.id,
      }),
    ).toThrow();
  });

  it('rejeita situação inválida', () => {
    const db = createTestDatabase();
    const category = ensureLookup(db.db, 'category', 'Moradia');
    expect(() =>
      createBill(db.db, {
        description: 'X',
        amountCents: 1000,
        dueDate: '2026-10-10',
        categoryId: category.id,
        status: 'XX' as any,
      }),
    ).toThrow();
  });

  it('lista apenas o mês solicitado e ordena por vencimento', () => {
    const db = createTestDatabase();
    const category = ensureLookup(db.db, 'category', 'Moradia');
    createBill(db.db, { description: 'B', amountCents: 1000, dueDate: '2026-10-20', categoryId: category.id });
    createBill(db.db, { description: 'A', amountCents: 2000, dueDate: '2026-10-05', categoryId: category.id });
    createBill(db.db, { description: 'C', amountCents: 3000, dueDate: '2026-11-01', categoryId: category.id });

    const oct = listBills(db.db, 2026, 10);
    expect(oct.bills.map((b) => b.description)).toEqual(['A', 'B']);
    expect(oct.summary.totalCents).toBe(3000);
    expect(oct.summary.counts['']).toBe(2);

    const nov = listBills(db.db, 2026, 11);
    expect(nov.bills).toHaveLength(1);
  });

  it('resumo separa pago de não pago (AG conta como não pago)', () => {
    const db = createTestDatabase();
    const category = ensureLookup(db.db, 'category', 'Moradia');
    createBill(db.db, { description: 'Paga', amountCents: 5000, dueDate: '2026-10-05', categoryId: category.id, status: 'PG' });
    createBill(db.db, { description: 'Agendada', amountCents: 3000, dueDate: '2026-10-10', categoryId: category.id, status: 'AG' });
    createBill(db.db, { description: 'Aberta', amountCents: 2000, dueDate: '2026-10-15', categoryId: category.id, status: '' });

    const { summary } = listBills(db.db, 2026, 10);
    expect(summary.totalCents).toBe(10000);
    expect(summary.paidCents).toBe(5000);
    expect(summary.unpaidCents).toBe(5000);
    expect(summary.counts).toEqual({ '': 1, AG: 1, PG: 1 });
  });
});

describe('transição para PG e repetição', () => {
  it('transição para PG dispara promptRepeat; já paga não dispara', () => {
    const db = createTestDatabase();
    const category = ensureLookup(db.db, 'category', 'Moradia');
    const bill = createBill(db.db, { description: 'Condomínio', amountCents: 78200, dueDate: '2026-10-10', categoryId: category.id });

    const first = setBillStatus(db.db, bill.id, 'PG');
    expect(first.promptRepeat).toBe(true);
    expect(first.bill.status).toBe('PG');

    const second = setBillStatus(db.db, bill.id, 'PG');
    expect(second.promptRepeat).toBe(false);
  });

  it('repetição cria conta no mês seguinte com dados copiados e status vazio', () => {
    const db = createTestDatabase();
    const category = ensureLookup(db.db, 'category', 'Moradia');
    const bill = createBill(db.db, { description: 'Condomínio', amountCents: 78200, dueDate: '2026-10-10', categoryId: category.id });
    setBillStatus(db.db, bill.id, 'PG');

    const result = repeatBill(db.db, bill.id);
    expect(result.created).toBe(true);
    expect(result.bill.description).toBe('Condomínio');
    expect(result.bill.amountCents).toBe(78200);
    expect(result.bill.categoryId).toBe(category.id);
    expect(result.bill.status).toBe('');
    expect(result.bill.dueDate).toBe('2026-11-10');
    expect(result.bill.repeatedFromId).toBe(bill.id);

    // original permanece PG
    expect(getBill(db.db, bill.id).status).toBe('PG');
  });

  it('repetição repetida não duplica e retorna a existente', () => {
    const db = createTestDatabase();
    const category = ensureLookup(db.db, 'category', 'Moradia');
    const bill = createBill(db.db, { description: 'Condomínio', amountCents: 78200, dueDate: '2026-10-10', categoryId: category.id });
    setBillStatus(db.db, bill.id, 'PG');
    repeatBill(db.db, bill.id);
    const second = repeatBill(db.db, bill.id);
    expect(second.created).toBe(false);

    const { bills } = listBills(db.db, 2026, 11);
    expect(bills).toHaveLength(1);
  });

  it('setBillStatus informa existingRepeatId quando já repetido', () => {
    const db = createTestDatabase();
    const category = ensureLookup(db.db, 'category', 'Moradia');
    const bill = createBill(db.db, { description: 'Condomínio', amountCents: 78200, dueDate: '2026-10-10', categoryId: category.id });
    setBillStatus(db.db, bill.id, 'PG');
    const repeat = repeatBill(db.db, bill.id);
    // voltar para AG e depois PG novamente informa a repetição existente
    setBillStatus(db.db, bill.id, 'AG');
    const again = setBillStatus(db.db, bill.id, 'PG');
    expect(again.promptRepeat).toBe(true);
    expect(again.existingRepeatId).toBe(repeat.bill.id);
  });

  it('voltar de PG para AG não apaga a conta criada no mês seguinte', () => {
    const db = createTestDatabase();
    const category = ensureLookup(db.db, 'category', 'Moradia');
    const bill = createBill(db.db, { description: 'Condomínio', amountCents: 78200, dueDate: '2026-10-10', categoryId: category.id });
    setBillStatus(db.db, bill.id, 'PG');
    repeatBill(db.db, bill.id);
    setBillStatus(db.db, bill.id, 'AG');
    const { bills } = listBills(db.db, 2026, 11);
    expect(bills).toHaveLength(1);
  });
});

describe('mudança de mês/ano e fim de mês', () => {
  it('advanceMonth trata 31/01, 30/01 e 31/03 em ano não bissexto', () => {
    expect(advanceMonth('2026-01-31')).toBe('2026-02-28');
    expect(advanceMonth('2026-01-30')).toBe('2026-02-28');
    expect(advanceMonth('2026-03-31')).toBe('2026-04-30');
  });

  it('advanceMonth respeita ano bissexto em fevereiro', () => {
    expect(advanceMonth('2024-01-31')).toBe('2024-02-29');
    expect(advanceMonth('2024-02-29')).toBe('2024-03-29');
  });

  it('repetição a partir de 31/12 avança o ano', () => {
    const db = createTestDatabase();
    const category = ensureLookup(db.db, 'category', 'Moradia');
    const bill = createBill(db.db, { description: 'Anual', amountCents: 1000, dueDate: '2026-12-31', categoryId: category.id });
    setBillStatus(db.db, bill.id, 'PG');
    const repeat = repeatBill(db.db, bill.id);
    expect(repeat.bill.dueDate).toBe('2027-01-31');
    const { bills } = listBills(db.db, 2027, 1);
    expect(bills).toHaveLength(1);
  });

  it('listBills filtra corretamente meses de anos diferentes', () => {
    const db = createTestDatabase();
    const category = ensureLookup(db.db, 'category', 'Moradia');
    createBill(db.db, { description: 'Dez/2026', amountCents: 1000, dueDate: '2026-12-15', categoryId: category.id });
    createBill(db.db, { description: 'Jan/2027', amountCents: 2000, dueDate: '2027-01-15', categoryId: category.id });
    expect(listBills(db.db, 2026, 12).bills).toHaveLength(1);
    expect(listBills(db.db, 2027, 1).bills).toHaveLength(1);
    expect(listBills(db.db, 2026, 11).bills).toHaveLength(0);
  });
});

describe('importação de contas a pagar', () => {
  it('preview com colunas reordenadas, valores brasileiros e situação vazia', () => {
    const db = createTestDatabase();
    const buffer = makeCsv(
      [
        'Equatorial Sitio Casa;R$ 178,69;05/01/2024;AG;Agro Negócio',
        'Condominio;R$ 782,00;10/01/2024;PG;Moradia',
        'Internet Casa (Sea);99,00;10/01/2024;;TV / Internet / Telefone',
      ],
      'Categoria;Valor;Vencimento;Situação;Despesa',
    );
    const preview = previewBillsImport(db.db, buffer, 'contas.csv');
    expect(preview.mappingErrors).toEqual([]);
    expect(preview.totalRows).toBe(3);
    expect(preview.rows[0].values.status).toBe('AG');
    expect(preview.rows[1].values.status).toBe('PG');
    expect(preview.rows[2].values.status).toBe('');
    expect(preview.rows[0].values.amountCents).toBe(17869);
    expect(preview.rows[2].values.amountCents).toBe(9900);
  });

  it('importa preservando situação vazia e compartilhando categorias', () => {
    const db = createTestDatabase();
    const buffer = makeCsv(
      [
        'Equatorial Sitio Casa;R$ 178,69;05/01/2024;AG;Agro Negócio',
        'Internet Casa (Sea);R$ 99,00;10/01/2024;;TV / Internet / Telefone',
      ],
      'Despesa;Valor;Vencimento;Situação;Categoria',
    );
    const summary = importBills(db.db, buffer, 'contas.csv', { mapping: {} });
    expect(summary.importedRows).toBe(2);

    const { bills } = listBills(db.db, 2024, 1);
    expect(bills).toHaveLength(2);
    const internet = bills.find((b) => b.description === 'Internet Casa (Sea)');
    expect(internet?.status).toBe('');
    const ag = bills.find((b) => b.description === 'Equatorial Sitio Casa');
    expect(ag?.status).toBe('AG');

    // categorias compartilhadas com Módulo 2
    const cats = db.sqlite.prepare('SELECT COUNT(*) AS n FROM categories WHERE normalized_name = ?').get('agro negocio') as { n: number };
    expect(cats.n).toBe(1);
  });

  it('trata valor negativo como magnitude positiva', () => {
    const db = createTestDatabase();
    const buffer = makeCsv(['Cartão Nubank;-9075,20;09/01/2024;PG;Pagamento de cartão'], 'Despesa;Valor;Vencimento;Situação;Categoria');
    const preview = previewBillsImport(db.db, buffer, 'neg.csv');
    expect(preview.rows[0].values.amountCents).toBe(907520);
    expect(preview.rows[0].errors).toEqual([]);
  });

  it('detecta duplicidade na segunda importação', () => {
    const db = createTestDatabase();
    const buffer = makeCsv(['Condominio;R$ 782,00;10/01/2024;PG;Moradia'], 'Despesa;Valor;Vencimento;Situação;Categoria');
    importBills(db.db, buffer, 'contas.csv', { mapping: {}, skipDuplicates: true });
    const second = importBills(db.db, buffer, 'contas.csv', { mapping: {}, skipDuplicates: true });
    expect(second.importedRows).toBe(0);
    expect(second.skippedDuplicates).toBe(1);
  });

  it('não cria transação no Módulo 2 ao importar contas', () => {
    const db = createTestDatabase();
    const before = (db.sqlite.prepare('SELECT COUNT(*) AS n FROM transactions').get() as { n: number }).n;
    const buffer = makeCsv(['Condominio;R$ 782,00;10/01/2024;PG;Moradia'], 'Despesa;Valor;Vencimento;Situação;Categoria');
    importBills(db.db, buffer, 'contas.csv', { mapping: {} });
    const after = (db.sqlite.prepare('SELECT COUNT(*) AS n FROM transactions').get() as { n: number }).n;
    expect(after).toBe(before);
  });
});

describe('integridade do banco', () => {
  it('check constraints rejeitam status e valor inválidos', () => {
    const db = createTestDatabase();
    const category = ensureLookup(db.db, 'category', 'Moradia');
    expect(() => db.sqlite.prepare('INSERT INTO scheduled_bills (description, amount_cents, due_date, status, category_id) VALUES (?,?,?,?,?)').run('X', 0, '2026-10-10', '', category.id)).toThrow();
    expect(() => db.sqlite.prepare('INSERT INTO scheduled_bills (description, amount_cents, due_date, status, category_id) VALUES (?,?,?,?,?)').run('X', 100, '2026-10-10', 'XX', category.id)).toThrow();
  });
});
