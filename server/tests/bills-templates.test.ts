import { describe, expect, it } from 'vitest';
import {
  createBill,
  createTemplate,
  deleteBill,
  deleteTemplate,
  ensureAllOccurrences,
  ensureOccurrences,
  getAgenda,
  getBill,
  getTemplate,
  listBills,
  listBillsBetween,
  listTemplates,
  payBill,
  previewTemplateDates,
  updateTemplate,
} from '../src/services/bills';
import { ensureLookup } from '../src/services/lookups';
import { createTestDatabase } from './helpers';

const TODAY = '2026-01-15';

function setup() {
  const handle = createTestDatabase();
  const category = ensureLookup(handle.db, 'category', 'Moradia');
  const account = ensureLookup(handle.db, 'payment', 'Conta Corrente');
  return { db: handle.db, sqlite: handle.sqlite, category, account };
}

function monthlyInput(overrides: Record<string, unknown> = {}) {
  return {
    description: 'Aluguel',
    amountCents: 150000,
    categoryId: 0,
    recurrence: { frequency: 'monthly', interval: 1, dayOfMonth: 10 },
    startDate: '2026-01-10',
    ...overrides,
  };
}

describe('recorrências — criação e geração (AC1, AC3, AC3b)', () => {
  it('cria o template e materializa ocorrências até 12 meses à frente', () => {
    const { db, category, account } = setup();
    const template = createTemplate(
      db,
      monthlyInput({ categoryId: category.id, paymentMethodId: account.id }),
      TODAY,
    );
    expect(template.recurrenceLabel).toBe('Mensal, dia 10');
    expect(template.active).toBe(true);

    const march = listBills(db, 2026, 3, { today: TODAY });
    expect(march.bills).toHaveLength(1);
    expect(march.bills[0]).toMatchObject({
      templateId: template.id,
      sequence: 3,
      dueDate: '2026-03-10',
      state: 'open',
      displayStatus: 'upcoming',
      paymentMethodId: account.id,
      categoryName: 'Moradia',
    });

    // horizonte: hoje + 12 meses = 2027-01-15 → última ocorrência 2027-01-10 (sequence 13)
    const all = listBillsBetween(db, '2026-01-01', '2027-12-31', { today: TODAY });
    expect(all.bills).toHaveLength(13);
    expect(all.bills.at(-1)?.dueDate).toBe('2027-01-10');
    expect(listBillsBetween(db, '2027-02-01', '2027-12-31', { today: TODAY }).bills).toHaveLength(0);
  });

  it('gerar duas vezes não duplica (índice único template+sequence)', () => {
    const { db, category } = setup();
    const template = createTemplate(db, monthlyInput({ categoryId: category.id }), TODAY);
    expect(ensureOccurrences(db, template.id, TODAY)).toEqual({ created: 0 });
    expect(ensureAllOccurrences(db, TODAY)).toEqual({ created: 0 });
    expect(listBillsBetween(db, '2026-01-01', '2027-12-31', { today: TODAY }).bills).toHaveLength(13);
  });

  it('o horizonte avança com o tempo: ao consultar meses depois, novas ocorrências nascem', () => {
    const { db, category } = setup();
    createTemplate(db, monthlyInput({ categoryId: category.id }), TODAY);
    const later = listBillsBetween(db, '2026-01-01', '2028-12-31', { today: '2026-07-01' });
    expect(later.bills).toHaveLength(18); // horizonte 2027-07-01 → última 2027-06-10
    expect(later.bills.at(-1)?.dueDate).toBe('2027-06-10');
  });

  it('occurrenceCount limita a série e "N de T" sai pela sequence (AC3b)', () => {
    const { db, category } = setup();
    const template = createTemplate(
      db,
      monthlyInput({ categoryId: category.id, occurrenceCount: 6, description: 'Parcela do sofá' }),
      TODAY,
    );
    expect(template.occurrenceCount).toBe(6);
    const bills = listBillsBetween(db, '2026-01-01', '2027-12-31', { today: TODAY }).bills;
    expect(bills.map((b) => b.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(bills.at(-1)?.dueDate).toBe('2026-06-10');
  });

  it('endDate e occurrenceCount: vale o que terminar primeiro', () => {
    const { db, category } = setup();
    createTemplate(
      db,
      monthlyInput({ categoryId: category.id, occurrenceCount: 12, endDate: '2026-03-31' }),
      TODAY,
    );
    expect(listBillsBetween(db, '2026-01-01', '2027-12-31', { today: TODAY }).bills).toHaveLength(3);
  });

  it('conta avulsa nunca gera ocorrência futura', () => {
    const { db, category } = setup();
    createBill(db, { description: 'Avulsa', amountCents: 1000, dueDate: '2026-02-01', categoryId: category.id }, TODAY);
    expect(listBillsBetween(db, '2026-01-01', '2027-12-31', { today: TODAY }).bills).toHaveLength(1);
  });

  it('dia 31 recua ao fim do mês (AC2) na geração real', () => {
    const { db, category } = setup();
    createTemplate(
      db,
      monthlyInput({ categoryId: category.id, recurrence: { frequency: 'monthly', interval: 1, dayOfMonth: 31 }, startDate: '2026-01-31' }),
      TODAY,
    );
    const bills = listBillsBetween(db, '2026-01-01', '2026-04-30', { today: TODAY }).bills;
    expect(bills.map((b) => b.dueDate)).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
  });

  it('prévia devolve as próximas datas sem gravar', () => {
    const { db, category, sqlite } = setup();
    const dates = previewTemplateDates(db, monthlyInput({ categoryId: category.id }), { today: TODAY });
    expect(dates.map((d) => d.dueDate)).toEqual([
      '2026-01-10',
      '2026-02-10',
      '2026-03-10',
      '2026-04-10',
      '2026-05-10',
      '2026-06-10',
    ]);
    expect((sqlite.prepare('SELECT COUNT(*) AS n FROM bill_templates').get() as { n: number }).n).toBe(0);
    expect((sqlite.prepare('SELECT COUNT(*) AS n FROM scheduled_bills').get() as { n: number }).n).toBe(0);
  });

  it('rejeita recorrência, datas e valores inválidos', () => {
    const { db, category } = setup();
    expect(() =>
      createTemplate(db, monthlyInput({ categoryId: category.id, recurrence: { frequency: 'daily' } }), TODAY),
    ).toThrow(/Frequência/);
    expect(() =>
      createTemplate(db, monthlyInput({ categoryId: category.id, endDate: '2025-12-31' }), TODAY),
    ).toThrow(/data final/i);
    expect(() =>
      createTemplate(db, monthlyInput({ categoryId: category.id, occurrenceCount: 0 }), TODAY),
    ).toThrow(/repetições/);
    expect(() =>
      createTemplate(db, monthlyInput({ categoryId: category.id, amountCents: 0 }), TODAY),
    ).toThrow(/positivo/);
    expect(() => createTemplate(db, monthlyInput({ categoryId: 999 }), TODAY)).toThrow(/Categoria/);
    expect(() =>
      createTemplate(db, monthlyInput({ categoryId: category.id, amountMinCents: 200, amountMaxCents: 100 }), TODAY),
    ).toThrow(/mínimo/);
  });
});

describe('recorrências — alteração (AC10)', () => {
  it('scope=all propaga campos descritivos às abertas sem pagamento e não toca as pagas', () => {
    const { db, category } = setup();
    const template = createTemplate(db, monthlyInput({ categoryId: category.id }), TODAY);
    const first = listBills(db, 2026, 1, { today: TODAY }).bills[0];
    payBill(db, first.id, { mode: 'external', paidAt: '2026-01-10', paidCents: 150000 }, TODAY);

    updateTemplate(db, template.id, { amountCents: 160000, description: 'Aluguel novo' }, { scope: 'all' }, TODAY);

    expect(getBill(db, first.id, TODAY)).toMatchObject({ amountCents: 150000, description: 'Aluguel' });
    const feb = listBills(db, 2026, 2, { today: TODAY }).bills[0];
    expect(feb).toMatchObject({ amountCents: 160000, description: 'Aluguel novo' });
  });

  it('scope=all recusa mudança de recorrência', () => {
    const { db, category } = setup();
    const template = createTemplate(db, monthlyInput({ categoryId: category.id }), TODAY);
    expect(() =>
      updateTemplate(db, template.id, { recurrence: { dayOfMonth: 20 } }, { scope: 'all' }, TODAY),
    ).toThrow(/scope=future/);
  });

  it('scope=all com occurrenceCount menor remove ocorrências abertas excedentes', () => {
    const { db, category } = setup();
    const template = createTemplate(db, monthlyInput({ categoryId: category.id }), TODAY);
    updateTemplate(db, template.id, { occurrenceCount: 3 }, { scope: 'all' }, TODAY);
    expect(listBillsBetween(db, '2026-01-01', '2027-12-31', { today: TODAY }).bills).toHaveLength(3);
  });

  it('scope=future divide a série: passado preservado, futuro regenerado com a regra nova', () => {
    const { db, category } = setup();
    const template = createTemplate(db, monthlyInput({ categoryId: category.id, occurrenceCount: 12 }), TODAY);
    const april = listBills(db, 2026, 4, { today: TODAY }).bills[0];
    payBill(db, april.id, { mode: 'external', paidAt: '2026-04-10', paidCents: 150000 }, TODAY);

    const replacement = updateTemplate(
      db,
      template.id,
      { amountCents: 170000, recurrence: { frequency: 'monthly', interval: 1, dayOfMonth: 20 } },
      { scope: 'future', from: '2026-06-01' },
      TODAY,
    );

    expect(replacement.id).not.toBe(template.id);
    expect(replacement.startDate).toBe('2026-06-01');
    expect(replacement.occurrenceCount).toBe(7); // 12 - 5 mantidas (jan..mai)

    const old = getTemplate(db, template.id);
    expect(old.endDate).toBe('2026-05-31');
    expect(old.occurrenceCount).toBe(5);

    const bills = listBillsBetween(db, '2026-01-01', '2027-12-31', { today: TODAY }).bills;
    const kept = bills.filter((b) => b.templateId === template.id);
    const fresh = bills.filter((b) => b.templateId === replacement.id);
    expect(kept.map((b) => b.dueDate)).toEqual(['2026-01-10', '2026-02-10', '2026-03-10', '2026-04-10', '2026-05-10']);
    expect(getBill(db, april.id, TODAY).state).toBe('paid');
    expect(fresh.map((b) => b.dueDate)).toEqual([
      '2026-06-20',
      '2026-07-20',
      '2026-08-20',
      '2026-09-20',
      '2026-10-20',
      '2026-11-20',
      '2026-12-20',
    ]);
    expect(fresh.every((b) => b.amountCents === 170000)).toBe(true);
    expect(fresh.map((b) => b.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('contrato da tela: recorrência parcial sem data inicial preserva o dia 31', () => {
    const { db, category } = setup();
    const template = createTemplate(
      db,
      monthlyInput({ categoryId: category.id, recurrence: { frequency: 'monthly', interval: 1, dayOfMonth: 31 }, startDate: '2026-01-31' }),
      TODAY,
    );
    // Edição pela ocorrência de 28/02 mudando só o valor (o que a tela envia).
    const replacement = updateTemplate(
      db,
      template.id,
      { amountCents: 160000, recurrence: { interval: 1 } },
      { scope: 'future', from: '2026-02-28' },
      TODAY,
    );
    expect(replacement.recurrence.dayOfMonth).toBe(31);
    const dates = listBillsBetween(db, '2026-02-01', '2026-05-31', { today: TODAY })
      .bills.filter((b) => b.templateId === replacement.id)
      .map((b) => b.dueDate);
    expect(dates).toEqual(['2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31']);
  });

  it('contrato da tela: corte no dia seguinte a uma ocorrência paga não a duplica', () => {
    const { db, category } = setup();
    const template = createTemplate(db, monthlyInput({ categoryId: category.id }), TODAY);
    const june = listBills(db, 2026, 6, { today: TODAY }).bills[0];
    payBill(db, june.id, { mode: 'external', paidAt: '2026-06-10', paidCents: 150000 }, TODAY);
    updateTemplate(db, template.id, { amountCents: 170000, recurrence: { interval: 1 } }, { scope: 'future', from: '2026-06-11' }, TODAY);
    const juneBills = listBills(db, 2026, 6, { today: TODAY }).bills;
    expect(juneBills).toHaveLength(1);
    expect(juneBills[0]).toMatchObject({ id: june.id, state: 'paid' });
    expect(listBills(db, 2026, 7, { today: TODAY }).bills[0]).toMatchObject({ amountCents: 170000, dueDate: '2026-07-10' });
  });

  it('scope=future a partir do início substitui a série inteira', () => {
    const { db, category } = setup();
    const template = createTemplate(db, monthlyInput({ categoryId: category.id }), TODAY);
    const same = updateTemplate(
      db,
      template.id,
      { recurrence: { dayOfMonth: 25 } },
      { scope: 'future', from: '2026-01-10' },
      TODAY,
    );
    expect(same.id).toBe(template.id);
    const bills = listBillsBetween(db, '2026-01-01', '2026-03-31', { today: TODAY }).bills;
    expect(bills.map((b) => b.dueDate)).toEqual(['2026-01-25', '2026-02-25', '2026-03-25']);
  });

  it('desativar remove as abertas futuras e para de gerar; reativar volta a gerar', () => {
    const { db, category } = setup();
    const template = createTemplate(db, monthlyInput({ categoryId: category.id }), TODAY);
    updateTemplate(db, template.id, { active: false }, { scope: 'all' }, TODAY);
    expect(listBillsBetween(db, '2026-01-01', '2027-12-31', { today: TODAY }).bills.map((b) => b.dueDate)).toEqual([
      '2026-01-10',
    ]);
    expect(listTemplates(db)).toHaveLength(0);
    expect(listTemplates(db, { includeInactive: true })).toHaveLength(1);

    updateTemplate(db, template.id, { active: true }, { scope: 'all' }, TODAY);
    expect(listBillsBetween(db, '2026-01-01', '2027-12-31', { today: TODAY }).bills).toHaveLength(13);
  });
});

describe('recorrências — exclusão e ocorrências puladas', () => {
  it('excluir ocorrência de recorrência a marca como pulada e ela não renasce', () => {
    const { db, category } = setup();
    createTemplate(db, monthlyInput({ categoryId: category.id }), TODAY);
    const feb = listBills(db, 2026, 2, { today: TODAY }).bills[0];
    expect(deleteBill(db, feb.id)).toEqual({ removed: false, skipped: true });

    const again = listBills(db, 2026, 2, { today: TODAY });
    expect(again.bills).toHaveLength(1);
    expect(again.bills[0]).toMatchObject({ id: feb.id, state: 'skipped', displayStatus: 'skipped' });
    expect(again.summary.totalCents).toBe(0);
    expect(again.summary.statusCounts.skipped).toBe(1);
    expect(getAgenda(db, { today: '2026-02-10' }).dueToday).toHaveLength(0);
  });

  it('excluir conta avulsa remove de verdade', () => {
    const { db, category } = setup();
    const bill = createBill(db, { description: 'Avulsa', amountCents: 1000, dueDate: '2026-02-01', categoryId: category.id }, TODAY);
    expect(deleteBill(db, bill.id)).toEqual({ removed: true, skipped: false });
    expect(() => getBill(db, bill.id, TODAY)).toThrow();
  });

  it('excluir a recorrência apaga as abertas e preserva as pagas, desvinculadas', () => {
    const { db, category, sqlite } = setup();
    const template = createTemplate(db, monthlyInput({ categoryId: category.id }), TODAY);
    const jan = listBills(db, 2026, 1, { today: TODAY }).bills[0];
    payBill(db, jan.id, { mode: 'external', paidAt: '2026-01-10', paidCents: 150000 }, TODAY);

    const result = deleteTemplate(db, template.id);
    expect(result.deletedOccurrences).toBe(12);
    expect(() => getTemplate(db, template.id)).toThrow();
    expect(getBill(db, jan.id, TODAY)).toMatchObject({ state: 'paid', templateId: null });
    expect((sqlite.prepare('SELECT COUNT(*) AS n FROM scheduled_bills').get() as { n: number }).n).toBe(1);
  });
});
