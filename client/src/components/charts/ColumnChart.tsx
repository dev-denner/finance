import { useLayoutEffect, useRef, useState } from 'react';
import { formatAxisBRL, niceScale } from '../../lib/charts';
import { formatBRL } from '../../lib/format';

const HEIGHT = 240;
const MARGIN = { top: 12, right: 12, bottom: 26, left: 64 };
const MAX_BAR = 24;
const GAP = 2;
const RADIUS = 4;
const FALLBACK_WIDTH = 640;
const TOOLTIP_WIDTH = 220;

export interface ColumnSeries {
  key: string;
  label: string;
  /** Cor da série (variável CSS). */
  color: string;
  /** Um valor por categoria do eixo x, em centavos. */
  values: number[];
}

export interface ColumnCategory {
  /** Rótulo curto do eixo ("Jan"). */
  short: string;
  /** Rótulo completo, no tooltip e no rótulo acessível ("Janeiro de 2026"). */
  long: string;
}

/** Coluna com a ponta de dados arredondada (só em cima) e a base reta. */
function columnPath(x: number, width: number, bottom: number, top: number, rounded: boolean): string {
  const height = bottom - top;
  if (height <= 0) return '';
  const r = rounded ? Math.min(RADIUS, width / 2, height) : 0;
  return `M${x},${bottom}V${top + r}Q${x},${top} ${x + r},${top}H${x + width - r}Q${x + width},${top} ${x + width},${top + r}V${bottom}Z`;
}

/**
 * Colunas por categoria do eixo x, lado a lado (`grouped`) ou empilhadas
 * (`stacked`), com uma linha opcional no mesmo eixo em reais. Uma linha
 * vertical acompanha o mouse e o tooltip lista todas as séries; cada
 * categoria tem um alvo focável para o teclado.
 */
