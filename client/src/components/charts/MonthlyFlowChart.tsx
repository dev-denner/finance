import { useLayoutEffect, useRef, useState } from 'react';
import { formatAxisBRL, niceScale, type MonthlyFlow } from '../../lib/charts';
import { formatBRL, MONTHS_LONG, MONTHS_SHORT } from '../../lib/format';

const HEIGHT = 240;
const MARGIN = { top: 12, right: 12, bottom: 26, left: 64 };
const MAX_BAR = 24;
const BAR_GAP = 2;
const RADIUS = 4;
const FALLBACK_WIDTH = 640;
const TOOLTIP_WIDTH = 220;

export const FLOW_SERIES = {
  in: { label: 'Entradas', color: 'var(--chart-series-1)' },
  out: { label: 'Saídas', color: 'var(--chart-series-2)' },
  net: { label: 'Saldo do mês', color: 'var(--chart-series-3)' },
} as const;

/** Coluna com a ponta de dados arredondada e a base reta, crescendo a partir de `baseline`. */
function columnPath(x: number, width: number, baseline: number, top: number): string {
  const height = baseline - top;
  if (height <= 0) return '';
  const r = Math.min(RADIUS, width / 2, height);
  return `M${x},${baseline}V${top + r}Q${x},${top} ${x + r},${top}H${x + width - r}Q${x + width},${top} ${x + width},${top + r}V${baseline}Z`;
}

/**
 * Entradas e saídas por mês (colunas lado a lado) com o saldo do mês em linha,
 * tudo no mesmo eixo em reais. Passar o mouse ou focar um mês mostra os três
 * valores; a tabela do cartão traz os mesmos números.
 */
export function MonthlyFlowChart({ rows, year }: { rows: MonthlyFlow[]; year: number }) {
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(FALLBACK_WIDTH);
  const [active, setActive] = useState<number | null>(null);

  useLayoutEffect(() => {
    const element = container.current;
    if (!element) return;
    const measure = () => setWidth(element.clientWidth || FALLBACK_WIDTH);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const values = rows.flatMap((row) => [row.inCents, row.outCents, row.netCents]);
  const scale = niceScale(Math.min(...values, 0), Math.max(...values, 0));
  const plotWidth = Math.max(120, width - MARGIN.left - MARGIN.right);
  const plotHeight = HEIGHT - MARGIN.top - MARGIN.bottom;
  const band = plotWidth / rows.length;
  const barWidth = Math.max(4, Math.min(MAX_BAR, (band * 0.72 - BAR_GAP) / 2));
  const y = (value: number) => MARGIN.top + ((scale.max - value) / (scale.max - scale.min)) * plotHeight;
  const center = (index: number) => MARGIN.left + band * index + band / 2;
  const baseline = y(0);
  const linePoints = rows.map((row, index) => `${center(index)},${y(row.netCents)}`).join(' ');
  const lastWithData = rows.reduce((last, row, index) => (row.inCents || row.outCents ? index : last), -1);
  const activeRow = active !== null ? rows[active] : null;
  const tooltipLeft = active !== null ? Math.min(Math.max(center(active) - TOOLTIP_WIDTH / 2, 0), width - TOOLTIP_WIDTH) : 0;

  return (
    <div ref={container} className="relative" onPointerLeave={() => setActive(null)}>
      <svg
        width={width}
        height={HEIGHT}
        role="img"
        aria-label={`Entradas, saídas e saldo por mês em ${year}`}
        className="block select-none"
        onPointerMove={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          const index = Math.floor((event.clientX - box.left - MARGIN.left) / band);
          setActive(index >= 0 && index < rows.length ? index : null);
        }}
      >
        {scale.ticks.map((tick) => (
          <g key={tick}>
            <line
              x1={MARGIN.left}
              x2={MARGIN.left + plotWidth}
              y1={y(tick)}
              y2={y(tick)}
              stroke={tick === 0 ? 'var(--chart-axis)' : 'var(--chart-grid)'}
              strokeWidth={1}
              shapeRendering="crispEdges"
            />
            <text x={MARGIN.left - 8} y={y(tick)} dy="0.32em" textAnchor="end" className="fill-ink-400 text-[10px] tabular-nums">
              {formatAxisBRL(tick)}
            </text>
          </g>
        ))}
        {rows.map((row, index) => (
          <text
            key={row.month}
            x={center(index)}
            y={HEIGHT - 8}
            textAnchor="middle"
            className={`text-[10px] ${active === index ? 'fill-ink-700 dark:fill-ink-200' : 'fill-ink-400'}`}
          >
            {MONTHS_SHORT[row.month - 1]}
          </text>
        ))}
        {active !== null && (
          <line
            x1={center(active)}
            x2={center(active)}
            y1={MARGIN.top}
            y2={MARGIN.top + plotHeight}
            stroke="var(--chart-axis)"
            strokeWidth={1}
            shapeRendering="crispEdges"
          />
        )}
        {rows.map((row, index) => {
          const left = center(index) - barWidth - BAR_GAP / 2;
          return (
            <g key={row.month} opacity={active === null || active === index ? 1 : 0.55}>
              <path d={columnPath(left, barWidth, baseline, y(row.inCents))} fill={FLOW_SERIES.in.color} />
              <path d={columnPath(left + barWidth + BAR_GAP, barWidth, baseline, y(row.outCents))} fill={FLOW_SERIES.out.color} />
            </g>
          );
        })}
        <polyline
          points={linePoints}
          fill="none"
          stroke={FLOW_SERIES.net.color}
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {[active ?? lastWithData].filter((index) => index >= 0).map((index) => (
          <circle
            key={index}
            cx={center(index)}
            cy={y(rows[index].netCents)}
            r={4}
            fill={FLOW_SERIES.net.color}
            stroke="var(--chart-surface)"
            strokeWidth={2}
          />
        ))}
        {/* Alvos de foco/teclado: um por mês, maiores que as marcas. */}
        {rows.map((row, index) => (
          <rect
            key={row.month}
            x={MARGIN.left + band * index}
            y={MARGIN.top}
            width={band}
            height={plotHeight}
            fill="transparent"
            tabIndex={0}
            aria-label={`${MONTHS_LONG[row.month - 1]}: entradas ${formatBRL(row.inCents)}, saídas ${formatBRL(row.outCents)}, saldo ${formatBRL(row.netCents)}`}
            onFocus={() => setActive(index)}
            onBlur={() => setActive(null)}
            className="outline-none focus-visible:stroke-blue-500"
          />
        ))}
      </svg>
      {activeRow && (
        <div
          role="status"
          className="pointer-events-none absolute top-2 w-[220px] rounded-lg border border-ink-200 bg-white px-3 py-2 text-[12px] shadow-pop dark:border-ink-700 dark:bg-ink-900"
          style={{ left: tooltipLeft }}
        >
          <p className="mb-1 font-medium text-ink-500 dark:text-ink-400">
            {MONTHS_LONG[activeRow.month - 1]} de {year}
          </p>
          {(['in', 'out', 'net'] as const).map((key) => {
            const value = key === 'in' ? activeRow.inCents : key === 'out' ? activeRow.outCents : activeRow.netCents;
            return (
              <p key={key} className="flex items-center gap-2 whitespace-nowrap">
                <span aria-hidden="true" className="h-0.5 w-3 rounded-full" style={{ background: FLOW_SERIES[key].color }} />
                <strong className="tabular-nums text-ink-900 dark:text-white">{formatBRL(value)}</strong>
                <span className="text-ink-500 dark:text-ink-400">{FLOW_SERIES[key].label}</span>
              </p>
            );
          })}
        </div>
      )}
    </div>
  );
}
