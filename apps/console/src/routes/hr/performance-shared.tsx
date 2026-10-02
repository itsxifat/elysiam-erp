import { Money } from '@elysium/ui';
import { Link } from '@tanstack/react-router';

import { useAbility } from '../../auth/session.js';
import { hrPath } from './hr-nav.js';
import type { TargetMetric } from './performance-api.js';
import { usePerfT, type PerfMessageKey } from './performance-messages.js';

/**
 * The performance section's tabs (M20), filtered by ability like `HrNav`.
 *
 * Every desk role holds `read Target` for itself, so the dashboard, targets and
 * productivity tabs are everybody's — each answers with the caller's own rows. Bonus
 * rules are pay, behind `read Payroll` (D-278), so an agent is never shown a tab that
 * would answer 403.
 */
export function PerformanceNav() {
  const t = usePerfT();
  const ability = useAbility();
  const tab =
    'rounded-md px-2.5 py-1 text-sm text-muted-foreground transition-colors duration-150 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
  const active = { className: `${tab} bg-muted font-medium text-foreground` };

  return (
    <nav aria-label={t('perf.title')} className="flex flex-wrap gap-1">
      <Link
        to={hrPath('/performance')}
        className={tab}
        activeProps={active}
        activeOptions={{ exact: true }}
      >
        {t('perf.myTitle')}
      </Link>
      <Link to={hrPath('/performance/targets')} className={tab} activeProps={active}>
        {t('perf.targets')}
      </Link>
      <Link to={hrPath('/performance/productivity')} className={tab} activeProps={active}>
        {t('perf.productivity')}
      </Link>
      {ability.can('read', 'Payroll') ? (
        <Link to={hrPath('/performance/bonus-rules')} className={tab} activeProps={active}>
          {t('perf.bonusRules')}
        </Link>
      ) : null}
    </nav>
  );
}

export const metricKey = (metric: TargetMetric): PerfMessageKey => `perf.metric.${metric}`;

/** A target figure in its own unit: money for revenue, a plain count otherwise. */
export function TargetFigure({
  metric,
  value,
}: {
  readonly metric: TargetMetric;
  readonly value: string;
}) {
  return metric === 'delivered_revenue' ? (
    <Money poisha={value} />
  ) : (
    <span className="tabular-nums">{value}</span>
  );
}

/**
 * Progress against a target, as a bar and a percentage.
 *
 * The bar stops at 100% so a 140% month does not overflow its row; the number beside it
 * says 140.00%. Colours are tokens: the primary accent while short, success once met.
 */
export function ProgressBar({
  pctBps,
  label,
}: {
  readonly pctBps: number;
  readonly label: string;
}) {
  const value = Math.min(pctBps, 10_000) / 100;
  // A native <progress>: the browser exposes it to assistive technology as a progress bar,
  // and its fill is styled through the pseudo-elements rather than an inline width.
  const fill =
    pctBps >= 10_000
      ? '[&::-moz-progress-bar]:bg-success [&::-webkit-progress-value]:bg-success'
      : '[&::-moz-progress-bar]:bg-primary [&::-webkit-progress-value]:bg-primary';
  return (
    <div className="flex items-center gap-2">
      <progress
        aria-label={label}
        value={value}
        max={100}
        className={`h-1.5 w-24 appearance-none overflow-hidden rounded-full bg-muted [&::-webkit-progress-bar]:bg-muted [&::-webkit-progress-value]:rounded-full ${fill}`}
      />
      <span className="text-xs text-muted-foreground tabular-nums">{percentText(pctBps)}</span>
    </div>
  );
}

/** Basis points as a percentage, in integers: 12,345 is `123.45%`. */
export function percentText(bps: number): string {
  return `${String(Math.trunc(bps / 100))}.${String(bps % 100).padStart(2, '0')}%`;
}

/** Seconds as `m:ss`, or an em dash when there is no sample yet. */
export function minutesText(seconds: number | null): string {
  if (seconds === null) return '—';
  return `${String(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, '0')}`;
}

/** This month in Asia/Dhaka, as `YYYY-MM`. */
export function currentMonth(): string {
  return today().slice(0, 7);
}

/** Today in Asia/Dhaka, as `YYYY-MM-DD`. */
export function today(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Dhaka',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}
