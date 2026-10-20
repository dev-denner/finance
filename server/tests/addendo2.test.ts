import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import type { DatabaseHandle } from '../src/db/client';
import {
  findDescriptionInstallments,
  parseInstallments,
} from '../src/lib/installments';
import {
  importWorkbook,
  previewImport,
} from '../src/services/import';
import {
  applyInstallmentRecovery,
  findInstallmentRecoveryProposals,
} from '../src/services/installment-recovery';
import { createLookup } from '../src/services/lookups';
import {
  clearTransferRejection,
  getReconciliation,
  rejectTransferPair,
} from '../src/services/reconciliation';
import {
  deleteTransaction,
  getTransaction,
  listTransactions,
  updateTransaction,
} from '../src/services/transactions';
import { linkTransfer, unlinkTransfer } from '../src/services/transfers';
import { getAccountCashFlow, getAnnualConsolidation } from '../src/services/consolidation';
import { createTestDatabase, makeCsv, seedTransaction } from './helpers';

const HEADER =
  'Data Compra;Vencimento;Compra;Valor;Pagamento;Parcelas;Categorias;Transf';

function list(db: DatabaseHandle, kind: 'all' | 'expenses' | 'income' | 'transfers') {
  return listTransactions(db.db, {
    dateField: 'due',
    kind,
    sortBy: 'dueDate',
    sortDir: 'asc',
    page: 1,
    pageSize: 100,
  });
}

