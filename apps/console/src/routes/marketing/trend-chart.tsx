import type { SeriesPoint } from './api.js';

/**
 * Spend (bars) against delivered revenue (line), one point a day (M18).
 *
 * Inline SVG, loaded on its own chunk after the figures: the dashboard is readable before
 * it arrives, and it adds no charting dependency to the console. Colours are tokens only
 * (§24): the line is the one accent, the bars are the muted foreground at low opacity.
 * Amounts are poisha strings; they become numbers only to be *drawn*, never to be shown.
 */
export function TrendChart({
  series,
  label,
  spendLabel,
  revenueLabel,
}: {
  readonly series: readonly SeriesPoint[];
  readonly label: string;
  readonly spendLabel: string;
  readonly revenueLabel: string;
}) {
  const width = 720;
  const height = 180;
  const pad = 8;
  const values = series.flatMap((point) => [
    Number(point.spendPoisha),
    Number(point.deliveredRevenuePoisha),
  ]);
  const max = Math.max(1, ...values);
  const step = series.length === 0 ? 0 : (width - pad * 2) / series.length;
  const y = (value: number) => height - pad - (value / max) * (height - pad * 2);
  const line = series
    .map((point, index) => {
      const x = pad + step * index + step / 2;
      const at = y(Number(point.deliveredRevenuePoisha));
      // Pixel coordinates, not amounts: rounded to a tenth of a pixel for a short path.
      const px = (value: number) => String(Math.round(value * 10) / 10);
      return `${index === 0 ? 'M' : 'L'}${px(x)},${px(at)}`;
    })
    .join(' ');

  return (
    <figure className="space-y-2">
      <svg
        role="img"
        aria-label={label}
        viewBox={`0 0 ${String(width)} ${String(height)}`}
        className="h-44 w-full"
        preserveAspectRatio="none"
      >
        <title>{label}</title>
        <line
          x1={pad}
          x2={width - pad}
          y1={height - pad}
          y2={height - pad}
          className="stroke-border"
          strokeWidth={1}
        />
        {series.map((point, index) => {
          const top = y(Number(point.spendPoisha));
          return (
            <rect
              key={point.date}
              x={pad + step * index + step * 0.15}
              width={Math.max(step * 0.7, 1)}
              y={top}
              height={Math.max(height - pad - top, 0)}
              className="fill-muted-foreground/30"
            />
          );
        })}
        {series.length > 0 ? (
          <path
            d={line}
            fill="none"
            className="stroke-primary"
            strokeWidth={2}
            vectorEffect="non-scaling-stroke"
          />
        ) : null}
      </svg>
      <figcaption className="flex flex-wrap gap-4 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="inline-block size-2.5 rounded-sm bg-muted-foreground/30"
          />
          {spendLabel}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden="true" className="inline-block h-0.5 w-3 bg-primary" />
          {revenueLabel}
        </span>
      </figcaption>
    </figure>
  );
}
