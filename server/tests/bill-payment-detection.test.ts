import { describe, expect, it } from 'vitest';
import {
  confirmedBillCandidates,
  descriptionSimilarity,
  detectBillPaymentCandidates,
  loadOpenBillsForMatch,
  type OpenBillForMatch,
} from '../src/services/bill-payment-detection';
import { createBill, createTemplate, payBill } from '../src/services/bills';
import { ensureLookup } from '../src/services/lookups';
import type { TransferParty } from '../src/services/transfer-detection';
import { createTestDatabase } from './helpers';

function party(rowNumber: number, overrides: Partial<TransferParty> = {}): TransferParty {
  return {
    key: `file:${rowNumber}`,
    source: 'file',
    rowNumber,
    transactionId: null,
    dueDate: '2026-03-10',
    purchaseDate: '2026-03-10',
    description: 'PAG*VIVO FIBRA SA',
    amountCents: -14287,
    paymentMethod: 'Conta Corrente',
    transfer: null,
    ...overrides,
  };
}

function bill(id: number, overrides: Partial<OpenBillForMatch> = {}): OpenBillForMatch {
  return {
    id,
    description: 'Vivo Fibra',
    amountCents: 14287,
    dueDate: '2026-03-08',
    categoryName: 'TV / Internet / Telefone',
    amountMinCents: null,
    amountMaxCents: null,
    ...overrides,
  };
}

describe('detecção de pagamento de contas (AC14, AC15)', () => {
  it('valor igual, data próxima e descrição parecida → alta confiança com motivos', () => {
    const [candidate] = detectBillPaymentCandidates([party(2)], [bill(1)]);
    expect(candidate).toMatchObject({
      key: 'file:2:bill:1',
      confidence: 'high',
      ambiguous: false,
      dayDistance: 2,
      amountDiffCents: 0,
      bill: { id: 1, description: 'Vivo Fibra' },
    });
    expect(candidate.reasons).toEqual(['Valor igual ao previsto (R$ 142,87)', 'A 2 dia(s) do vencimento', 'Descrição parecida']);
  });

  it('valor igual e data próxima com descrição diferente → possível', () => {
    const [candidate] = detectBillPaymentCandidates([party(2, { description: 'Mercado Zona Sul' })], [bill(1)]);
    expect(candidate.confidence).toBe('possible');
    expect(candidate.reasons).toContain('Descrição diferente');
  });

  it('fora da tolerância, valor diferente ou entrada não geram candidato', () => {
    expect(detectBillPaymentCandidates([party(2, { dueDate: '2026-03-20', purchaseDate: '2026-03-20' })], [bill(1)])).toEqual([]);
    expect(detectBillPaymentCandidates([party(2, { amountCents: -14288 })], [bill(1)])).toEqual([]);
    expect(detectBillPaymentCandidates([party(2, { amountCents: 14287 })], [bill(1)])).toEqual([]);
  });

  it('usa a data mais próxima entre compra e vencimento da linha; tolerância configurável', () => {
    const late = party(2, { purchaseDate: '2026-03-09', dueDate: '2026-04-15' });
    expect(detectBillPaymentCandidates([late], [bill(1)])[0].dayDistance).toBe(1);
    expect(detectBillPaymentCandidates([party(2, { dueDate: '2026-03-14', purchaseDate: '2026-03-14' })], [bill(1)], { toleranceDays: 3 })).toEqual([]);
  });

  it('conta de valor variável casa dentro da faixa do template, sempre como possível', () => {
    const light = bill(1, { description: 'Light Energia', amountCents: 38405, amountMinCents: 30000, amountMaxCents: 45000 });
    const [candidate] = detectBillPaymentCandidates([party(2, { description: 'LIGHT SERVICOS', amountCents: -41210 })], [light]);
    expect(candidate).toMatchObject({ confidence: 'possible', amountDiffCents: 2805 });
    expect(candidate.reasons[0]).toMatch(/faixa prevista/);
  });

  it('linha com duas contas ou conta com duas linhas → ambíguo (AC15)', () => {
    const twoBills = detectBillPaymentCandidates([party(2)], [bill(1), bill(2, { description: 'Vivo Fibra casa' })]);
    expect(twoBills).toHaveLength(2);
    expect(twoBills.every((candidate) => candidate.ambiguous)).toBe(true);

    const twoRows = detectBillPaymentCandidates([party(2), party(3)], [bill(1)]);
    expect(twoRows.every((candidate) => candidate.ambiguous)).toBe(true);
    expect(twoRows[0].reasons.at(-1)).toMatch(/escolha manualmente/);
  });

  it('semelhança ignora palavras de extrato e mede a presença dos termos da conta', () => {
    expect(descriptionSimilarity('Vivo Fibra', 'PAG*VIVO FIBRA SA')).toBe(1);
    expect(descriptionSimilarity('Condomínio', 'BOLETO CONDOMINIO ED. AZUL')).toBe(1);
    expect(descriptionSimilarity('Bradesco Saúde', 'DEB AUT BRADESCO SAUDE')).toBe(1);
    expect(descriptionSimilarity('Vivo Fibra', 'Mercado Zona Sul')).toBe(0);
    expect(descriptionSimilarity('', 'x')).toBe(0);
  });

  it('decisões confirmadas não podem repetir linha nem conta', () => {
    const candidates = detectBillPaymentCandidates([party(2), party(3)], [bill(1)]);
    expect(confirmedBillCandidates(candidates, { [candidates[0].key]: 'confirm' }).conflicts).toEqual([]);
    const both = confirmedBillCandidates(candidates, { [candidates[0].key]: 'confirm', [candidates[1].key]: 'confirm' });
    expect(both.conflicts).toEqual(['A conta "Vivo Fibra" foi confirmada para mais de uma linha.']);
  });
});

describe('contas candidatas no banco', () => {
  it('só ocorrências em aberto, sem pagamento, na janela das datas; com faixa do template', () => {
    const handle = createTestDatabase();
    const db = handle.db;
    const category = ensureLookup(db, 'category', 'Contas');
    const open = createBill(db, { description: 'Água', amountCents: 9000, dueDate: '2026-03-10', categoryId: category.id }, '2026-03-01');
    const paid = createBill(db, { description: 'Gás', amountCents: 5000, dueDate: '2026-03-11', categoryId: category.id }, '2026-03-01');
    payBill(db, paid.id, { mode: 'external', paidAt: '2026-03-11', paidCents: 5000 }, '2026-03-01');
    createBill(db, { description: 'Longe', amountCents: 100, dueDate: '2026-06-10', categoryId: category.id }, '2026-03-01');
    createTemplate(
      db,
      {
        description: 'Luz',
        amountCents: 38000,
        amountMinCents: 30000,
        amountMaxCents: 45000,
        categoryId: category.id,
        recurrence: { frequency: 'monthly', interval: 1, dayOfMonth: 12 },
        startDate: '2026-03-12',
        occurrenceCount: 1,
      },
      '2026-03-01',
    );

    const bills = loadOpenBillsForMatch(db, [party(2, { dueDate: '2026-03-09', purchaseDate: '2026-03-09' })], 5);
    expect(bills.map((b) => b.description).sort()).toEqual(['Luz', 'Água']);
    expect(bills.find((b) => b.description === 'Luz')).toMatchObject({ amountMinCents: 30000, amountMaxCents: 45000 });
    expect(bills.find((b) => b.id === open.id)?.amountMinCents).toBeNull();
    expect(loadOpenBillsForMatch(db, [])).toEqual([]);
    handle.sqlite.close();
  });
});
