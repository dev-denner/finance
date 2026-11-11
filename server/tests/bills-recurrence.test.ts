import { describe, expect, it } from 'vitest';
import {
  describeRecurrence,
  nextOccurrenceDates,
  validateRecurrence,
  type BillRecurrence,
} from '../src/services/bills/recurrence';

const monthly = (overrides: Partial<BillRecurrence> = {}): BillRecurrence => ({
  frequency: 'monthly',
  interval: 1,
  dayOfMonth: null,
  weekday: null,
  monthOfYear: null,
  ...overrides,
});

describe('recorrência — mensal', () => {
  it('dia 31 recua ao último dia do mês sem perder o dia-alvo (AC2)', () => {
    const dates = nextOccurrenceDates(monthly({ dayOfMonth: 31 }), '2026-01-31', {
      to: '2026-05-31',
    });
    expect(dates.map((d) => d.dueDate)).toEqual([
      '2026-01-31',
      '2026-02-28',
      '2026-03-31',
      '2026-04-30',
      '2026-05-31',
    ]);
    expect(dates.map((d) => d.sequence)).toEqual([1, 2, 3, 4, 5]);
  });

  it('ano bissexto gera 29/02', () => {
    const dates = nextOccurrenceDates(monthly({ dayOfMonth: 31 }), '2024-01-31', {
      to: '2024-03-31',
    });
    expect(dates.map((d) => d.dueDate)).toEqual(['2024-01-31', '2024-02-29', '2024-03-31']);
  });

  it('primeira ocorrência é a primeira data >= início que respeita o dia', () => {
    const dates = nextOccurrenceDates(monthly({ dayOfMonth: 10 }), '2026-01-15', {
      to: '2026-03-31',
    });
    expect(dates.map((d) => d.dueDate)).toEqual(['2026-02-10', '2026-03-10']);
  });

  it('sem dia explícito usa o dia da data inicial', () => {
    const dates = nextOccurrenceDates(monthly(), '2026-03-05', { to: '2026-05-31' });
    expect(dates.map((d) => d.dueDate)).toEqual(['2026-03-05', '2026-04-05', '2026-05-05']);
  });

  it('interval 2 gera bimestral e vira o ano', () => {
    const dates = nextOccurrenceDates(monthly({ interval: 2, dayOfMonth: 20 }), '2026-10-20', {
      to: '2027-04-30',
    });
    expect(dates.map((d) => d.dueDate)).toEqual([
      '2026-10-20',
      '2026-12-20',
      '2027-02-20',
      '2027-04-20',
    ]);
  });
});

describe('recorrência — limites (AC3b)', () => {
  it('occurrenceCount limita a série mesmo com horizonte maior', () => {
    const dates = nextOccurrenceDates(monthly({ dayOfMonth: 10 }), '2026-01-10', {
      to: '2027-12-31',
      occurrenceCount: 6,
    });
    expect(dates).toHaveLength(6);
    expect(dates[5]).toEqual({ sequence: 6, dueDate: '2026-06-10' });
  });

  it('endDate e occurrenceCount juntos: vale o que terminar primeiro', () => {
    const byDate = nextOccurrenceDates(monthly({ dayOfMonth: 10 }), '2026-01-10', {
      to: '2027-12-31',
      occurrenceCount: 12,
      endDate: '2026-04-30',
    });
    expect(byDate.map((d) => d.dueDate)).toEqual([
      '2026-01-10',
      '2026-02-10',
      '2026-03-10',
      '2026-04-10',
    ]);

    const byCount = nextOccurrenceDates(monthly({ dayOfMonth: 10 }), '2026-01-10', {
      to: '2027-12-31',
      occurrenceCount: 2,
      endDate: '2026-12-31',
    });
    expect(byCount).toHaveLength(2);
  });

  it('endDate anterior ao horizonte e ao início gera lista vazia', () => {
    expect(
      nextOccurrenceDates(monthly(), '2026-05-01', { to: '2026-12-31', endDate: '2026-04-30' }),
    ).toEqual([]);
  });

  it('horizonte inclusivo', () => {
    const dates = nextOccurrenceDates(monthly({ dayOfMonth: 15 }), '2026-01-15', {
      to: '2026-02-15',
    });
    expect(dates.map((d) => d.dueDate)).toEqual(['2026-01-15', '2026-02-15']);
  });
});