describe('parcelas: coluna, descrição e seriais do Excel', () => {
  let handle: DatabaseHandle;

  beforeEach(() => {
    handle = createTestDatabase();
  });

  afterEach(() => {
    handle.sqlite.close();
  });

  it('recupera 09/12 da descrição quando a coluna tem serial de data do Excel', () => {
    const result = parseInstallments('44717', {
      description: 'Pag*Educacaoegestaode (Parcela 09/12)',
    });
    expect(result.status).toBe('ok');
    expect(result.value).toEqual({ number: 9, total: 12 });
    expect(result.source).toBe('description');
    expect(result.original).toBe('44717');
    expect(result.note).toMatch(/Parcela 09\/12 recuperada da descrição/);
  });

  it('detecta serial numérico e formato de data sem converter por suposição', () => {
    const numeric = parseInstallments(44717, { meta: { type: 'n', format: 'dd/mm/yyyy' } });
    expect(numeric.status).toBe('date_like');
    expect(numeric.value).toEqual({ number: null, total: null });
    expect(numeric.error).toMatch(/data do Excel/i);

    const formatted = parseInstallments(3, { meta: { type: 'n', format: 'mm-yyyy' } });
    expect(formatted.status).toBe('date_like');

    const textWithDateFormat = parseInstallments('3', {
      meta: { type: 's', format: 'dd/mm/yyyy' },
    });
    expect(textWithDateFormat.status).toBe('date_like');
  });

  it('aceita os formatos usuais de parcelas', () => {
    const cases: [unknown, number, number][] = [
      ['01/02', 1, 2],
      ['1/2', 1, 2],
      ['09/12', 9, 12],
      ['Parcela 1 de 2', 1, 2],
      ['Parcela 01 de 02', 1, 2],
      ['Parc. 3/10', 3, 10],
      ['(Parcela 09/12)', 9, 12],
      ['12x', 12, 12],
    ];
    for (const [input, number, total] of cases) {
      const result = parseInstallments(input);
      expect(result.status, String(input)).toBe('ok');
      if (input === '12x') {
        expect(result.value).toEqual({ number: null, total: 12 });
      } else {
        expect(result.value).toEqual({ number, total });
      }
    }
  });

  it('rejeita parcela maior que o total e zero', () => {
    expect(parseInstallments('12/9').status).toBe('invalid');
    expect(parseInstallments('0/2').status).toBe('invalid');
    expect(parseInstallments('Parcela 0 de 2').status).toBe('invalid');
  });

  it('exige revisão quando a coluna e a descrição divergem', () => {
    const result = parseInstallments('3/10', {
      description: 'Compra (Parcela 09/12)',
    });
    expect(result.status).toBe('conflict');
    expect(result.error).toMatch(/coluna informa 3\/10/i);
    expect(result.error).toMatch(/descrição indica 9\/12/i);
    expect(result.suggestions.map((item) => item.number)).toEqual([3, 9]);
  });

  it('combina total da coluna com número da descrição em conflito', () => {
    const result = parseInstallments('10x', {
      description: 'Compra (Parcela 03/12)',
    });
    expect(result.status).toBe('conflict');
    expect(result.suggestions[0]).toMatchObject({ number: 3, total: 10 });
    expect(result.suggestions[0].label).toMatch(/Combinar total da coluna/i);
  });

  it('extrai 1/2 e Parcela 1 de 2 da descrição', () => {
    expect(findDescriptionInstallments('Compra 1/2').match).toEqual({ number: 1, total: 2 });
    expect(findDescriptionInstallments('Compra Parcela 1 de 2').match).toEqual({
      number: 1,
      total: 2,
    });
    expect(findDescriptionInstallments('Compra (Parcela 09/12)').match).toEqual({
      number: 9,
      total: 12,
    });
  });

  it('não interpreta uma data completa como parcelas', () => {
    expect(findDescriptionInstallments('Compra em 10/01/2026').match).toBeNull();
  });

  it('persiste a origem e o valor original ao importar parcela recuperada', () => {
    const file = makeCsv(
      [
        '05/01/2026;10/01/2026;Curso (Parcela 09/12);-R$ 100,00;Cartão;44717;Educação;',
      ],
      HEADER,
    );
    const preview = previewImport(handle.db, file, 'parcelas.csv');
    expect(preview.rows[0].errors).toEqual([]);
    expect(preview.rows[0].values.installmentNumber).toBe(9);
    expect(preview.rows[0].values.installmentTotal).toBe(12);
    expect(preview.rows[0].values.installmentSource).toBe('description');
    expect(preview.rows[0].values.installmentOriginal).toBe('44717');
    expect(preview.rows[0].installmentNote).toMatch(/recuperada da descrição/);

    importWorkbook(handle.db, file, 'parcelas.csv', {
      mapping: preview.mapping,
      skipDuplicates: true,
    });
    const stored = handle.sqlite
      .prepare(
        'select installment_number, installment_total, installment_source, installment_original from transactions',
      )
      .get() as {
      installment_number: number;
      installment_total: number;
      installment_source: string;
      installment_original: string;
    };
    expect(stored).toEqual({
      installment_number: 9,
      installment_total: 12,
      installment_source: 'description',
      installment_original: '44717',
    });
  });

  it('lê formato de data em XLSX e mantém a linha inválida sem descrição recuperável', () => {
    const header = HEADER.split(';');
    const sheet = XLSX.utils.aoa_to_sheet([
      header,
      ['05/01/2026', '10/01/2026', 'Compra sem descrição', '-R$ 50,00', 'Cartão', null, 'Mercado', ''],
    ]);
    sheet.F2 = { t: 'n', v: 44717, z: 'dd/mm/yyyy' };
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, 'Lançamentos');
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer;

    const preview = previewImport(handle.db, buffer, 'serial.xlsx');
    expect(preview.rows[0].errors.join(' ')).toMatch(/data do Excel/i);
    expect(preview.rows[0].issues.map((issue) => issue.field)).toContain('installments');
  });
});

