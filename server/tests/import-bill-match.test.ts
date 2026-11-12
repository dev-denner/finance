import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseHandle } from '../src/db/client';
import { createBill, getBill } from '../src/services/bills';
import { importWorkbook, previewImport } from '../src/services/import';
import { ensureLookup } from '../src/services/lookups';
import { createTestDatabase, makeCsv } from './helpers';

let handle: DatabaseHandle;
let categoryId: number;

beforeEach(() => {
  handle = createTestDatabase();
  categoryId = ensureLookup(handle.db, 'category', 'Contas').id;
});

afterEach(() => handle.sqlite.close());

const count = (table: string) =>
  (handle.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

function openBill(description: string, amountCents: number, dueDate: string) {
  return createBill(handle.db, { description, amountCents, dueDate, categoryId }, '2026-03-01');
}

const csv = () =>
  makeCsv([
    '09/03/2026;10/03/2026;PAG*VIVO FIBRA SA;-142,87;Conta Corrente;;Contas;',
    '11/03/2026;11/03/2026;BOLETO CONDOMINIO;-856,25;Conta Corrente;;Contas;',
    '12/03/2026;12/03/2026;Mercado Zona Sul;-90,10;Conta Corrente;;Mercado;',
  ]);

describe('importação × contas a pagar (AC14–AC16)', () => {
  it('a prévia sugere os pagamentos com confiança e motivos', () => {
    openBill('Vivo Fibra', 14287, '2026-03-08');
    openBill('Condomínio', 85625, '2026-03-10');
    const preview = previewImport(handle.db, csv(), 'extrato.csv');
    expect(preview.billCandidates.map((c) => [c.party.rowNumber, c.bill.description, c.confidence])).toEqual([
      [2, 'Vivo Fibra', 'high'],
      [3, 'Condomínio', 'high'],
    ]);
    expect(preview.billCandidates[0].key).toBe('file:2:bill:1');
    expect(count('bill_payments')).toBe(0);
  });

  it('confirmar vincula o lançamento importado à conta; rejeitar e pendente não', () => {
    const vivo = openBill('Vivo Fibra', 14287, '2026-03-08');
    const condo = openBill('Condomínio', 85625, '2026-03-10');
    const preview = previewImport(handle.db, csv(), 'extrato.csv');
    const [vivoKey, condoKey] = preview.billCandidates.map((c) => c.key);

    const summary = importWorkbook(handle.db, csv(), 'extrato.csv', {
      mapping: preview.mapping,
      billDecisions: { [vivoKey]: 'confirm', [condoKey]: 'reject' },
    });

    expect(summary).toMatchObject({
      importedRows: 3,
      billCandidates: 2,
      linkedBillPayments: 1,
      rejectedBillPayments: 1,
      pendingBillPayments: 0,
      skippedBillPayments: [],
    });
    const paid = getBill(handle.db, vivo.id);
    expect(paid).toMatchObject({ state: 'paid', paidAt: '2026-03-10', paidCents: 14287 });
    expect(paid.payments[0]).toMatchObject({ origin: 'import_match', createdTransaction: false, transactionDescription: 'PAG*VIVO FIBRA SA' });
    expect(getBill(handle.db, condo.id).state).toBe('open');
    expect(count('bill_payments')).toBe(1);
  });

  it('sem decisões nada é vinculado, nem as de alta confiança', () => {
    openBill('Vivo Fibra', 14287, '2026-03-08');
    const preview = previewImport(handle.db, csv(), 'extrato.csv');
    const summary = importWorkbook(handle.db, csv(), 'extrato.csv', { mapping: preview.mapping });
    expect(summary).toMatchObject({ linkedBillPayments: 0, pendingBillPayments: 1 });
    expect(count('bill_payments')).toBe(0);
  });

  it('conta já paga não é candidata e conflito de confirmações é recusado sem gravar', () => {
    const paid = openBill('Vivo Fibra', 14287, '2026-03-08');
    handle.sqlite.prepare("UPDATE scheduled_bills SET state = 'paid', paid_at = due_date, paid_cents = amount_cents WHERE id = ?").run(paid.id);
    expect(previewImport(handle.db, csv(), 'extrato.csv').billCandidates).toEqual([]);

    openBill('Vivo Fibra casa', 14287, '2026-03-09');
    openBill('Vivo Fibra escritório', 14287, '2026-03-11');
    const preview = previewImport(handle.db, csv(), 'extrato.csv');
    expect(preview.billCandidates).toHaveLength(2);
    expect(preview.billCandidates.every((c) => c.ambiguous)).toBe(true);
    const decisions = Object.fromEntries(preview.billCandidates.map((c) => [c.key, 'confirm' as const]));
    expect(() => importWorkbook(handle.db, csv(), 'extrato.csv', { mapping: preview.mapping, billDecisions: decisions })).toThrow(
      /inconsistentes/,
    );
    expect(count('transactions')).toBe(0);
  });

  it('linha duplicada não importada e sugestão desatualizada aparecem como puladas, com motivo', () => {
    openBill('Vivo Fibra', 14287, '2026-03-08');
    const first = previewImport(handle.db, csv(), 'extrato.csv');
    importWorkbook(handle.db, csv(), 'extrato.csv', { mapping: first.mapping });

    const again = previewImport(handle.db, csv(), 'extrato.csv');
    const key = again.billCandidates[0].key;
    const summary = importWorkbook(handle.db, csv(), 'extrato.csv', {
      mapping: again.mapping,
      skipDuplicates: true,
      billDecisions: { [key]: 'confirm', 'file:9:bill:99': 'confirm' },
    });
    expect(summary.linkedBillPayments).toBe(0);
    expect(summary.skippedBillPayments).toEqual([
      { rowNumber: 9, billDescription: '', reason: expect.stringMatching(/não vale mais/) },
      { rowNumber: 2, billDescription: 'Vivo Fibra', reason: 'A linha não foi importada (duplicada ou rejeitada).' },
    ]);
    expect(count('bill_payments')).toBe(0);
  });

  it('linha que virou transferência não paga conta; o motivo vai para o resumo', () => {
    openBill('Reserva mensal', 10000, '2026-03-10');
    const transfers = makeCsv([
      '10/03/2026;10/03/2026;Transferência para Conta B;-100,00;Conta A;;Transferência;Sim',
      '10/03/2026;10/03/2026;Transferência de Conta A;100,00;Conta B;;Transferência;Sim',
    ]);
    const preview = previewImport(handle.db, transfers, 'transf.csv');
    expect(preview.transferCandidates).toHaveLength(1);
    expect(preview.billCandidates).toHaveLength(1);

    const summary = importWorkbook(handle.db, transfers, 'transf.csv', {
      mapping: preview.mapping,
      transferDecisions: { [preview.transferCandidates[0].key]: 'confirm' },
      billDecisions: { [preview.billCandidates[0].key]: 'confirm' },
    });
    expect(summary.confirmedTransfers).toBe(1);
    expect(summary.linkedBillPayments).toBe(0);
    expect(summary.skippedBillPayments).toEqual([
      { rowNumber: 2, billDescription: 'Reserva mensal', reason: 'A linha foi vinculada como transferência.' },
    ]);
  });
});
