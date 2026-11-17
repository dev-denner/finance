import type { MonthlyFlow } from '../../lib/charts';
import { MONTHS_LONG, MONTHS_SHORT } from '../../lib/format';
import { ColumnChart } from './ColumnChart';

export const FLOW_SERIES = {
  in: { label: 'Entradas', color: 'var(--chart-series-1)' },
  out: { label: 'Saídas', color: 'var(--chart-series-2)' },
  net: { label: 'Saldo do mês', color: 'var(--chart-series-3)' },
} as const;

/** Entradas e saídas por mês (colunas lado a lado) com o saldo do mês em linha, no mesmo eixo em reais. */
export function MonthlyFlowChart({ rows, year }: { rows: MonthlyFlow[]; year: number }) {
  return (
    <ColumnChart
      label={`Entradas, saídas e saldo por mês em ${year}`}
      categories={rows.map((row) => ({ short: MONTHS_SHORT[row.month - 1], long: `${MONTHS_LONG[row.month - 1]} de ${year}` }))}
      columns={[
        { key: 'in', ...FLOW_SERIES.in, values: rows.map((row) => row.inCents) },
        { key: 'out', ...FLOW_SERIES.out, values: rows.map((row) => row.outCents) },
      ]}
      line={{ key: 'net', ...FLOW_SERIES.net, values: rows.map((row) => row.netCents) }}
    />
  );
}
