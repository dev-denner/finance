import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseHandle } from '../src/db/client';
import { buildApp } from '../src/app';
import { bulkPayBills, bulkSkipBills, createBill, getBill, payBill, skipBill } from '../src/services/bills';
import { ensureLookup } from '../src/services/lookups';
import { createTestDatabase } from './helpers';

const TODAY = '2026-03-05';
let handle: DatabaseHandle;
let categoryId: number;

beforeEach(() => {
  handle = createTestDatabase();
  categoryId = ensureLookup(handle.db, 'category', 'Contas').id;
});

afterEach(() => handle.sqlite.close());

const count = (table: string) =>
  (handle.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

function bill(description: string, amountCents = 10000, dueDate = '2026-03-10') {
  return createBill(handle.db, { description, amountCents, dueDate, categoryId }, TODAY);
}

describe('contas — ações em massa', () => {
  it('pagar em massa quita cada conta pelo valor que falta, sem lançamento', () => {
    const light = bill('Luz', 18000);
    const water = bill('Água', 9000);
    payBill(handle.db, water.id, { mode: 'external', paidAt: '2026-03-01', paidCents: 4000, partial: true }, TODAY);

    const result = bulkPayBills(handle.db, [light.id, water.id, light.id], { paidAt: '2026-03-04' }, TODAY);
    expect(result).toEqual({ updated: 2, paidCents: 18000 + 5000 });

    expect(getBill(handle.db, light.id, TODAY)).toMatchObject({ state: 'paid', paidAt: '2026-03-04', paidCents: 18000 });
    const paidWater = getBill(handle.db, water.id, TODAY);
    expect(paidWater).toMatchObject({ state: 'paid', paidAt: '2026-03-04', paidCents: 9000, partialPaidCents: 0 });
    expect(paidWater.payments.map((payment) => payment.amountCents)).toEqual([4000, 5000]);
    expect(count('transactions')).toBe(0);
  });

  it('é tudo ou nada: uma conta já paga impede o lote e o erro cita a conta', () => {
    const open = bill('Internet');
    const paid = bill('Telefone');
    payBill(handle.db, paid.id, { mode: 'external', paidAt: TODAY, paidCents: 10000 }, TODAY);

    expect(() => bulkPayBills(handle.db, [open.id, paid.id], { paidAt: TODAY }, TODAY)).toThrow(/“Telefone” já está paga/);
    expect(getBill(handle.db, open.id, TODAY)).toMatchObject({ state: 'open', payments: [] });
    expect(count('bill_payments')).toBe(1);

    expect(() => bulkPayBills(handle.db, [open.id, 999], { paidAt: TODAY }, TODAY)).toThrow(/não encontrada/);
    expect(() => bulkPayBills(handle.db, [], { paidAt: TODAY }, TODAY)).toThrow(/ao menos uma/);
    expect(() => bulkPayBills(handle.db, [open.id], { paidAt: '31/02/2026' }, TODAY)).toThrow(/Data do pagamento/);
    expect(getBill(handle.db, open.id, TODAY).state).toBe('open');
  });

  it('pular em massa tira as contas do aberto; pulada ou com parcial recusa o lote inteiro', () => {
    const a = bill('Academia');
    const b = bill('Streaming');
    const skipped = skipBill(handle.db, bill('Revista').id, TODAY);
    const partial = bill('Escola');
    payBill(handle.db, partial.id, { mode: 'external', paidAt: TODAY, paidCents: 100, partial: true }, TODAY);

    expect(() => bulkSkipBills(handle.db, [a.id, skipped.id], TODAY)).toThrow(/“Revista” está pulada/);
    expect(() => bulkSkipBills(handle.db, [a.id, partial.id], TODAY)).toThrow(/“Escola” tem pagamento parcial/);
    expect(getBill(handle.db, a.id, TODAY).state).toBe('open');

    expect(bulkSkipBills(handle.db, [a.id, b.id], TODAY)).toEqual({ updated: 2 });
    expect([getBill(handle.db, a.id, TODAY).state, getBill(handle.db, b.id, TODAY).state]).toEqual(['skipped', 'skipped']);
  });

  it('as rotas validam o corpo e devolvem 409 com a conta que impediu', async () => {
    const open = bill('Gás');
    const paid = bill('Condomínio');
    payBill(handle.db, paid.id, { mode: 'external', paidAt: TODAY, paidCents: 10000 }, TODAY);
    const app = await buildApp({ db: handle.db, logger: false });
    try {
      const bad = await app.inject({ method: 'POST', url: '/api/bills/bulk-pay', payload: { ids: [], paidAt: TODAY } });
      expect(bad.statusCode).toBe(400);
      const extra = await app.inject({ method: 'POST', url: '/api/bills/bulk-skip', payload: { ids: [open.id], paidAt: TODAY } });
      expect(extra.statusCode).toBe(400);

      const blocked = await app.inject({ method: 'POST', url: '/api/bills/bulk-pay', payload: { ids: [open.id, paid.id], paidAt: TODAY } });
      expect(blocked.statusCode).toBe(409);
      expect(blocked.json().error).toMatch(/Condomínio/);

      const ok = await app.inject({ method: 'POST', url: '/api/bills/bulk-pay', payload: { ids: [open.id], paidAt: TODAY } });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toEqual({ updated: 1, paidCents: 10000 });

      const skip = await app.inject({ method: 'POST', url: '/api/bills/bulk-skip', payload: { ids: [bill('Seguro').id] } });
      expect(skip.json()).toEqual({ updated: 1 });
    } finally {
      await app.close();
    }
  });
});
