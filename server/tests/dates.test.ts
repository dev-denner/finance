import { describe, expect, it } from 'vitest';
import { parseDateValue } from '../src/lib/dates';

describe('interpretação de datas', () => {
  it('converte datas brasileiras DD/MM/AAAA', () => {
    expect(parseDateValue('05/01/2026')).toEqual({ ok: true, value: '2026-01-05' });
    expect(parseDateValue('29/02/2024')).toEqual({ ok: true, value: '2024-02-29' });
    expect(parseDateValue('1/2/2026')).toEqual({ ok: true, value: '2026-02-01' });
  });

  it('aceita ISO, horários e anos de dois dígitos', () => {
    expect(parseDateValue('2026-01-05')).toEqual({ ok: true, value: '2026-01-05' });
    expect(parseDateValue('05/01/2026 13:45:00')).toEqual({ ok: true, value: '2026-01-05' });
    expect(parseDateValue('05/01/26')).toEqual({ ok: true, value: '2026-01-05' });
    expect(parseDateValue('05-01-2026')).toEqual({ ok: true, value: '2026-01-05' });
  });

  it('rejeita datas inválidas', () => {
    for (const value of ['31/02/2026', '00/01/2026', '32/01/2026', '2026-13-01', 'ontem', '']) {
      expect(parseDateValue(value).ok).toBe(false);
    }
  });

  it('converte números de série do Excel', () => {
    expect(parseDateValue(46023)).toEqual({ ok: true, value: '2026-01-01' });
    expect(parseDateValue('46023')).toEqual({ ok: true, value: '2026-01-01' });
  });

  it('converte objetos Date', () => {
    const result = parseDateValue(new Date(2026, 0, 5));
    expect(result).toEqual({ ok: true, value: '2026-01-05' });
  });
});
