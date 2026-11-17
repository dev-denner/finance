import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseHandle } from '../src/db/client';
import { importBills, parseRepeat, previewBillsImport } from '../src/services/bills-import';
import { listTemplates } from '../src/services/bills';
import { createTestDatabase, makeCsv } from './helpers';

let handle: DatabaseHandle;

beforeEach(() => {
  handle = createTestDatabase();
});

afterEach(() => handle.sqlite.close());

/** Dia 10 do mês que vem: dentro da janela de ocorrências qualquer que seja a data do teste. */
function nextMonthDay10(): { iso: string; br: string; plus: (months: number) => string } {
  const now = new Date();
  const index = now.getFullYear() * 12 + now.getMonth() + 1;
  const at = (offset: number) => {
    const total = index + offset;
    return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}-10`;
  };
  const iso = at(0);
  return { iso, br: `10/${iso.slice(5, 7)}/${iso.slice(0, 4)}`, plus: at };
}

const HEADER = 'Despesa;Valor;Vencimento;Situação;Categoria;Repetição';

describe('importação de contas — coluna Repetição', () => {
  it('lê frequência, intervalo, quantidade e último dia útil', () => {
    expect(parseRepeat('')).toEqual({ ok: true, value: null });
    expect(parseRepeat('Não')).toEqual({ ok: true, value: null });
    expect(parseRepeat('Mensal')).toEqual({ ok: true, value: { frequency: 'monthly', interval: 1, lastBusinessDay: false, occurrenceCount: null } });
    expect(parseRepeat('Trimestral 4x')).toEqual({ ok: true, value: { frequency: 'monthly', interval: 3, lastBusinessDay: false, occurrenceCount: 4 } });
    expect(parseRepeat('quinzenal, 6 vezes')).toEqual({ ok: true, value: { frequency: 'weekly', interval: 2, lastBusinessDay: false, occurrenceCount: 6 } });
    expect(parseRepeat('Mensal no último dia útil')).toEqual({ ok: true, value: { frequency: 'monthly', interval: 1, lastBusinessDay: true, occurrenceCount: null } });
    expect(parseRepeat('ANUAL x2')).toEqual({ ok: true, value: { frequency: 'yearly', interval: 1, lastBusinessDay: false, occurrenceCount: 2 } });
    expect(parseRepeat('diária')).toMatchObject({ ok: false, error: expect.stringContaining('Repetição inválida') });
    expect(parseRepeat('Mensal 0x')).toMatchObject({ ok: false, error: expect.stringContaining('1 a 600') });
    expect(parseRepeat('Anual, último dia útil')).toMatchObject({ ok: false, error: expect.stringContaining('último dia útil') });
  });

  it('a prévia mostra a regra; situação numa recorrência e repetição inválida viram erro da linha', () => {
    const { br } = nextMonthDay10();
    const buffer = makeCsv(
      [
        `Aluguel;1.500,00;${br};;Moradia;Mensal 3x`,
        `IPVA;900,00;${br};PG;Transporte;Anual`,
        `Feira;80,00;${br};;Mercado;todo dia`,
        `Dentista;300,00;${br};;Saúde;`,
      ],
      HEADER,
    );
    const preview = previewBillsImport(handle.db, buffer, 'contas.csv');
    expect(preview.mapping.repeat).toBe(5);
    const [rent, ipva, market, dentist] = preview.rows;
    expect(rent.values.recurrence).toEqual({ frequency: 'monthly', interval: 1, lastBusinessDay: false, occurrenceCount: 3, label: 'Mensal, dia 10' });
    expect(rent.errors).toEqual([]);
    expect(ipva.errors).toEqual([expect.stringContaining('Situação: só vale para conta avulsa')]);
    expect(market.errors).toEqual([expect.stringContaining('Repetição inválida')]);
    expect(dentist.values.recurrence).toBeNull();
    expect(preview).toMatchObject({ validRows: 2, invalidRows: 2, duplicateRows: 0 });
    expect(preview.rows.map((row) => row.duplicate)).toEqual([false, false, false, false]);
  });

  it('importar cria a recorrência com as ocorrências e a conta avulsa ao lado', () => {
    const { br, plus } = nextMonthDay10();
    const buffer = makeCsv(
      [
        `Aluguel;1.500,00;${br};;Moradia;Mensal 3x`,
        `Dentista;300,00;${br};AG;Saúde;`,
      ],
      HEADER,
    );
    const summary = importBills(handle.db, buffer, 'contas.csv', { mapping: {} });
    expect(summary).toMatchObject({ importedRows: 2, createdTemplates: 1, invalidRows: 0 });

    const [template] = listTemplates(handle.db);
    expect(template).toMatchObject({ description: 'Aluguel', amountCents: 150000, occurrenceCount: 3, recurrenceLabel: 'Mensal, dia 10', startDate: plus(0) });
    const dates = (handle.sqlite.prepare('SELECT due_date AS d FROM scheduled_bills WHERE template_id = ? ORDER BY sequence').all(template.id) as { d: string }[]).map((row) => row.d);
    expect(dates).toEqual([plus(0), plus(1), plus(2)]);
    const loose = handle.sqlite.prepare("SELECT template_id AS t, scheduled_for AS s FROM scheduled_bills WHERE description = 'Dentista'").get() as { t: number | null; s: string };
    expect(loose).toEqual({ t: null, s: plus(0) });

    expect(previewBillsImport(handle.db, buffer, 'contas.csv').rows.map((row) => row.duplicate)).toEqual([true, true]);
    // Reimportar acusa a duplicidade pela primeira ocorrência e, pulando duplicadas, não cria outra recorrência.
    const again = importBills(handle.db, buffer, 'contas.csv', { mapping: {}, skipDuplicates: true });
    expect(again).toMatchObject({ importedRows: 0, skippedDuplicates: 2, duplicateRows: 2, createdTemplates: 0 });
    expect(listTemplates(handle.db)).toHaveLength(1);
  });
});