describe('duplicidades e escolha manual na importação', () => {
  let handle: DatabaseHandle;

  beforeEach(() => {
    handle = createTestDatabase();
  });

  afterEach(() => {
    handle.sqlite.close();
  });

  it('distingue duplicidade exata e provável no mesmo arquivo', () => {
    const file = makeCsv(
      [
        '05/01/2026;10/01/2026;Mercado;-R$ 100,00;Pix;;Mercado;',
        '05/01/2026;10/01/2026;Mercado;-R$ 100,00;Pix;;Mercado;',
        '05/01/2026;10/01/2026;Mercado central;-R$ 100,00;Pix;;Mercado;',
      ],
      HEADER,
    );
    const preview = previewImport(handle.db, file, 'duplicadas.csv');
    expect(preview.rows[0].duplicate).toBeNull();
    expect(preview.rows[1].duplicate?.kind).toBe('exact');
    expect(preview.rows[1].duplicate?.source).toBe('file');
    expect(preview.rows[2].duplicate?.kind).toBe('probable');
    expect(preview.rows[2].duplicate?.counterpartRowNumber).toBe(2);
    expect(preview.rows[2].duplicate?.reason).toMatch(/Mesma data, valor e conta/i);
  });

  it('detecta duplicidade entre importações e mostra o lançamento do banco', () => {
    const file = makeCsv(
      ['05/01/2026;10/01/2026;Mercado;-R$ 100,00;Pix;;Mercado;'],
      HEADER,
    );
    const preview = previewImport(handle.db, file, 'primeira.csv');
    importWorkbook(handle.db, file, 'primeira.csv', {
      mapping: preview.mapping,
      skipDuplicates: true,
    });

    const repeated = previewImport(handle.db, file, 'segunda.csv');
    expect(repeated.rows[0].duplicate?.kind).toBe('exact');
    expect(repeated.rows[0].duplicate?.source).toBe('database');
    expect(repeated.rows[0].duplicate?.counterpartTransactionId).toBeGreaterThan(0);
    expect(repeated.rows[0].duplicate?.counterpart.importBatchId).toBeGreaterThan(0);
  });

  it('permite escolher qual linha duplicada importar sem alterar o registro existente', () => {
    const file = makeCsv(
      [
        '05/01/2026;10/01/2026;Mercado;-R$ 100,00;Pix;;Mercado;',
        '05/01/2026;10/01/2026;Mercado;-R$ 100,00;Pix;;Mercado;',
        '05/01/2026;10/01/2026;Mercado;-R$ 100,00;Pix;;Mercado;',
      ],
      HEADER,
    );
    const preview = previewImport(handle.db, file, 'escolha.csv');
    const rowNumbers = preview.rows.map((row) => row.rowNumber);
    const summary = importWorkbook(handle.db, file, 'escolha.csv', {
      mapping: preview.mapping,
      skipDuplicates: false,
      rejectedRows: [rowNumbers[0], rowNumbers[2]],
    });
    expect(summary.importedRows).toBe(1);
    expect(summary.explicitRejections).toBe(2);
    expect(summary.ignoredRows).toBe(2);

    const stored = handle.sqlite
      .prepare('select count(*) as total from transactions')
      .get() as { total: number };
    expect(stored.total).toBe(1);
  });

  it('não substitui automaticamente um lançamento já gravado', () => {
    const first = makeCsv(
      ['05/01/2026;10/01/2026;Mercado;-R$ 100,00;Pix;;Mercado;'],
      HEADER,
    );
    const firstPreview = previewImport(handle.db, first, 'primeira.csv');
    importWorkbook(handle.db, first, 'primeira.csv', {
      mapping: firstPreview.mapping,
      skipDuplicates: true,
    });
    const original = getTransaction(handle.db, 1);

    const second = makeCsv(
      ['05/01/2026;10/01/2026;Mercado;-R$ 100,00;Pix;;Mercado;'],
      HEADER,
    );
    const secondPreview = previewImport(handle.db, second, 'segunda.csv');
    const summary = importWorkbook(handle.db, second, 'segunda.csv', {
      mapping: secondPreview.mapping,
      skipDuplicates: false,
    });
    expect(summary.importedRows).toBe(1);

    const after = getTransaction(handle.db, original.id);
    expect(after.amountCents).toBe(original.amountCents);
    expect(after.description).toBe(original.description);
    const count = handle.sqlite
      .prepare('select count(*) as total from transactions')
      .get() as { total: number };
    expect(count.total).toBe(2);
  });

  it('permite corrigir uma célula inválida e revalidar a linha', () => {
    const file = makeCsv(
      ['05/01/2026;10/01/2026;Mercado;-R$ 100,00;Pix;;Mercado;', '05/01/2026;10/01/2026;Farmácia;abc;Pix;;Saúde;'],
      HEADER,
    );
    const preview = previewImport(handle.db, file, 'erros.csv');
    const invalid = preview.rows.find((row) => row.errors.length > 0)!;
    expect(invalid.issues.some((issue) => issue.field === 'amount')).toBe(true);

    const corrected = previewImport(
      handle.db,
      file,
      'erros.csv',
      preview.mapping,
      { [String(invalid.rowNumber)]: { amount: '-R$ 25,00' } },
    );
    const row = corrected.rows.find((item) => item.rowNumber === invalid.rowNumber)!;
    expect(row.errors).toEqual([]);
    expect(row.values.amountCents).toBe(-2500);
    expect(row.raw.amount).toBe('abc');
  });
});

