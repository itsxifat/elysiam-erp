import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react';
import type { ReactNode } from 'react';

import { cn } from '../lib/cn.js';

/**
 * Figures (D-446): the KPI card, its sparkline, its delta, and the compact list the
 * secondary figures go in.
 *
 * A dashboard of twelve identical boxes has no hierarchy, so a reader cannot tell
 * which number matters. These split the job: three or four `StatCard`s carry the
 * figures a person opens the page for, in a large weight with their trend; the rest
 * sit in a `MetricList`, label and value on one line, the way a statement reads.
 */

export interface StatDelta {
  /** Already formatted, e.g. "12.4%" or "৳1,200". */
  readonly label: string;
  readonly direction: 'up' | 'down' | 'flat';
  /** Whether this direction is good news. Returns going up is not. */
  readonly tone?: 'positive' | 'negative' | 'neutral';
  /** What it is compared with, e.g. "vs last week". */
  readonly caption?: string;
}

export interface StatCardProps {
  readonly label: string;
  readonly value: ReactNode;
  readonly delta?: StatDelta;
  /** A short series, oldest first, for the sparkline. Two points or more. */
  readonly trend?: readonly number[];
  /** One line under the figure: what it counts. */
  readonly hint?: ReactNode;
  /** Rendered as the card's footer: a link to the screen behind the figure. */
  readonly footer?: ReactNode;
  readonly className?: string;
}

export function StatCard({ label, value, delta, trend, hint, footer, className }: StatCardProps) {
  return (
    <div
      className={cn(
        'flex flex-col rounded-lg border border-border bg-card p-5 text-card-foreground',
        className,
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        {delta === undefined ? null : <Delta {...delta} />}
      </div>
      <p className="mt-2 text-2xl font-medium tabular-nums">{value}</p>
      <div className="mt-1 flex min-h-8 items-end justify-between gap-4">
        <p className="text-xs text-muted-foreground">{hint ?? delta?.caption ?? ''}</p>
        {hasShape(trend) ? <Sparkline points={trend} className="h-8 w-24 shrink-0" /> : null}
      </div>
      {footer === undefined ? null : (
        <div className="mt-4 border-t border-border pt-3 text-sm">{footer}</div>
      )}
    </div>
  );
}

/**
 * A sparkline earns its place only when there is a shape to show: three days or more
 * with something in them. A flat line that jumps on the last day reads as a broken
 * chart, not as a trend.
 */
function hasShape(trend: readonly number[] | undefined): trend is readonly number[] {
  if (trend === undefined || trend.length < 3) return false;
  return trend.filter((point) => point !== 0).length >= 3;
}

/** A change, as an arrow and a figure. The arrow carries the direction; the colour its tone. */
export function Delta({ label, direction, tone = 'neutral' }: StatDelta) {
  const Icon = direction === 'up' ? ArrowUpRight : direction === 'down' ? ArrowDownRight : Minus;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-0.5 rounded-xs px-1 py-0.5 text-xs font-medium tabular-nums',
        tone === 'positive' && 'bg-success-subtle text-success-subtle-foreground',
        tone === 'negative' && 'bg-destructive-subtle text-destructive-subtle-foreground',
        tone === 'neutral' && 'bg-muted text-muted-foreground',
      )}
    >
      <Icon aria-hidden="true" className="size-3.5" />
      {label}
    </span>
  );
}

/**
 * A trend line with no axes: the shape of the last few days, beside the number it
 * explains. Inline SVG in the accent, so it costs nothing and themes with the page.
 * Decorative (the number and the delta carry the meaning), so it is hidden from
 * assistive technology.
 */
export function Sparkline({
  points,
  className,
}: {
  readonly points: readonly number[];
  readonly className?: string;
}) {
  const width = 96;
  const height = 32;
  const pad = 2;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const step = points.length > 1 ? (width - pad * 2) / (points.length - 1) : 0;
  const coords = points.map((point, index) => {
    const x = pad + index * step;
    const y = height - pad - ((point - min) / span) * (height - pad * 2);
    return [x, y] as const;
  });
  // Coordinates to a tenth of a pixel, by integer arithmetic: this is geometry, not money,
  // but the repo's float rule cannot tell the two apart and should not have to.
  const px = (value: number) => String(Math.round(value * 10) / 10);
  const line = coords
    .map(([x, y], index) => `${index === 0 ? 'M' : 'L'}${px(x)} ${px(y)}`)
    .join(' ');
  const last = coords[coords.length - 1];
  const area = `${line} L${px(last?.[0] ?? 0)} ${height} L${pad} ${height} Z`;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      className={cn('text-chart-1', className)}
    >
      <path d={area} fill="currentColor" opacity={0.08} />
      <path
        d={line}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

/**
 * Secondary figures, one per line: label left, value right, hairlines between.
 * The way a bank statement lists them, which is how the owner already reads money.
 */
export function MetricList({
  items,
  className,
}: {
  readonly items: readonly {
    readonly label: ReactNode;
    readonly value: ReactNode;
    readonly hint?: ReactNode;
  }[];
  readonly className?: string;
}) {
  return (
    <dl className={cn('divide-y divide-border', className)}>
      {items.map((item, index) => (
        <div key={index} className="flex items-baseline justify-between gap-4 py-2.5">
          <dt className="min-w-0 text-sm text-muted-foreground">
            {item.label}
            {item.hint === undefined ? null : (
              <span className="block text-xs text-muted-foreground">{item.hint}</span>
            )}
          </dt>
          <dd className="shrink-0 text-sm font-medium text-foreground tabular-nums">
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
