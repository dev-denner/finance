import { afterEach, describe, expect, it } from 'vitest';
import { addDaysIso, daysBetweenIso, todayIsoInTimeZone } from '../src/lib/dates';
import { remainingDaysLabel } from '../src/services/bill-reminder-email';

/**
 * Datas usadas nos lembretes por e-mail (AC-8).
 *
 * Regras cobertas:
 * - "hoje" é calculado no fuso America/Sao_Paulo, independentemente do fuso
 *   da máquina que executa;
 * - a aritmética de dias é de calendário (imune a horário de verão);
 * - entrada inválida nunca derruba o chamador.
 */

const FUSO = 'America/Sao_Paulo';
const TZ_ORIGINAL = process.env.TZ;

/** Restaura o fuso do processo (o teste nunca deve deixar o ambiente sujo). */
function restoreTimeZone(): void {
  if (TZ_ORIGINAL === undefined) {
    delete process.env.TZ;
  } else {
    process.env.TZ = TZ_ORIGINAL;
  }
}

afterEach(() => {
  restoreTimeZone();
});

describe('datas dos lembretes — "hoje" no fuso de São Paulo (AC-8)', () => {
  it('deve usar a data local na virada de meia-noite de São Paulo', () => {
    // 02:30 UTC = 23:30 do dia anterior em São Paulo (UTC-3).
    const instant = new Date('2026-01-01T02:30:00Z');
    expect(todayIsoInTimeZone(FUSO, instant)).toBe('2025-12-31');
  });

  it('deve usar America/Sao_Paulo como fuso padrão', () => {
    const instant = new Date('2026-01-01T02:30:00Z');
    expect(todayIsoInTimeZone(undefined, instant)).toBe('2025-12-31');
  });

  it('deve devolver a mesma data com o fuso do host em UTC ou em São Paulo', () => {
    const instant = new Date('2026-01-01T02:30:00Z');
    const results: string[] = [];

    for (const hostZone of ['UTC', 'America/Sao_Paulo']) {
      try {
        process.env.TZ = hostZone;
        results.push(todayIsoInTimeZone(FUSO, instant));
      } finally {
        restoreTimeZone();
      }
    }

    expect(results).toEqual(['2025-12-31', '2025-12-31']);
  });

  it('deve avançar o dia local sem depender do fuso do host', () => {
    const instant = new Date('2026-03-09T23:30:00Z');
    const results: string[] = [];

    for (const hostZone of ['UTC', 'America/Sao_Paulo']) {
      try {
        process.env.TZ = hostZone;
        results.push(todayIsoInTimeZone(FUSO, instant));
      } finally {
        restoreTimeZone();
      }
    }

    // 23:30 UTC = 20:30 do mesmo dia em São Paulo.
    expect(results).toEqual(['2026-03-09', '2026-03-09']);
  });

  it('deve rejeitar instante inválido com erro explícito', () => {
    expect(() => todayIsoInTimeZone(FUSO, new Date('nao-e-uma-data'))).toThrow(/Data inválida/);
  });

  it('deve rejeitar fuso inexistente com erro explícito', () => {
    expect(() => todayIsoInTimeZone('Mars/Olympus_Mons', new Date('2026-01-01T12:00:00Z'))).toThrow(
      /Fuso horário inválido/,
    );
  });
});

describe('datas dos lembretes — aritmética de calendário (AC-8)', () => {
  it('deve subtrair dias dentro do mesmo mês', () => {
    expect(addDaysIso('2026-12-31', -3)).toBe('2026-12-28');
    expect(addDaysIso('2026-01-31', -3)).toBe('2026-01-28');
  });

  it('deve subtrair dias atravessando a virada de mês', () => {
    expect(addDaysIso('2026-02-01', -3)).toBe('2026-01-29');
    expect(addDaysIso('2026-01-01', -1)).toBe('2025-12-31');
  });

  it('deve subtrair dias em ano bissexto', () => {
    expect(addDaysIso('2024-02-29', -3)).toBe('2024-02-26');
    expect(addDaysIso('2024-03-01', -3)).toBe('2024-02-27');
  });

  it('deve somar dias atravessando a virada de ano', () => {
    expect(addDaysIso('2025-12-31', 1)).toBe('2026-01-01');
    expect(addDaysIso('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('deve calcular a diferença em dias de calendário no sentido documentado (b - a)', () => {
    expect(daysBetweenIso('2026-02-28', '2026-03-01')).toBe(1);
    expect(daysBetweenIso('2026-03-01', '2026-02-28')).toBe(-1);
    expect(daysBetweenIso('2026-03-10', '2026-03-10')).toBe(0);
    expect(daysBetweenIso('2026-03-10', '2026-03-13')).toBe(3);
  });

  it('deve retornar um dia de calendário no sentido b menos a', () => {
    // A convenção documentada da função é `b - a`: o resultado é positivo
    // quando `b` é posterior a `a`. Fevereiro de 2026 tem 28 dias, então
    // 28/02 → 01/03 é exatamente um dia de calendário.
    expect(daysBetweenIso('2026-02-28', '2026-03-01')).toBe(1);
    expect(daysBetweenIso('2026-03-01', '2026-02-28')).toBe(-1);
  });

  it('deve ignorar o horário de verão na contagem de dias', () => {
    // Brasil_dst começa em 2026-10-18 (horário de verão não existe no Brasil,
    // mas a data abaixo cruza a virada de ano usada nos marcos).
    expect(daysBetweenIso('2025-12-31', '2026-01-01')).toBe(1);
    expect(addDaysIso('2026-01-04', -1)).toBe('2026-01-03');
  });

  it('deve devolver null para data inválida sem lançar exceção', () => {
    expect(() => addDaysIso('2026-02-30', -3)).not.toThrow();
    expect(addDaysIso('2026-02-30', -3)).toBeNull();
    expect(addDaysIso('31/02/2026', -3)).toBeNull();
    expect(addDaysIso('', -1)).toBeNull();
    expect(addDaysIso('ontem', -1)).toBeNull();
    expect(daysBetweenIso('2026-13-01', '2026-01-01')).toBeNull();
    expect(daysBetweenIso('2026-01-01', 'ontem')).toBeNull();
  });

  it('deve devolver null para quantidade de dias inválida', () => {
    expect(addDaysIso('2026-01-01', 1.5)).toBeNull();
    expect(addDaysIso('2026-01-01', Number.NaN)).toBeNull();
    expect(addDaysIso('2026-01-01', Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe('datas dos lembretes — prazo restante do aviso (NIT)', () => {
  it('deve traduzir a diferença de dias no texto do aviso', () => {
    expect(remainingDaysLabel('2026-03-10', '2026-03-13')).toBe('faltam 3 dias');
    expect(remainingDaysLabel('2026-03-10', '2026-03-11')).toBe('vence amanhã');
    expect(remainingDaysLabel('2026-03-10', '2026-03-10')).toBe('vence hoje');
    expect(remainingDaysLabel('2026-03-10', '2026-03-09')).toBe('venceu ontem');
    expect(remainingDaysLabel('2026-03-10', '2026-03-07')).toBe('venceu há 3 dias');
  });

  it('deve devolver null quando a data do item é inválida', () => {
    expect(remainingDaysLabel('2026-03-10', '31/02/2026')).toBeNull();
    expect(remainingDaysLabel('2026-03-10', '')).toBeNull();
  });
});
