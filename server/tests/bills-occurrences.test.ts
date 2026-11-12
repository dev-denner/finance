import { describe, expect, it } from 'vitest';
import {
  createBill,
  createTemplate,
  deleteBill,
  getAgenda,
  getBill,
  listBills,
  payBill,
  scheduleBill,
  setBillStatus,
  skipBill,
  unpayBill,
  unskipBill,
  updateBill,
} from '../src/services/bills';
import { ensureLookup } from '../src/services/lookups';
import { createTestDatabase } from './helpers';

const TODAY = '2026-03-10';

function setup() {
  const handle = createTestDatabase();
  const category = ensureLookup(handle.db, 'category', 'Moradia');
  const bill = (description: string, dueDate: string, amountCents = 1000) =>
    createBill(handle.db, { description, amountCents, dueDate, categoryId: category.id }, TODAY);
  return { db: handle.db, sqlite: handle.sqlite, category, bill };
}

describe('ocorrências — status derivado e agenda (AC9)', () => {
  it('deriva atrasada, hoje, agendada, futura, paga e pulada a partir do estado e das datas', () => {
    const { db, bill } = setup();
    const overdue = bill('Atrasada', '2026-03-01');
    const today = bill('Hoje', '2026-03-10');
    const upcoming = bill('Futura', '2026-03-15');
    const scheduled = scheduleBill(db, bill('Agendada', '2026-03-20').id, '2026-03-18', TODAY);
    const paid = payBill(db, bill('Paga', '2026-03-05').id, { mode: 'external', paidAt: '2026-03-04', paidCents: 1000 }, TODAY);
    const skipped = skipBill(db, bill('Pulada', '2026-03-25').id, TODAY);

    expect(overdue.displayStatus).toBe('overdue');
    expect(today.displayStatus).toBe('due_today');
    expect(upcoming.displayStatus).toBe('upcoming');
    expect(scheduled).toMatchObject({ displayStatus: 'scheduled', scheduledFor: '2026-03-18', status: 'AG' });
    expect(paid).toMatchObject({ displayStatus: 'paid', status: 'PG', paidAt: '2026-03-04', paidCents: 1000 });
    expect(skipped).toMatchObject({ displayStatus: 'skipped', state: 'skipped', status: '' });

    // atrasada agendada continua atrasada: a data manda
    const lateScheduled = scheduleBill(db, overdue.id, '2026-03-02', TODAY);
    expect(lateScheduled.displayStatus).toBe('overdue');

    const { summary } = listBills(db, 2026, 3, { today: TODAY });
    expect(summary.statusCounts).toEqual({ overdue: 1, due_today: 1, scheduled: 1, upcoming: 1, paid: 1, skipped: 1 });
    expect(summary.totalCents).toBe(5000); // pulada fica fora
    expect(summary.paidCents).toBe(1000);
    expect(summary.openCents).toBe(4000);
    expect(summary.overdueCents).toBe(1000);
    // compatibilidade com a tela atual
    expect(summary.unpaidCents).toBe(4000);
    expect(summary.counts).toEqual({ '': 3, AG: 2, PG: 1 }); // a atrasada também foi agendada acima
  });

  it('agenda separa atrasadas, hoje e próximos N dias, só em aberto', () => {
    const { db, bill } = setup();
    bill('Muito atrasada', '2025-12-20');
    bill('Atrasada', '2026-03-09');
    bill('Hoje', '2026-03-10');
    bill('Amanhã', '2026-03-11');
    bill('Em 7 dias', '2026-03-17');
    bill('Em 8 dias', '2026-03-18');
    payBill(db, bill('Paga ontem', '2026-03-09').id, { mode: 'external', paidAt: '2026-03-09', paidCents: 1000 }, TODAY);
    skipBill(db, bill('Pulada hoje', '2026-03-10').id, TODAY);

    const agenda = getAgenda(db, { days: 7, today: TODAY });
    expect(agenda.overdue.map((b) => b.description)).toEqual(['Muito atrasada', 'Atrasada']);
    expect(agenda.dueToday.map((b) => b.description)).toEqual(['Hoje']);
    expect(agenda.upcoming.map((b) => b.description)).toEqual(['Amanhã', 'Em 7 dias']);
    expect(agenda.summary.openCents).toBe(5000);
    expect(agenda.summary.overdueCents).toBe(2000);
    expect(() => getAgenda(db, { days: 0, today: TODAY })).toThrow();
  });

  it('agenda materializa as ocorrências das recorrências antes de responder', () => {
    const { db, category } = setup();
    createTemplate(
      db,
      {
        description: 'Internet',
        amountCents: 9900,
        categoryId: category.id,
        recurrence: { frequency: 'monthly', interval: 1, dayOfMonth: 12 },
        startDate: '2026-01-12',
      },
      TODAY,
    );
    const agenda = getAgenda(db, { days: 7, today: TODAY });
    expect(agenda.overdue.map((b) => b.dueDate)).toEqual(['2026-01-12', '2026-02-12']);
    expect(agenda.upcoming.map((b) => b.dueDate)).toEqual(['2026-03-12']);
  });

  it('lista filtra por estado, categoria e busca sem acento', () => {
    const { db, bill } = setup();
    const other = ensureLookup(db, 'category', 'Lazer');
    bill('Condomínio', '2026-03-05');
    createBill(db, { description: 'Academia', amountCents: 500, dueDate: '2026-03-06', categoryId: other.id }, TODAY);
    skipBill(db, bill('Pulada', '2026-03-07').id, TODAY);

    expect(listBills(db, 2026, 3, { today: TODAY, search: 'condominio' }).bills.map((b) => b.description)).toEqual(['Condomínio']);
    expect(listBills(db, 2026, 3, { today: TODAY, categoryId: other.id }).bills).toHaveLength(1);
    expect(listBills(db, 2026, 3, { today: TODAY, state: 'skipped' }).bills.map((b) => b.description)).toEqual(['Pulada']);
    expect(listBills(db, 2026, 3, { today: TODAY, state: 'open' }).bills).toHaveLength(2);
  });
});

