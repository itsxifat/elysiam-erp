import { cn } from '@elysium/ui';
import { formatDate, type Locale } from '@elysium/i18n';
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';

/**
 * A line per brand over a period (D-496), drawn as plain SVG with the kit's tokens.
 *
 * The dataviz rules it keeps: one y-axis (one measure per chart, the owner picks which);
 * 2px lines with round joins; 8px end dots ringed in the card colour; hairline solid
 * gridlines; categorical colours in a fixed order by brand (a brand keeps its colour
 * whatever is filtered); a legend with line keys, since there are two or more series;
 * text in text colours, never the series colour; a crosshair and one tooltip listing every
 * brand at that day, by pointer and by keyboard; and a table view, which slots 3–5 need
 * on the light theme where they sit under 3:1.
 */

/** Full class names, so Tailwind finds them: `stroke-series-${n}` would not be generated. */
const STROKE = [
  'stroke-series-1',
  'stroke-series-2',
  'stroke-series-3',
  'stroke-series-4',
  'stroke-series-5',
  'stroke-series-6',
  'stroke-series-7',
  'stroke-series-8',
] as const;
const FILL = [
  'fill-series-1',
  'fill-series-2',
  'fill-series-3',
  'fill-series-4',
  'fill-series-5',
  'fill-series-6',
  'fill-series-7',
  'fill-series-8',
] as const;
const BG = [
  'bg-series-1',
  'bg-series-2',
  'bg-series-3',
  'bg-series-4',
  'bg-series-5',
  'bg-series-6',
  'bg-series-7',
  'bg-series-8',
] as const;

export interface TrendSeries {
  readonly key: string;
  readonly label: string;
  /** 0-based categorical slot; fixed per brand by its place in the registry. */
  readonly slot: number;
  /** For drawing only (pixels); what is read comes from `display`. */
  readonly values: readonly number[];
}

export interface TrendChartProps {
  readonly dates: readonly string[];
  readonly series: readonly TrendSeries[];
  /** An axis tick, from a plotted value. */
  readonly tick: (value: number) => string;
  /** One exact value, as text, for the tooltip and the table. */
  readonly display: (seriesIndex: number, dayIndex: number) => string;
  readonly locale: Locale;
  readonly title: string;
  readonly showTableLabel: string;
  readonly showChartLabel: string;
  readonly dateHeading: string;
  /** Off for a single series: the title already names it, and one swatch adds nothing. */
  readonly legend?: boolean;
}

const PLOT_HEIGHT = 220;
const AXIS_BAND = 28;
const LEFT = 64;
const RIGHT = 16;
const TOP = 12;

/** Clean tick values from 0 to at least `max`: 1, 2, 2.5 or 5 times a power of ten. */
export function niceTicks(max: number, count = 4): number[] {
  if (!(max > 0)) return [0, 1];
  const raw = max / count;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step =
    [1, 2, 2.5, 5, 10].map((factor) => factor * power).find((candidate) => candidate >= raw) ??
    10 * power;
  const ticks: number[] = [];
  for (let value = 0; value < max + step * 0.5; value += step) ticks.push(value);
  if ((ticks.at(-1) ?? 0) < max) ticks.push((ticks.at(-1) ?? 0) + step);
  return ticks;
}