describe('recorrência — semanal e anual', () => {
  it('semanal com dia da semana explícito começa no primeiro dia compatível', () => {
    // 2026-01-01 é quinta-feira (4); pedir segunda (1) → 2026-01-05
    const dates = nextOccurrenceDates(
      { frequency: 'weekly', interval: 1, dayOfMonth: null, weekday: 1, monthOfYear: null },
      '2026-01-01',
      { to: '2026-01-31' },
    );
    expect(dates.map((d) => d.dueDate)).toEqual([
      '2026-01-05',
      '2026-01-12',
      '2026-01-19',
      '2026-01-26',
    ]);
  });

  it('quinzenal (interval 2) sem weekday usa o dia da data inicial', () => {
    const dates = nextOccurrenceDates(
      { frequency: 'weekly', interval: 2, dayOfMonth: null, weekday: null, monthOfYear: null },
      '2026-01-01',
      { to: '2026-02-15' },
    );
    expect(dates.map((d) => d.dueDate)).toEqual(['2026-01-01', '2026-01-15', '2026-01-29', '2026-02-12']);
  });

  it('anual em 29/02 recua para 28/02 em ano comum', () => {
    const dates = nextOccurrenceDates(
      { frequency: 'yearly', interval: 1, dayOfMonth: 29, weekday: null, monthOfYear: 2 },
      '2024-02-29',
      { to: '2028-12-31' },
    );
    expect(dates.map((d) => d.dueDate)).toEqual([
      '2024-02-29',
      '2025-02-28',
      '2026-02-28',
      '2027-02-28',
      '2028-02-29',
    ]);
  });

  it('anual com mês anterior ao início começa no ano seguinte', () => {
    const dates = nextOccurrenceDates(
      { frequency: 'yearly', interval: 1, dayOfMonth: 10, weekday: null, monthOfYear: 3 },
      '2026-06-01',
      { to: '2028-12-31' },
    );
    expect(dates.map((d) => d.dueDate)).toEqual(['2027-03-10', '2028-03-10']);
  });
});

describe('recorrência — validação e descrição', () => {
  it('rejeita frequência, intervalo e dias fora do domínio', () => {
    expect(validateRecurrence(monthly({ frequency: 'daily' as BillRecurrence['frequency'] }))).toMatch(
      /Frequência/,
    );
    expect(validateRecurrence(monthly({ interval: 0 }))).toMatch(/intervalo/);
    expect(validateRecurrence(monthly({ dayOfMonth: 32 }))).toMatch(/dia do mês/);
    expect(validateRecurrence(monthly({ weekday: 7 }))).toMatch(/dia da semana/);
    expect(validateRecurrence(monthly({ monthOfYear: 13 }))).toMatch(/mês/);
    expect(validateRecurrence(monthly({ dayOfMonth: 10 }))).toBeNull();
  });

  it('nextOccurrenceDates lança em data inicial inválida', () => {
    expect(() => nextOccurrenceDates(monthly(), '2026-02-30', { to: '2026-12-31' })).toThrow();
  });

  it('descreve a regra em português', () => {
    expect(describeRecurrence(monthly({ dayOfMonth: 10 }))).toBe('Mensal, dia 10');
    expect(describeRecurrence(monthly({ interval: 3 }))).toBe('A cada 3 meses');
    expect(
      describeRecurrence({ frequency: 'weekly', interval: 2, dayOfMonth: null, weekday: 1, monthOfYear: null }),
    ).toBe('A cada 2 semanas, segunda');
    expect(
      describeRecurrence({ frequency: 'yearly', interval: 1, dayOfMonth: 5, weekday: null, monthOfYear: 3 }),
    ).toBe('Anual, 05/03');
  });
});