describe('classificação de categorias, cartão e consolidado', () => {
  let handle: DatabaseHandle;

  beforeEach(() => {
    handle = createTestDatabase();
  });

  afterEach(() => {
    handle.sqlite.close();
  });

  it('trata categoria classificada como transferência sem inflar receitas/despesas', () => {
    createLookup(handle.db, 'category', 'Transferências', null, 'transfer');
    seedTransaction(handle.db, {
      dueDate: '2026-01-05',
      amount: '-R$ 500,00',
      description: 'Envio para investimento',
      category: 'Transferências',
      payment: 'Conta A',
    });
    seedTransaction(handle.db, {
      dueDate: '2026-01-05',
      amount: 'R$ 500,00',
      description: 'Recebimento do investimento',
      category: 'Transferências',
      payment: 'Conta B',
    });
    seedTransaction(handle.db, {
      dueDate: '2026-01-06',
      amount: '-R$ 100,00',
      description: 'Mercado',
      category: 'Mercado',
    });

    const expenses = list(handle, 'expenses');
    expect(expenses.total).toBe(1);
    expect(expenses.rows[0].description).toBe('Mercado');
    expect(expenses.summary.expenseCents).toBe(10000);

    const income = list(handle, 'income');
    expect(income.total).toBe(0);

    const transfers = list(handle, 'transfers');
    expect(transfers.total).toBe(2);

    const annual = getAnnualConsolidation(handle.db, 2026, 'due', 'expenses');
    expect(annual.categories.map((row) => row.categoryName)).toEqual(['Mercado']);
    expect(annual.totals.totalCents).toBe(10000);

    const annualTransfers = getAnnualConsolidation(handle.db, 2026, 'due', 'transfers');
    expect(annualTransfers.categories.map((row) => row.categoryName)).toEqual([
      'Transferências',
    ]);

    const cashFlow = getAccountCashFlow(handle.db, 2026, 'due');
    const accountA = cashFlow.rows.find((row) => row.paymentMethodName === 'Conta A')!;
    const accountB = cashFlow.rows.find((row) => row.paymentMethodName === 'Conta B')!;
    expect(accountA).toMatchObject({ netCents: -50000, transferCents: 50000 });
    expect(accountB).toMatchObject({ netCents: 50000, transferCents: 50000 });
    expect(cashFlow.totals.netCents).toBe(-10000);
    expect(cashFlow.totals.transferCents).toBe(100000);
  });

  it('não conta o pagamento da fatura como nova despesa, mas mantém o movimento de caixa', () => {
    createLookup(handle.db, 'category', 'Fatura Cartão', null, 'card_settlement');
    seedTransaction(handle.db, {
      dueDate: '2026-01-01',
      amount: 'R$ 1.000,00',
      description: 'Salário',
      category: 'Salário',
    });
    seedTransaction(handle.db, {
      dueDate: '2026-01-10',
      amount: '-R$ 500,00',
      description: 'Compra no cartão',
      category: 'Mercado',
      payment: 'Cartão',
    });
    seedTransaction(handle.db, {
      dueDate: '2026-01-20',
      amount: '-R$ 500,00',
      description: 'Pagamento da fatura',
      category: 'Fatura Cartão',
      payment: 'Conta corrente',
    });

    const all = list(handle, 'all');
    expect(all.summary.expenseCents).toBe(50000);
    expect(all.summary.incomeCents).toBe(100000);
    expect(all.summary.resultNetCents).toBe(50000);
    expect(all.summary.cardSettlementCents).toBe(50000);
    expect(all.summary.cashFlowCents).toBe(0);
    // O lançamento continua visível na listagem geral.
    expect(all.rows.map((row) => row.description)).toContain('Pagamento da fatura');

    const expenses = list(handle, 'expenses');
    expect(expenses.total).toBe(1);
    expect(expenses.rows[0].description).toBe('Compra no cartão');

    const annual = getAnnualConsolidation(handle.db, 2026, 'due', 'expenses');
    expect(annual.categories.map((row) => row.categoryName)).toEqual(['Mercado']);
    expect(annual.totals.totalCents).toBe(50000);

    const cashFlow = getAccountCashFlow(handle.db, 2026, 'due');
    const checking = cashFlow.rows.find((row) => row.paymentMethodName === 'Conta corrente')!;
    expect(checking).toMatchObject({
      netCents: -50000,
      outCents: 50000,
      cardSettlementCents: 50000,
    });
    expect(cashFlow.totals).toMatchObject({
      inCents: 100000,
      outCents: 100000,
      netCents: 0,
      cardSettlementCents: 50000,
    });
  });

  it('mantém lançamentos ambíguos como despesa quando não há classificação confiável', () => {
    seedTransaction(handle.db, {
      dueDate: '2026-01-10',
      amount: '-R$ 80,00',
      description: 'Lançamento sem classificação',
      category: 'Outros',
    });
    const expenses = list(handle, 'expenses');
    expect(expenses.total).toBe(1);
    expect(expenses.summary.expenseCents).toBe(8000);
  });
});