export function ColumnChart({
  label,
  categories,
  columns,
  line,
  mode = 'grouped',
}: {
  /** Nome acessível do gráfico. */
  label: string;
  categories: ColumnCategory[];
  columns: ColumnSeries[];
  line?: ColumnSeries;
  mode?: 'grouped' | 'stacked';
}) {
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

  const count = categories.length;
  const stackTotals = categories.map((_, index) => columns.reduce((sum, series) => sum + Math.max(0, series.values[index] ?? 0), 0));
  const values = [
    ...(mode === 'stacked' ? stackTotals : columns.flatMap((series) => series.values)),
    ...(line?.values ?? []),
  ];
  const scale = niceScale(Math.min(...values, 0), Math.max(...values, 0));
  const plotWidth = Math.max(120, width - MARGIN.left - MARGIN.right);
  const plotHeight = HEIGHT - MARGIN.top - MARGIN.bottom;
  const band = plotWidth / Math.max(count, 1);
  const groupSlots = mode === 'stacked' ? 1 : columns.length;
  const barWidth = Math.max(4, Math.min(MAX_BAR, (band * 0.72 - GAP * (groupSlots - 1)) / groupSlots));
  const y = (value: number) => MARGIN.top + ((scale.max - value) / (scale.max - scale.min)) * plotHeight;
  const center = (index: number) => MARGIN.left + band * index + band / 2;
  const baseline = y(0);
  const tooltipLeft = active !== null ? Math.min(Math.max(center(active) - TOOLTIP_WIDTH / 2, 0), width - TOOLTIP_WIDTH) : 0;
  const lastLineIndex = line ? line.values.reduce((last, value, index) => (value !== 0 ? index : last), -1) : -1;
  const tooltipSeries = [...columns, ...(line ? [line] : [])];

  const columnShapes = categories.map((_, index) => {
    if (mode === 'grouped') {
      const left = center(index) - (groupSlots * barWidth + (groupSlots - 1) * GAP) / 2;
      return columns.map((series, slot) => ({
        key: series.key,
        color: series.color,
        d: columnPath(left + slot * (barWidth + GAP), barWidth, baseline, y(Math.max(0, series.values[index] ?? 0)), true),
      }));
    }
    // Empilhadas: segmentos separados por 2px do fundo; só o de cima tem a ponta arredondada.
    const left = center(index) - barWidth / 2;
    const topIndex = columns.reduce((last, series, slot) => ((series.values[index] ?? 0) > 0 ? slot : last), -1);
    let running = 0;
    return columns.map((series, slot) => {
      const value = Math.max(0, series.values[index] ?? 0);
      const bottom = y(running);
      running += value;
      const top = y(running);
      const gapped = slot === topIndex ? top : Math.min(top + GAP, bottom);
      return { key: series.key, color: series.color, d: value > 0 ? columnPath(left, barWidth, bottom, gapped, slot === topIndex) : '' };
    });
  });

  return (
    <div ref={container} className="relative" onPointerLeave={() => setActive(null)}>
      <svg
        width={width}
        height={HEIGHT}
        role="img"
        aria-label={label}
        className="block select-none"
        onPointerMove={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          const index = Math.floor((event.clientX - box.left - MARGIN.left) / band);
          setActive(index >= 0 && index < count ? index : null);
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
        {categories.map((category, index) => (
          <text
            key={category.long}
            x={center(index)}
            y={HEIGHT - 8}
            textAnchor="middle"
            className={`text-[10px] ${active === index ? 'fill-ink-700 dark:fill-ink-200' : 'fill-ink-400'}`}
          >
            {category.short}
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
        {columnShapes.map((shapes, index) => (
          <g key={categories[index].long} opacity={active === null || active === index ? 1 : 0.55}>
            {shapes.map((shape) => shape.d && <path key={shape.key} d={shape.d} fill={shape.color} />)}
          </g>
        ))}
        {line && (
          <>
            <polyline
              points={line.values.map((value, index) => `${center(index)},${y(value)}`).join(' ')}
              fill="none"
              stroke={line.color}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
            {[active ?? lastLineIndex].filter((index) => index >= 0).map((index) => (
              <circle
                key={index}
                cx={center(index)}
                cy={y(line.values[index] ?? 0)}
                r={4}
                fill={line.color}
                stroke="var(--chart-surface)"
                strokeWidth={2}
              />
            ))}
          </>
        )}
        {/* Alvos de foco/teclado: um por categoria, maiores que as marcas. */}
        {categories.map((category, index) => (
          <rect
            key={category.long}
            x={MARGIN.left + band * index}
            y={MARGIN.top}
            width={band}
            height={plotHeight}
            fill="transparent"
            tabIndex={0}
            aria-label={`${category.long}: ${tooltipSeries.map((series) => `${series.label.toLowerCase()} ${formatBRL(series.values[index] ?? 0)}`).join(', ')}`}
            onFocus={() => setActive(index)}
            onBlur={() => setActive(null)}
            className="outline-none focus-visible:stroke-blue-500"
          />
        ))}
      </svg>
      {active !== null && (
        <div
          role="status"
          className="pointer-events-none absolute top-2 rounded-lg border border-ink-200 bg-white px-3 py-2 text-[12px] shadow-pop dark:border-ink-700 dark:bg-ink-900"
          style={{ left: tooltipLeft, width: TOOLTIP_WIDTH }}
        >
          <p className="mb-1 font-medium text-ink-500 dark:text-ink-400">{categories[active].long}</p>
          {tooltipSeries
            // Na pilha, quem não teve valor no mês não entra no tooltip (o total e a tabela continuam completos).
            .filter((series) => mode !== 'stacked' || (series.values[active] ?? 0) !== 0)
            .map((series) => (
            <p key={series.key} className="flex items-center gap-2 whitespace-nowrap">
              <span aria-hidden="true" className="h-0.5 w-3 shrink-0 rounded-full" style={{ background: series.color }} />
              <strong className="tabular-nums text-ink-900 dark:text-white">{formatBRL(series.values[active] ?? 0)}</strong>
              <span className="truncate text-ink-500 dark:text-ink-400">{series.label}</span>
            </p>
          ))}
          {mode === 'stacked' && (
            <p className="mt-1 border-t border-ink-100 pt-1 text-ink-500 dark:border-ink-800 dark:text-ink-400">
              Total <strong className="tabular-nums text-ink-900 dark:text-white">{formatBRL(stackTotals[active])}</strong>
            </p>
          )}
        </div>
      )}
    </div>
  );
}
