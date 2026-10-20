import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseHandle } from '../src/db/client';
import { getAnnualConsolidation } from '../src/services/consolidation';
import { createLookup, listLookups } from '../src/services/lookups';
import {
  bulkDeleteTransactions,
  bulkUpdateTransactions,
  deleteTransaction,
  getTransaction,
  listTransactions,
  updateTransaction,
} from '../src/services/transactions';
import { linkTransfer, unlinkTransfer } from '../src/services/transfers';
import { detectCandidatesForTransaction } from '../src/services/transfer-detection';
import { createTestDatabase, seedTransaction } from './helpers';

describe('transferências entre contas', () => {
  let handle: DatabaseHandle;

  beforeEach(() => {
    handle = createTestDatabase();
  });

  afterEach(() => {
    handle.sqlite.close();
  });

  function seedPair(options: { transferMarker?: string | null; withExpense?: boolean } = {}) {
    const marker = options.transferMarker ?? null;
    const outgoing = seedTransaction(handle.db, {
      dueDate: '2026-03-10',
      amount: '-R$ 500,00',
      description: 'Transferência enviada',
      category: 'Transferências',
      payment: 'Conta A',
      transfer: marker,
    });
    const incoming = seedTransaction(handle.db, {
      dueDate: '2026-03-10',
      amount: 'R$ 500,00',
      description: 'Transferência recebida',
      category: 'Transferências',
      payment: 'Conta B',
      transfer: marker,
    });
    return { outgoing, incoming };
  }

  it('vincula uma saída e uma entrada e expõe o estado derivado', () => {
    const { outgoing, incoming } = seedPair();
    const link = linkTransfer(handle.db, {
      outgoingTransactionId: outgoing.id,
      incomingTransactionId: incoming.id,
      confidence: 'manual',
    });

    expect(link.id).toBeGreaterThan(0);
    expect(link.outgoingTransactionId).toBe(outgoing.id);
    expect(link.incomingTransactionId).toBe(incoming.id);

    const out = getTransaction(handle.db, outgoing.id);
    expect(out.transferStatus).toBe('confirmed');
    expect(out.transferLink).toMatchObject({
      direction: 'out',
      sourceAccount: 'Conta A',
      destinationAccount: 'Conta B',
    });
    expect(out.transferLink?.counterpart.id).toBe(incoming.id);

    const incomingDto = getTransaction(handle.db, incoming.id);
    expect(incomingDto.transferStatus).toBe('confirmed');
    expect(incomingDto.transferLink?.direction).toBe('in');
    expect(incomingDto.transferLink?.counterpart.id).toBe(outgoing.id);

    const count = handle.sqlite
      .prepare('select count(*) as total from transfers')
      .get() as { total: number };
    expect(count.total).toBe(1);
  });

  it('oferece candidatos para vínculo manual entre lançamentos já existentes', () => {
    const { outgoing, incoming } = seedPair();

    const candidates = detectCandidatesForTransaction(handle.db, outgoing.id);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].outgoing.transactionId).toBe(outgoing.id);
    expect(candidates[0].incoming.transactionId).toBe(incoming.id);
    expect(candidates[0].reasons.join(' ')).toMatch(/Sinais opostos/i);

    linkTransfer(handle.db, {
      outgoingTransactionId: outgoing.id,
      incomingTransactionId: incoming.id,
    });

    // Já vinculado: não deve mais aparecer como candidato.
    expect(detectCandidatesForTransaction(handle.db, outgoing.id)).toHaveLength(0);
  });

  it('impede que um lançamento participe de duas transferências', () => {
    const { outgoing, incoming } = seedPair();
    linkTransfer(handle.db, {
      outgoingTransactionId: outgoing.id,
      incomingTransactionId: incoming.id,
    });

    const other = seedTransaction(handle.db, {
      dueDate: '2026-03-11',
      amount: 'R$ 500,00',
      description: 'Outra entrada',
      category: 'Transferências',
      payment: 'Conta C',
    });

    expect(() =>
      linkTransfer(handle.db, {
        outgoingTransactionId: outgoing.id,
        incomingTransactionId: other.id,
      }),
    ).toThrow(/já participa/i);
  });

  it('protege vínculos duplicados no próprio banco (triggers)', () => {
    const { outgoing, incoming } = seedPair();
    linkTransfer(handle.db, {
      outgoingTransactionId: outgoing.id,
      incomingTransactionId: incoming.id,
    });
    const other = seedTransaction(handle.db, {
      dueDate: '2026-03-11',
      amount: 'R$ 500,00',
      description: 'Outra entrada',
      category: 'Transferências',
      payment: 'Conta C',
    });

    expect(() =>
      handle.sqlite
        .prepare(
          'insert into transfers (outgoing_transaction_id, incoming_transaction_id, confidence, origin) values (?, ?, ?, ?)',
        )
        .run(outgoing.id, other.id, 'manual', 'manual'),
    ).toThrow(/already linked|constraint/i);

    // Par com mesma conta é rejeitado pelo banco mesmo fora do serviço.
    const sameOut = seedTransaction(handle.db, {
      dueDate: '2026-03-12',
      amount: '-R$ 100,00',
      description: 'Saída mesma conta',
      category: 'Transferências',
      payment: 'Conta D',
    });
    const sameIn = seedTransaction(handle.db, {
      dueDate: '2026-03-12',
      amount: 'R$ 100,00',
      description: 'Entrada mesma conta',
      category: 'Transferências',
      payment: 'Conta D',
    });
    expect(() =>
      handle.sqlite
        .prepare(
          'insert into transfers (outgoing_transaction_id, incoming_transaction_id, confidence, origin) values (?, ?, ?, ?)',
        )
        .run(sameOut.id, sameIn.id, 'manual', 'manual'),
    ).toThrow(/invalid transfer pair/i);
  });

  it('valida sinais, módulo e contas diferentes', () => {
    const outgoing = seedTransaction(handle.db, {
      dueDate: '2026-03-10',
      amount: '-R$ 500,00',
      description: 'Saída',
      category: 'Transferências',
      payment: 'Conta A',
    });
    const incoming = seedTransaction(handle.db, {
      dueDate: '2026-03-10',
      amount: 'R$ 500,00',
      description: 'Entrada',
      category: 'Transferências',
      payment: 'Conta B',
    });

    const sameAccount = seedTransaction(handle.db, {
      dueDate: '2026-03-10',
      amount: 'R$ 500,00',
      description: 'Entrada mesma conta',
      category: 'Transferências',
      payment: 'Conta A',
    });
    expect(() =>
      linkTransfer(handle.db, {
        outgoingTransactionId: outgoing.id,
        incomingTransactionId: sameAccount.id,
      }),
    ).toThrow(/outra diferente/i);

    // Sinais invertidos: a ponta de saída precisa ser negativa.
    expect(() =>
      linkTransfer(handle.db, {
        outgoingTransactionId: incoming.id,
        incomingTransactionId: outgoing.id,
      }),
    ).toThrow(/valor negativo/i);

    // Uma entrada negativa também é rejeitada.
    const anotherNegative = seedTransaction(handle.db, {
      dueDate: '2026-03-10',
      amount: '-R$ 90,00',
      description: 'Outra saída',
      category: 'Transferências',
      payment: 'Conta B',
    });
    expect(() =>
      linkTransfer(handle.db, {
        outgoingTransactionId: outgoing.id,
        incomingTransactionId: anotherNegative.id,
      }),
    ).toThrow(/valor positivo/i);

    const differentAmount = seedTransaction(handle.db, {
      dueDate: '2026-03-10',
      amount: 'R$ 300,00',
      description: 'Entrada valor diferente',
      category: 'Transferências',
      payment: 'Conta B',
    });
    expect(() =>
      linkTransfer(handle.db, {
        outgoingTransactionId: outgoing.id,
        incomingTransactionId: differentAmount.id,
      }),
    ).toThrow(/mesmo módulo/i);

    linkTransfer(handle.db, {
      outgoingTransactionId: outgoing.id,
      incomingTransactionId: incoming.id,
    });
  });

  it('bloqueia exclusão e alteração que invalidem o par confirmado', () => {
    const { outgoing, incoming } = seedPair();
    linkTransfer(handle.db, {
      outgoingTransactionId: outgoing.id,
      incomingTransactionId: incoming.id,
    });

    expect(() => deleteTransaction(handle.db, outgoing.id)).toThrow(/Desvincule/i);
    expect(() => bulkDeleteTransactions(handle.db, [outgoing.id, incoming.id])).toThrow(
      /Desvincule/i,
    );

    expect(() =>
      updateTransaction(handle.db, outgoing.id, { amount: '-R$ 600,00' }),
    ).toThrow(/Desvincule/i);

    const incomingPayment = handle.sqlite
      .prepare('select payment_method_id as id from transactions where id = ?')
      .get(incoming.id) as { id: number };
    expect(() =>
      updateTransaction(handle.db, outgoing.id, { paymentMethodId: incomingPayment.id }),
    ).toThrow(/Desvincule/i);

    // Alterar apenas a descrição mantém o par válido.
    const renamed = updateTransaction(handle.db, outgoing.id, { description: 'Saída editada' });
    expect(renamed.description).toBe('Saída editada');
    expect(renamed.transferStatus).toBe('confirmed');

    unlinkTransfer(handle.db, getTransaction(handle.db, outgoing.id).transferLink!.id);
    expect(() => deleteTransaction(handle.db, outgoing.id)).not.toThrow();
  });

  it('bloqueia troca de pagamento em massa que una as duas pontas', () => {
    const { outgoing, incoming } = seedPair();
    linkTransfer(handle.db, {
      outgoingTransactionId: outgoing.id,
      incomingTransactionId: incoming.id,
    });

    const contaA = listLookups(handle.db, 'payment').find((item) => item.name === 'Conta A')!;
    const contaB = listLookups(handle.db, 'payment').find((item) => item.name === 'Conta B')!;
    const contaC = createLookup(handle.db, 'payment', 'Conta C');

    expect(() =>
      bulkUpdateTransactions(handle.db, [outgoing.id, incoming.id], { paymentMethodId: contaC.id }),
    ).toThrow(/mesma conta/i);

    expect(() =>
      bulkUpdateTransactions(handle.db, [outgoing.id], { paymentMethodId: contaB.id }),
    ).toThrow(/mesma conta/i);

    // Mudar apenas uma ponta para uma conta diferente das duas mantém o par.
    expect(
      bulkUpdateTransactions(handle.db, [outgoing.id], { paymentMethodId: contaC.id }),
    ).toBe(1);
    expect(getTransaction(handle.db, outgoing.id).transferStatus).toBe('confirmed');
    expect(contaA.id).not.toBe(contaC.id);
  });

  it('preserva a marcação original do arquivo ao desvincular', () => {
    const { outgoing, incoming } = seedPair({ transferMarker: 'Sim' });
    const link = linkTransfer(handle.db, {
      outgoingTransactionId: outgoing.id,
      incomingTransactionId: incoming.id,
      origin: 'import',
    });

    unlinkTransfer(handle.db, link.id);

    const stored = handle.sqlite
      .prepare('select transfer from transactions where id = ?')
      .get(outgoing.id) as { transfer: string | null };
    expect(stored.transfer).toBe('Sim');

    const dto = getTransaction(handle.db, outgoing.id);
    expect(dto.transferStatus).toBe('unconfirmed');
    expect(dto.transferLink).toBeNull();
    expect(() => unlinkTransfer(handle.db, link.id)).toThrow(/não encontrada/i);
  });

  it('exclui transferências confirmadas dos totais de receitas e despesas', () => {
    const { outgoing, incoming } = seedPair();
    seedTransaction(handle.db, {
      dueDate: '2026-03-05',
      amount: '-R$ 100,00',
      description: 'Mercado',
      category: 'Mercado',
      payment: 'Pix',
    });
    seedTransaction(handle.db, {
      dueDate: '2026-03-01',
      amount: 'R$ 1.000,00',
      description: 'Salário',
      category: 'Salário',
      payment: 'Pix',
    });
    linkTransfer(handle.db, {
      outgoingTransactionId: outgoing.id,
      incomingTransactionId: incoming.id,
    });

    const all = listTransactions(handle.db, {
      dateField: 'due',
      kind: 'all',
      sortBy: 'dueDate',
      sortDir: 'asc',
      page: 1,
      pageSize: 25,
    });
    expect(all.summary.expenseCents).toBe(10000);
    expect(all.summary.incomeCents).toBe(100000);

    const expenses = listTransactions(handle.db, {
      dateField: 'due',
      kind: 'expenses',
      sortBy: 'dueDate',
      sortDir: 'asc',
      page: 1,
      pageSize: 25,
    });
    expect(expenses.total).toBe(1);
    expect(expenses.rows[0].description).toBe('Mercado');

    const transfers = listTransactions(handle.db, {
      dateField: 'due',
      kind: 'transfers',
      sortBy: 'dueDate',
      sortDir: 'asc',
      page: 1,
      pageSize: 25,
    });
    expect(transfers.total).toBe(2);

    const annualExpenses = getAnnualConsolidation(handle.db, 2026, 'due', 'expenses');
    expect(annualExpenses.categories.map((row) => row.categoryName)).not.toContain(
      'Transferências',
    );
    expect(annualExpenses.totals.totalCents).toBe(10000);

    const annualIncome = getAnnualConsolidation(handle.db, 2026, 'due', 'income');
    expect(annualIncome.categories.map((row) => row.categoryName)).not.toContain('Transferências');
    expect(annualIncome.totals.totalCents).toBe(100000);

    const annualTransfers = getAnnualConsolidation(handle.db, 2026, 'due', 'transfers');
    expect(annualTransfers.categories.map((row) => row.categoryName)).toContain('Transferências');
  });
});
