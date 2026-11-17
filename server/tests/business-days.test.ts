import { describe, expect, it } from 'vitest';
import { bankHolidays, easterSunday, isBusinessDay, lastBusinessDayOfMonth } from '../src/lib/business-days';

describe('dias úteis bancários', () => {
  it('calcula a Páscoa e os feriados móveis', () => {
    expect([easterSunday(2024), easterSunday(2025), easterSunday(2026)]).toEqual(['2024-03-31', '2025-04-20', '2026-04-05']);
    const holidays2026 = bankHolidays(2026);
    for (const day of ['2026-02-16', '2026-02-17', '2026-04-03', '2026-06-04', '2026-04-21', '2026-12-25']) {
      expect(holidays2026.has(day)).toBe(true);
    }
  });

  it('fim de semana e feriado não são úteis; Consciência Negra só a partir de 2024', () => {
    expect(isBusinessDay('2026-03-02')).toBe(true);
    expect(isBusinessDay('2026-02-28')).toBe(false); // sábado
    expect(isBusinessDay('2026-04-03')).toBe(false); // Sexta-feira Santa
    expect(isBusinessDay('2023-11-20')).toBe(true);
    expect(isBusinessDay('2024-11-20')).toBe(false);
  });

  it('último dia útil recua sobre fim de semana e feriado', () => {
    expect(lastBusinessDayOfMonth(2026, 1)).toBe('2026-01-30'); // 31 é sábado
    expect(lastBusinessDayOfMonth(2026, 3)).toBe('2026-03-31');
    expect(lastBusinessDayOfMonth(2026, 5)).toBe('2026-05-29'); // 30 e 31 no fim de semana
    expect(lastBusinessDayOfMonth(2024, 3)).toBe('2024-03-28'); // 29 é Sexta-feira Santa
  });
});