describe('ocorrências — pagamento externo (AC4a), pular (AC8) e agendar', () => {
  it('pagar no modo externo marca paga sem lançamento nem vínculo; desfazer reabre', () => {
    const { db, bill, sqlite } = setup();
    const target = bill('Luz', '2026-03-12', 18000);
    const paid = payBill(db, target.id, { mode: 'external', paidAt: '2026-03-11', paidCents: 17550, notes: 'desconto' }, TODAY);
    expect(paid).toMatchObject({ state: 'paid', paidAt: '2026-03-11', paidCents: 17550, notes: 'desconto', payments: [] });
    expect((sqlite.prepare('SELECT COUNT(*) AS n FROM transactions').get() as { n: number }).n).toBe(0);
    expect((sqlite.prepare('SELECT COUNT(*) AS n FROM bill_payments').get() as { n: number }).n).toBe(0);

    expect(() => payBill(db, target.id, { mode: 'external', paidAt: '2026-03-11', paidCents: 1 }, TODAY)).toThrow(/já está paga/);

    const reopened = unpayBill(db, target.id, TODAY);
    expect(reopened).toMatchObject({ state: 'open', paidAt: null, paidCents: null, displayStatus: 'upcoming' });
    expect((sqlite.prepare('SELECT COUNT(*) AS n FROM transactions').get() as { n: number }).n).toBe(0);
  });

  it('pagar no modo externo valida data e valor', () => {
    const { db, bill } = setup();
    const target = bill('Água', '2026-03-12');
    expect(() => payBill(db, target.id, { mode: 'external', paidAt: '31/02/2026', paidCents: 100 }, TODAY)).toThrow(/Data do pagamento/);
    expect(() => payBill(db, target.id, { mode: 'external', paidAt: '2026-03-12', paidCents: 0 }, TODAY)).toThrow(/positivo/);
    expect(getBill(db, target.id, TODAY).state).toBe('open');
  });

  it('pular tira a conta do resumo e das atrasadas; despular devolve', () => {
    const { db, bill } = setup();
    const target = bill('Seguro', '2026-03-01');
    expect(getAgenda(db, { today: TODAY }).overdue).toHaveLength(1);
    skipBill(db, target.id, TODAY);
    expect(getAgenda(db, { today: TODAY }).overdue).toHaveLength(0);
    expect(listBills(db, 2026, 3, { today: TODAY }).summary.openCents).toBe(0);
    const back = unskipBill(db, target.id, TODAY);
    expect(back.displayStatus).toBe('overdue');
    expect(() => skipBill(db, payBill(db, target.id, { mode: 'external', paidAt: TODAY, paidCents: 1000 }, TODAY).id, TODAY)).toThrow(/paga/);
  });

  it('agendar exige conta em aberto e aceita limpar', () => {
    const { db, bill } = setup();
    const target = bill('IPTU', '2026-03-20');
    expect(scheduleBill(db, target.id, '2026-03-18', TODAY).scheduledFor).toBe('2026-03-18');
    expect(scheduleBill(db, target.id, null, TODAY).scheduledFor).toBeNull();
    expect(() => scheduleBill(db, target.id, 'ontem', TODAY)).toThrow(/Agendamento/);
    payBill(db, target.id, { mode: 'external', paidAt: TODAY, paidCents: 1000 }, TODAY);
    expect(() => scheduleBill(db, target.id, '2026-03-18', TODAY)).toThrow(/em aberto/);
  });

  it('excluir ocorrência paga de recorrência é bloqueado', () => {
    const { db, category } = setup();
    createTemplate(
      db,
      { description: 'Plano', amountCents: 5000, categoryId: category.id, recurrence: { frequency: 'monthly', interval: 1 }, startDate: '2026-03-01' },
      TODAY,
    );
    const first = listBills(db, 2026, 3, { today: TODAY }).bills[0];
    payBill(db, first.id, { mode: 'external', paidAt: TODAY, paidCents: 5000 }, TODAY);
    expect(() => deleteBill(db, first.id)).toThrow(/Desfaça o pagamento/);
  });
});

