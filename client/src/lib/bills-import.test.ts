import { describe, expect, it } from 'vitest';
import { importableRows } from './bills-import';
import type { BillImportPreviewRow } from './types';

function row(rowNumber: number, overrides: Partial<BillImportPreviewRow> = {}): BillImportPreviewRow {
  return {
    rowNumber,
    raw: {},
    values: { description: 'Conta', amountCents: 1000, dueDate: '2026-12-10', status: '', category: 'Moradia', recurrence: null },
    errors: [],
    duplicate: false,
    ...overrides,
  };
}

describe('importação de contas — o que será gravado', () => {
  it('tira linhas com erro, deixadas de fora e, se pedido, as duplicadas; conta as recorrências', () => {
    const recurrence = { frequency: 'monthly' as const, interval: 1, lastBusinessDay: false, occurrenceCount: null, label: 'Mensal, dia 10' };
    const preview = {
      rows: [
        row(2, { values: { ...row(2).values, recurrence } }),
        row(3, { errors: ['Valor: informe o valor.'] }),
        row(4, { duplicate: true }),
        row(5),
      ],
    };
    expect(importableRows(preview, new Set(), true)).toEqual({ total: 2, recurring: 1 });
    expect(importableRows(preview, new Set(), false)).toEqual({ total: 3, recurring: 1 });
    expect(importableRows(preview, new Set([2]), true)).toEqual({ total: 1, recurring: 0 });
    expect(importableRows(null, new Set(), true)).toEqual({ total: 0, recurring: 0 });
  });
});