describe('recuperação de parcelas em lançamentos existentes', () => {
  let handle: DatabaseHandle;

  beforeEach(() => {
    handle = createTestDatabase();
  });

  afterEach(() => {
    handle.sqlite.close();
  });

  it('propõe e aplica a recuperação preservando a evidência anterior', () => {
    const transaction = seedTransaction(handle.db, {
      dueDate: '2026-01-10',
      amount: '-R$ 120,00',
      description: 'Curso (Parcela 03/10)',
      category: 'Educação',
      installmentNumber: 3,
    });

    const proposals = findInstallmentRecoveryProposals(handle.db);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      transactionId: transaction.id,
      currentNumber: 3,
      currentTotal: null,
      proposedNumber: 3,
      proposedTotal: 10,
      previous: '3',
      conflict: false,
    });

    const result = applyInstallmentRecovery(handle.db, [transaction.id]);
    expect(result).toEqual({ updated: 1, skipped: [] });

    const stored = handle.sqlite
      .prepare(
        'select installment_number, installment_total, installment_source, installment_original from transactions where id = ?',
      )
      .get(transaction.id) as {
      installment_number: number;
      installment_total: number;
      installment_source: string;
      installment_original: string;
    };
    expect(stored).toEqual({
      installment_number: 3,
      installment_total: 10,
      installment_source: 'description',
      installment_original: '3',
    });
  });

  it('não aplica propostas em conflito e permite aprovação em lote', () => {
    const first = seedTransaction(handle.db, {
      dueDate: '2026-01-10',
      amount: '-R$ 100,00',
      description: 'Curso (Parcela 01/05)',
      category: 'Educação',
    });
    const second = seedTransaction(handle.db, {
      dueDate: '2026-02-10',
      amount: '-R$ 100,00',
      description: 'Curso (Parcela 02/05)',
      category: 'Educação',
    });
    const conflicting = seedTransaction(handle.db, {
      dueDate: '2026-03-10',
      amount: '-R$ 100,00',
      description: 'Curso (Parcela 09/12)',
      category: 'Educação',
      installmentNumber: 3,
    });

    const proposals = findInstallmentRecoveryProposals(handle.db);
    expect(proposals).toHaveLength(3);
    const conflict = proposals.find((item) => item.transactionId === conflicting.id)!;
    expect(conflict.conflict).toBe(true);

    const result = applyInstallmentRecovery(handle.db, proposals.map((item) => item.transactionId));
    expect(result.updated).toBe(2);
    expect(result.skipped).toEqual([conflicting.id]);
    expect(getTransaction(handle.db, first.id).installmentTotal).toBe(5);
    expect(getTransaction(handle.db, second.id).installmentTotal).toBe(5);
    expect(getTransaction(handle.db, conflicting.id).installmentTotal).toBeNull();
  });
});