export function TrendChart({
  dates,
  series,
  tick,
  display,
  locale,
  title,
  showTableLabel,
  showChartLabel,
  dateHeading,
  legend = true,
}: TrendChartProps) {
  const holder = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [active, setActive] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);
  const descriptionId = useId();
  const tooltip = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = holder.current;
    if (element === null) return;
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width;
      if (next !== undefined && next > 0) setWidth(Math.round(next));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const max = Math.max(0, ...series.flatMap((line) => line.values));
  const ticks = niceTicks(max);
  const top = ticks.at(-1) ?? 1;
  const plotWidth = Math.max(80, width - LEFT - RIGHT);
  const x = (index: number) =>
    LEFT + (dates.length <= 1 ? plotWidth / 2 : (index * plotWidth) / (dates.length - 1));
  const y = (value: number) => TOP + PLOT_HEIGHT - (value / top) * PLOT_HEIGHT;
  const last = dates.length - 1;

  function nearest(event: PointerEvent<SVGSVGElement>): number {
    const box = event.currentTarget.getBoundingClientRect();
    const position = event.clientX - box.left - LEFT;
    if (dates.length <= 1) return 0;
    return Math.min(last, Math.max(0, Math.round((position / plotWidth) * last)));
  }

  function onKey(event: KeyboardEvent<SVGSVGElement>) {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      const step = event.key === 'ArrowLeft' ? -1 : 1;
      setActive((current) => Math.min(last, Math.max(0, (current ?? last) + step)));
    } else if (event.key === 'Home') {
      setActive(0);
    } else if (event.key === 'End') {
      setActive(last);
    } else if (event.key === 'Escape') {
      setActive(null);
    }
  }

  const labelDays = dates.length <= 1 ? [0] : [0, Math.floor(last / 2), last];
  const tooltipLeft = active === null ? 0 : Math.min(Math.max(x(active) + 12, 8), width - 220);

  // Positioned through a custom property set on the element, not an inline style (§24).
  useLayoutEffect(() => {
    tooltip.current?.style.setProperty('--tip-left', `${String(tooltipLeft)}px`);
  }, [tooltipLeft, active]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <ul
          className={cn('flex flex-wrap gap-x-4 gap-y-1.5', !legend && 'invisible')}
          aria-label={title}
        >
          {series.map((line) => (
            <li key={line.key} className="flex items-center gap-2 text-xs text-muted-foreground">
              <span
                aria-hidden="true"
                className={cn('h-0.5 w-4 rounded-full', BG[line.slot % BG.length])}
              />
              {line.label}
            </li>
          ))}
        </ul>
        <button
          type="button"
          onClick={() => setAsTable((value) => !value)}
          className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          {asTable ? showChartLabel : showTableLabel}
        </button>
      </div>

      {asTable ? (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full text-sm">
            <caption className="sr-only">{title}</caption>
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th scope="col" className="px-3 py-2 font-medium">
                  {dateHeading}
                </th>
                {series.map((line) => (
                  <th key={line.key} scope="col" className="px-3 py-2 text-right font-medium">
                    {line.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {dates.map((date, day) => (
                <tr key={date} className="border-b border-border last:border-0">
                  <th
                    scope="row"
                    className="px-3 py-1.5 text-left font-normal text-muted-foreground"
                  >
                    {formatDate(date, { locale })}
                  </th>
                  {series.map((line, index) => (
                    <td key={line.key} className="px-3 py-1.5 text-right tabular-nums">
                      {display(index, day)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div ref={holder} className="relative">
          <svg
            role="img"
            aria-label={title}
            aria-describedby={descriptionId}
            tabIndex={0}
            width={width}
            height={TOP + PLOT_HEIGHT + AXIS_BAND}
            className="block touch-none rounded-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            onPointerMove={(event) => setActive(nearest(event))}
            onPointerLeave={() => setActive(null)}
            onFocus={() => setActive((current) => current ?? last)}
            onBlur={() => setActive(null)}
            onKeyDown={onKey}
          >
            <desc id={descriptionId}>{title}</desc>
            {ticks.map((value) => (
              <g key={value}>
                <line
                  x1={LEFT}
                  x2={LEFT + plotWidth}
                  y1={y(value)}
                  y2={y(value)}
                  className={value === 0 ? 'stroke-border' : 'stroke-chart-grid'}
                  strokeWidth={1}
                />
                <text
                  x={LEFT - 8}
                  y={y(value)}
                  dy="0.32em"
                  textAnchor="end"
                  className="fill-muted-foreground text-[11px] tabular-nums"
                >
                  {tick(value)}
                </text>
              </g>
            ))}
            {labelDays.map((day) => (
              <text
                key={day}
                x={x(day)}
                y={TOP + PLOT_HEIGHT + 18}
                textAnchor={
                  day === 0 && dates.length > 1 ? 'start' : day === last ? 'end' : 'middle'
                }
                className="fill-muted-foreground text-[11px]"
              >
                {dates[day] === undefined ? '' : formatDate(dates[day] ?? '', { locale })}
              </text>
            ))}
            {active === null ? null : (
              <line
                x1={x(active)}
                x2={x(active)}
                y1={TOP}
                y2={TOP + PLOT_HEIGHT}
                className="stroke-border"
                strokeWidth={1}
              />
            )}
            {series.map((line) => (
              <polyline
                key={line.key}
                fill="none"
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
                className={STROKE[line.slot % STROKE.length]}
                points={line.values.map((value, index) => `${x(index)},${y(value)}`).join(' ')}
              />
            ))}
            {series.map((line) => {
              const day = active ?? last;
              const value = line.values[day];
              if (value === undefined) return null;
              return (
                <circle
                  key={line.key}
                  cx={x(day)}
                  cy={y(value)}
                  r={4}
                  strokeWidth={2}
                  className={cn('stroke-card', FILL[line.slot % FILL.length])}
                />
              );
            })}
          </svg>
          {active === null ? null : (
            <div
              role="status"
              className="pointer-events-none absolute top-2 left-(--tip-left) z-10 w-52 rounded-md border border-border bg-popover p-2.5 text-xs text-popover-foreground shadow-popover"
              ref={tooltip}
            >
              <p className="mb-1.5 text-muted-foreground">
                {formatDate(dates[active] ?? '', { locale })}
              </p>
              <ul className="space-y-1">
                {series.map((line, index) => (
                  <li key={line.key} className="flex items-center gap-2">
                    <span
                      aria-hidden="true"
                      className={cn('h-0.5 w-3 shrink-0 rounded-full', BG[line.slot % BG.length])}
                    />
                    <span className="font-semibold tabular-nums">{display(index, active)}</span>
                    <span className="truncate text-muted-foreground">{line.label}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
