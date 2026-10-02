import { Money } from '@elysium/ui';
import { formatMoney, type Locale } from '@elysium/i18n';
import { useId, useState, type KeyboardEvent, type PointerEvent } from 'react';

import type { SeriesPoint } from './api.js';

/**
 * Delivered revenue per day, as columns (M24). Its own chunk, loaded after the figures.
 *
 * One series and one axis, so no legend: the section title names what is drawn. Columns are
 * at most 24 px wide with a 4 px rounded top and a square foot on the baseline, in the one
 * accent token; gridlines are hairlines in the border token. Every day has a hit area the
 * full height of its slot, so the pointer finds a day rather than a bar; the arrow keys walk
 * the days when the chart has focus; and the same figures are a table one click below
 * (`<details>`), so nothing is reachable only by hovering. Amounts become numbers only to be
 * drawn; every amount shown is the server's poisha string through `<Money>`.
 */
export function TrendChart({
  series,
  label,
  tableLabel,
  dateLabel,
  revenueLabel,
  deliveredLabel,
  locale,
}: {
  readonly series: readonly SeriesPoint[];
  readonly label: string;
  readonly tableLabel: string;
  readonly dateLabel: string;
  readonly revenueLabel: string;
  readonly deliveredLabel: string;
  readonly locale: Locale;
}) {
  const id = useId();
  const [active, setActive] = useState<number | null>(null);
  const width = 720;
  const height = 200;
  const left = 8;
  const right = 8;
  const top = 18;
  const bottom = 20;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const values = series.map((point) => Number(point.deliveredRevenuePoisha));
  const max = Math.max(1, ...values);
  const slot = series.length === 0 ? 0 : plotWidth / series.length;
  const barWidth = Math.max(1, Math.min(24, slot - 2));
  const y = (value: number) => top + plotHeight - (value / max) * plotHeight;
  const baseline = top + plotHeight;
  const px = (value: number) => Math.round(value * 10) / 10;

  /** A column with a 4 px rounded top and a square foot on the baseline. */
  const column = (x: number, value: number): string => {
    const h = baseline - y(value);
    if (h <= 0) return '';
    const r = Math.min(4, barWidth / 2, h);
    const x0 = px(x);
    const x1 = px(x + barWidth);
    const yt = px(baseline - h);
    return `M${String(x0)},${String(baseline)} V${String(px(yt + r))} Q${String(x0)},${String(yt)} ${String(px(x0 + r))},${String(yt)} H${String(px(x1 - r))} Q${String(x1)},${String(yt)} ${String(x1)},${String(px(yt + r))} V${String(baseline)} Z`;
  };

  const pick = (event: PointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const x = ((event.clientX - box.left) / box.width) * width - left;
    const index = Math.floor(x / Math.max(slot, 1));
    setActive(index >= 0 && index < series.length ? index : null);
  };

  const walk = (event: KeyboardEvent<SVGSVGElement>) => {
    if (series.length === 0) return;
    const last = series.length - 1;
    const next =
      event.key === 'ArrowRight'
        ? Math.min((active ?? -1) + 1, last)
        : event.key === 'ArrowLeft'
          ? Math.max((active ?? series.length) - 1, 0)
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? last
              : null;
    if (next === null) return;
    event.preventDefault();
    setActive(next);
  };

  const point = active === null ? undefined : series[active];

  return (
    <figure className="space-y-3">
      <div className="relative">
        <svg
          role="img"
          aria-label={label}
          aria-describedby={point === undefined ? undefined : `${id}-tip`}
          tabIndex={0}
          viewBox={`0 0 ${String(width)} ${String(height)}`}
          className="h-52 w-full rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
          preserveAspectRatio="none"
          onPointerMove={pick}
          onPointerLeave={() => {
            setActive(null);
          }}
          onKeyDown={walk}
          onBlur={() => {
            setActive(null);
          }}
        >
          <title>{label}</title>
          {[0, 0.5, 1].map((share) => (
            <line
              key={share}
              x1={left}
              x2={width - right}
              y1={px(top + plotHeight * (1 - share))}
              y2={px(top + plotHeight * (1 - share))}
              className="stroke-border"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {series.map((day, index) => (
            <path
              key={day.date}
              d={column(
                left + slot * index + (slot - barWidth) / 2,
                Number(day.deliveredRevenuePoisha),
              )}
              className={
                active === null || active === index ? 'fill-primary' : 'fill-primary opacity-60'
              }
            />
          ))}
        </svg>
        <span className="pointer-events-none absolute top-0 left-2 text-xs text-muted-foreground tabular-nums">
          {formatMoney(
            series.reduce((most, day) => {
              const value = BigInt(day.deliveredRevenuePoisha);
              return value > most ? value : most;
            }, 0n),
            { locale },
          )}
        </span>
        {point === undefined ? null : (
          <div
            id={`${id}-tip`}
            role="status"
            className="pointer-events-none absolute top-0 right-2 z-10 rounded-md border border-border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-sm"
          >
            <p className="text-sm font-semibold tabular-nums">
              <Money poisha={point.deliveredRevenuePoisha} locale={locale} />
            </p>
            <p className="text-muted-foreground tabular-nums">
              {point.date} · {deliveredLabel} {String(point.ordersDelivered)}
            </p>
          </div>
        )}
        <div className="flex justify-between px-2 text-xs text-muted-foreground tabular-nums">
          <span>{series[0]?.date ?? ''}</span>
          <span>{series[series.length - 1]?.date ?? ''}</span>
        </div>
      </div>
      <details className="text-sm">
        <summary className="cursor-pointer rounded-sm text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
          {tableLabel}
        </summary>
        <table className="mt-2 w-full text-sm">
          <thead>
            <tr className="border-b border-border">
              <th className="h-row px-2 text-left text-xs font-medium text-muted-foreground">
                {dateLabel}
              </th>
              <th className="h-row px-2 text-right text-xs font-medium text-muted-foreground">
                {deliveredLabel}
              </th>
              <th className="h-row px-2 text-right text-xs font-medium text-muted-foreground">
                {revenueLabel}
              </th>
            </tr>
          </thead>
          <tbody>
            {series.map((day) => (
              <tr key={day.date} className="border-b border-border">
                <td className="h-row px-2 tabular-nums">{day.date}</td>
                <td className="h-row px-2 text-right tabular-nums">{day.ordersDelivered}</td>
                <td className="h-row px-2 text-right tabular-nums">
                  <Money poisha={day.deliveredRevenuePoisha} locale={locale} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