describe('conciliação retroativa de transferências', () => {
  let handle: DatabaseHandle;

  beforeEach(() => {
    handle = createTestDatabase();
  });

  afterEach(() => {
    handle.sqlite.close();
  });

  function seedPair(options: { descriptionOut?: string; descriptionIn?: string } = {}) {
    const outgoing = seedTransaction(handle.db, {
      dueDate: '2026-03-10',
      amount: '-R$ 321,00',
      description: options.descriptionOut ?? 'Saída conta A',
      category: 'Ajustes',
      payment: 'Conta A',
    });
    const incoming = seedTransaction(handle.db, {
      dueDate: '2026-03-11',
      amount: 'R$ 321,00',
      description: options.descriptionIn ?? 'Entrada conta B',
      category: 'Ajustes',
      payment: 'Conta B',
    });
    return { outgoing, incoming };
  }

  it('encontra pares entre lotes diferentes e é idempotente', () => {
    // Primeiro lote: apenas a saída.
    const first = makeCsv(
      ['10/03/2026;10/03/2026;Saída conta A;-R$ 321,00;Conta A;;Ajustes;'],
      HEADER,
    );
    const firstPreview = previewImport(handle.db, first, 'lote1.csv');
    importWorkbook(handle.db, first, 'lote1.csv', {
      mapping: firstPreview.mapping,
      skipDuplicates: true,
    });

    // Segundo lote: a entrada, sem marcação de transferência.
    const second = makeCsv(
      ['10/03/2026;11/03/2026;Entrada conta B;R$ 321,00;Conta B;;Ajustes;'],
      HEADER,
    );
    const secondPreview = previewImport(handle.db, second, 'lote2.csv');
    importWorkbook(handle.db, second, 'lote2.csv', {
      mapping: secondPreview.mapping,
      skipDuplicates: true,
    });

    const before = handle.sqlite
      .prepare('select count(*) as total from transfers')
      .get() as { total: number };
    expect(before.total).toBe(0);

    const firstRun = getReconciliation(handle.db, { toleranceDays: 3 });
    expect(firstRun.candidates).toHaveLength(1);
    expect(firstRun.candidates[0].dayDistance).toBeLessThanOrEqual(1);
    expect(firstRun.confirmed).toHaveLength(0);
    expect(firstRun.summary).toMatchObject({ candidates: 1, confirmed: 0, unmatched: 0 });

    const secondRun = getReconciliation(handle.db, { toleranceDays: 3 });
    expect(secondRun.candidates).toHaveLength(1);
    const after = handle.sqlite
      .prepare('select count(*) as total from transfers')
      .get() as { total: number };
    expect(after.total).toBe(0);
  });

  it('respeita a tolerância de datas configurada', () => {
    const outgoing = seedTransaction(handle.db, {
      dueDate: '2026-03-01',
      amount: '-R$ 777,00',
      description: 'Saída distante',
      category: 'Ajustes',
      payment: 'Conta A',
    });
    seedTransaction(handle.db, {
      dueDate: '2026-03-10',
      amount: 'R$ 777,00',
      description: 'Entrada distante',
      category: 'Ajustes',
      payment: 'Conta B',
    });

    expect(getReconciliation(handle.db, { toleranceDays: 3 }).candidates).toHaveLength(0);
    expect(getReconciliation(handle.db, { toleranceDays: 10 }).candidates).toHaveLength(1);
    expect(getTransaction(handle.db, outgoing.id).transferStatus).toBeNull();
  });

  it('marca múltiplos candidatos de mesmo valor como ambíguos', () => {
    seedTransaction(handle.db, {
      dueDate: '2026-03-10',
      amount: '-R$ 500,00',
      description: 'Saída única',
      category: 'Ajustes',
      payment: 'Conta A',
    });
    seedTransaction(handle.db, {
      dueDate: '2026-03-10',
      amount: 'R$ 500,00',
      description: 'Entrada 1',
      category: 'Ajustes',
      payment: 'Conta B',
    });
    seedTransaction(handle.db, {
      dueDate: '2026-03-11',
      amount: 'R$ 500,00',
      description: 'Entrada 2',
      category: 'Ajustes',
      payment: 'Conta C',
    });

    const result = getReconciliation(handle.db, { toleranceDays: 3 });
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates.every((candidate) => candidate.ambiguous)).toBe(true);
    expect(result.candidates.every((candidate) => candidate.confidence === 'possible')).toBe(true);
  });

  it('confirma, desvincula e volta a sugerir o par', () => {
    const { outgoing, incoming } = seedPair();
    const link = linkTransfer(handle.db, {
      outgoingTransactionId: outgoing.id,
      incomingTransactionId: incoming.id,
      confidence: 'manual',
    });

    const linked = getReconciliation(handle.db);
    expect(linked.confirmed).toHaveLength(1);
    expect(linked.candidates).toHaveLength(0);

    unlinkTransfer(handle.db, link.id);
    expect(getReconciliation(handle.db).candidates).toHaveLength(1);
  });

  it('persiste rejeição, não a repete e permite reconsiderar', () => {
    const { outgoing, incoming } = seedPair();
    rejectTransferPair(handle.db, outgoing.id, incoming.id);

    const rejected = getReconciliation(handle.db);
    expect(rejected.candidates).toHaveLength(0);
    expect(rejected.rejected).toHaveLength(1);
    expect(rejected.rejected[0].signatureMatches).toBe(true);
    expect(rejected.summary.rejected).toBe(1);

    const withRejected = getReconciliation(handle.db, { includeRejected: true });
    expect(withRejected.candidates).toHaveLength(1);

    clearTransferRejection(handle.db, outgoing.id, incoming.id);
    expect(getReconciliation(handle.db).candidates).toHaveLength(1);
  });

  it('rejeição deixa de valer quando os dados do par mudam', () => {
    const { outgoing, incoming } = seedPair();
    rejectTransferPair(handle.db, outgoing.id, incoming.id);
    updateTransaction(handle.db, outgoing.id, { description: 'Descrição alterada' });

    const result = getReconciliation(handle.db);
    expect(result.candidates).toHaveLength(1);
    expect(result.rejected[0].signatureMatches).toBe(false);
  });

  it('lista lançamentos marcados sem contraparte e remove rejeições em cascata', () => {
    const lonely = seedTransaction(handle.db, {
      dueDate: '2026-03-10',
      amount: '-R$ 888,00',
      description: 'Transferência sem par',
      category: 'Transferências',
      payment: 'Conta A',
      transfer: 'Sim',
    });

    const result = getReconciliation(handle.db);
    expect(result.unmatched.map((party) => party.transactionId)).toContain(lonely.id);

    const { outgoing, incoming } = seedPair();
    rejectTransferPair(handle.db, outgoing.id, incoming.id);
    deleteTransaction(handle.db, outgoing.id);
    const count = handle.sqlite
      .prepare('select count(*) as total from transfer_rejections')
      .get() as { total: number };
    expect(count.total).toBe(0);
  });

  it('mantém integridade referencial ao tentar rejeitar par inválido', () => {
    const outgoing = seedTransaction(handle.db, {
      dueDate: '2026-03-10',
      amount: '-R$ 100,00',
      description: 'Saída',
      category: 'Ajustes',
      payment: 'Conta A',
    });
    const incoming = seedTransaction(handle.db, {
      dueDate: '2026-03-10',
      amount: 'R$ 100,00',
      description: 'Entrada',
      category: 'Ajustes',
      payment: 'Conta A',
    });
    expect(() => rejectTransferPair(handle.db, outgoing.id, incoming.id)).toThrow(
      /outra diferente/i,
    );
    const count = handle.sqlite
      .prepare('select count(*) as total from transfer_rejections')
      .get() as { total: number };
    expect(count.total).toBe(0);
  });
});
