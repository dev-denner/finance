import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseHandle } from '../src/db/client';
import { importWorkbook, previewImport } from '../src/services/import';
import {
  detectTransferCandidates,
  type TransferParty,
} from '../src/services/transfer-detection';
import { listTransactions } from '../src/services/transactions';
import { createTestDatabase, makeCsv } from './helpers';

const HEADER = 'Data Compra;Vencimento;Compra;Valor;Pagamento;Parcelas;Categorias;Transf';

function party(overrides: Partial<TransferParty> & { key: string; amountCents: number }): TransferParty {
  const source = overrides.source ?? 'file';
  return {
    key: overrides.key,
    source,
    rowNumber: overrides.rowNumber ?? (source === 'database' ? null : 1),
    transactionId: overrides.transactionId ?? (source === 'database' ? 1 : null),
    dueDate: overrides.dueDate ?? '2026-01-10',
    purchaseDate: overrides.purchaseDate ?? overrides.dueDate ?? '2026-01-10',
    description: overrides.description ?? 'Lançamento',
    amountCents: overrides.amountCents,
    paymentMethod: overrides.paymentMethod ?? 'Conta A',
    transfer: overrides.transfer ?? null,
  };
}

describe('detecção de transferências', () => {
  it('identifica pares com sinais opostos e marcação dupla como alta confiança', () => {
    const candidates = detectTransferCandidates([
      party({
        key: 'file:1',
        rowNumber: 1,
        amountCents: -50000,
        description: 'Transferência enviada',
        transfer: 'Sim',
        paymentMethod: 'CD Inter',
      }),
      party({
        key: 'file:2',
        rowNumber: 2,
        amountCents: 50000,
        description: 'Transferência recebida',
        transfer: 'Sim',
        paymentMethod: 'CD Nubank',
      }),
    ]);

    expect(candidates).toHaveLength(1);
    expect(candidates[0].confidence).toBe('high');
    expect(candidates[0].ambiguous).toBe(false);
    expect(candidates[0].reasons.join(' ')).toMatch(/Valor absoluto igual/i);
    expect(candidates[0].reasons.join(' ')).toMatch(/Sinais opostos/i);
  });

  it('reconhece transferências com descrições diferentes (PIX/TED)', () => {
    const candidates = detectTransferCandidates([
      party({
        key: 'file:1',
        amountCents: -25000,
        description: 'Envio por transferência',
        paymentMethod: 'Banco X',
      }),
      party({
        key: 'file:2',
        amountCents: 25000,
        description: 'Recebimento PIX',
        paymentMethod: 'Banco Y',
      }),
    ]);

    expect(candidates).toHaveLength(1);
    expect(candidates[0].confidence).toBe('high');
  });

  it('aceita datas próximas dentro da tolerância com evidência adicional', () => {
    const candidates = detectTransferCandidates([
      party({
        key: 'file:1',
        amountCents: -8000,
        dueDate: '2026-01-10',
        description: 'Saída de conta',
        transfer: 'Sim',
        paymentMethod: 'Conta A',
      }),
      party({
        key: 'file:2',
        amountCents: 8000,
        dueDate: '2026-01-12',
        description: 'Recebimento PIX',
        paymentMethod: 'Conta B',
      }),
    ]);

    expect(candidates).toHaveLength(1);
    expect(candidates[0].dayDistance).toBe(2);
    expect(candidates[0].confidence).toBe('high');
  });

  it('ignora pares fora da tolerância de datas', () => {
    const candidates = detectTransferCandidates([
      party({
        key: 'file:1',
        amountCents: -8000,
        dueDate: '2026-01-10',
        transfer: 'Sim',
        paymentMethod: 'Conta A',
      }),
      party({
        key: 'file:2',
        amountCents: 8000,
        dueDate: '2026-01-14',
        transfer: 'Sim',
        paymentMethod: 'Conta B',
      }),
    ]);

    expect(candidates).toHaveLength(0);
  });

  it('marca como possível quando há múltiplos pares candidatos (ambíguo)', () => {
    const candidates = detectTransferCandidates([
      party({
        key: 'file:1',
        amountCents: -50000,
        description: 'Transferência enviada',
        transfer: 'Sim',
        paymentMethod: 'Conta A',
      }),
      party({
        key: 'file:2',
        amountCents: 50000,
        description: 'Transferência recebida 1',
        transfer: 'Sim',
        paymentMethod: 'Conta B',
      }),
      party({
        key: 'file:3',
        amountCents: 50000,
        description: 'Transferência recebida 2',
        transfer: 'Sim',
        paymentMethod: 'Conta C',
      }),
    ]);

    expect(candidates).toHaveLength(2);
    expect(candidates.every((candidate) => candidate.ambiguous)).toBe(true);
    expect(candidates.every((candidate) => candidate.confidence === 'possible')).toBe(true);
    expect(candidates[0].reasons.join(' ')).toMatch(/Múltiplos pares candidatos/i);
  });

  it('não forma pares entre dois lançamentos já existentes no banco', () => {
    const candidates = detectTransferCandidates([
      party({
        key: 'db:1',
        source: 'database',
        transactionId: 1,
        amountCents: -50000,
        transfer: 'Sim',
        paymentMethod: 'Conta A',
      }),
      party({
        key: 'db:2',
        source: 'database',
        transactionId: 2,
        amountCents: 50000,
        transfer: 'Sim',
        paymentMethod: 'Conta B',
      }),
    ]);

    expect(candidates).toHaveLength(0);
  });

  describe('integração com a importação (entre lotes)', () => {
    let handle: DatabaseHandle;

    beforeEach(() => {
      handle = createTestDatabase();
    });

    afterEach(() => {
      handle.sqlite.close();
    });

    function importFirstBatch() {
      const file = makeCsv(
        ['10/01/2026;10/01/2026;Transferência enviada;-R$ 500,00;CD Inter DJC;;Transferências;Sim'],
        HEADER,
      );
      const preview = previewImport(handle.db, file, 'lote1.csv');
      const summary = importWorkbook(handle.db, file, 'lote1.csv', {
        mapping: preview.mapping,
        skipDuplicates: true,
      });
      expect(summary.confirmedTransfers).toBe(0);
      return file;
    }

    it('identifica e vincula automaticamente um par entre lotes diferentes', () => {
      importFirstBatch();

      const second = makeCsv(
        ['10/01/2026;10/01/2026;Transferência recebida;R$ 500,00;CD Nubank Denner;;Transferências;Sim'],
        HEADER,
      );
      const preview = previewImport(handle.db, second, 'lote2.csv');
      expect(preview.transferCandidates).toHaveLength(1);
      expect(preview.transferCandidates[0].confidence).toBe('high');

      const summary = importWorkbook(handle.db, second, 'lote2.csv', {
        mapping: preview.mapping,
        skipDuplicates: true,
      });
      expect(summary.confirmedTransfers).toBe(1);
      expect(summary.pendingTransfers).toBe(0);
      expect(summary.rejectedTransfers).toBe(0);

      const count = handle.sqlite
        .prepare('select count(*) as total from transfers')
        .get() as { total: number };
      expect(count.total).toBe(1);

      const transfers = listTransactions(handle.db, {
        dateField: 'due',
        kind: 'transfers',
        sortBy: 'dueDate',
        sortDir: 'asc',
        page: 1,
        pageSize: 25,
      });
      expect(transfers.total).toBe(2);
      expect(transfers.rows.every((row) => row.transferStatus === 'confirmed')).toBe(true);
    });

    it('respeita a decisão de rejeitar o par antes de importar', () => {
      importFirstBatch();

      const second = makeCsv(
        ['10/01/2026;10/01/2026;Transferência recebida;R$ 500,00;CD Nubank Denner;;Transferências;Sim'],
        HEADER,
      );
      const preview = previewImport(handle.db, second, 'lote2.csv');
      const candidateKey = preview.transferCandidates[0].key;

      const summary = importWorkbook(handle.db, second, 'lote2.csv', {
        mapping: preview.mapping,
        skipDuplicates: true,
        transferDecisions: { [candidateKey]: 'reject' },
      });

      expect(summary.confirmedTransfers).toBe(0);
      expect(summary.rejectedTransfers).toBe(1);
      const count = handle.sqlite
        .prepare('select count(*) as total from transfers')
        .get() as { total: number };
      expect(count.total).toBe(0);
    });

    it('mantém o par pendente e sem vínculo quando o usuário não decide', () => {
      importFirstBatch();

      const second = makeCsv(
        ['10/01/2026;10/01/2026;Transferência recebida;R$ 500,00;CD Nubank Denner;;Transferências;Sim'],
        HEADER,
      );
      const preview = previewImport(handle.db, second, 'lote2.csv');
      const candidateKey = preview.transferCandidates[0].key;

      const summary = importWorkbook(handle.db, second, 'lote2.csv', {
        mapping: preview.mapping,
        skipDuplicates: true,
        transferDecisions: { [candidateKey]: 'pending' },
      });

      expect(summary.confirmedTransfers).toBe(0);
      expect(summary.pendingTransfers).toBe(1);
      const count = handle.sqlite
        .prepare('select count(*) as total from transfers')
        .get() as { total: number };
      expect(count.total).toBe(0);
    });
  });
});