describe('ocorrências — compatibilidade com a situação legada', () => {
  it('status PG/AG/"" mapeia para pagamento externo, agendamento e aberta', () => {
    const { db, bill } = setup();
    const target = bill('Legado', '2026-03-15', 2500);

    const paid = setBillStatus(db, target.id, 'PG', TODAY);
    expect(paid.promptRepeat).toBe(true);
    expect(paid.bill).toMatchObject({ state: 'paid', status: 'PG', paidAt: TODAY, paidCents: 2500 });

    const scheduled = setBillStatus(db, target.id, 'AG', TODAY);
    expect(scheduled.promptRepeat).toBe(false);
    expect(scheduled.bill).toMatchObject({ state: 'open', status: 'AG', scheduledFor: '2026-03-15', paidAt: null });

    const open = updateBill(db, target.id, { status: '' }, TODAY);
    expect(open).toMatchObject({ state: 'open', status: '', scheduledFor: null });

    expect(() => setBillStatus(db, target.id, 'XX', TODAY)).toThrow(/Situação inválida/);
  });

  it('criar com status PG registra pagamento externo na data de vencimento (importação histórica)', () => {
    const { db, category } = setup();
    const created = createBill(
      db,
      { description: 'Histórica', amountCents: 700, dueDate: '2025-12-10', categoryId: category.id, status: 'PG' },
      TODAY,
    );
    expect(created).toMatchObject({ state: 'paid', paidAt: '2025-12-10', paidCents: 700, migratedPayment: false });
  });
});
