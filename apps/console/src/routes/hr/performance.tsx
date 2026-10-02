import { Button, EmptyState, ErrorState, PermissionGate } from '@elysium/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { useAbility } from '../../auth/session.js';
import { control, Field } from './hr-nav.js';
import { getMyPerformance, type Target } from './performance-api.js';
import { usePerfT } from './performance-messages.js';
import {
  currentMonth,
  metricKey,
  minutesText,
  PerformanceNav,
  ProgressBar,
  TargetFigure,
} from './performance-shared.js';

/**
 * The agent's own dashboard (M20): this month's targets, week by week, and their own desk
 * figures — pickup time and orders per active hour.
 *
 * Everything here is the caller's and nobody else's: `GET /v1/hr/performance/me` answers
 * with the targets that count them and productivity for their login alone, whatever their
 * role's reach (check 4). An HR officer opening it sees their own, which is usually
 * nothing; the brand's figures are on the Targets and Productivity tabs.
 */
export function MyPerformancePage() {
  const t = usePerfT();
  const ability = useAbility();
  const mayRead = ability.can('read', 'Target');
  const [month, setMonth] = useState(currentMonth());

  const me = useQuery({
    queryKey: ['performance', 'me', month],
    queryFn: () => getMyPerformance(month),
    enabled: mayRead && month !== '',
  });
  const figures = me.data?.productivity ?? null;

  return (
    <PermissionGate
      allowed={mayRead}
      explain={{ title: t('perf.deniedTitle'), detail: t('perf.deniedDetail') }}
    >
      <div className="space-y-6">
        <header>
          <h1 className="text-lg font-semibold tracking-tight">{t('perf.myTitle')}</h1>
          <p className="text-sm text-muted-foreground">{t('perf.myHint')}</p>
        </header>

        <PerformanceNav />

        <div className="w-40">
          <Field label={t('perf.month')} id="me-month">
            <input
              id="me-month"
              type="month"
              value={month}
              className={control}
              onChange={(event) => setMonth(event.target.value)}
            />
          </Field>
        </div>

        {me.isError ? (
          <ErrorState
            title={t('hr.errorTitle')}
            detail={t('hr.errorDetail')}
            action={
              <Button size="sm" variant="secondary" onClick={() => void me.refetch()}>
                {t('hr.retry')}
              </Button>
            }
          />
        ) : me.data?.employee === null ? (
          <EmptyState title={t('hr.emptyTitle')} detail={t('perf.noEmployee')} />
        ) : (
          <>
            <section
              aria-label={t('perf.productivity')}
              className="grid gap-4 rounded-lg border border-border bg-card p-4 sm:grid-cols-4"
            >
              <Figure label={t('perf.pickups')} value={String(figures?.pickups ?? 0)} />
              <Figure
                label={t('perf.medianPickup')}
                value={minutesText(figures?.medianPickupSeconds ?? null)}
              />
              <Figure
                label={t('perf.p90Pickup')}
                value={minutesText(figures?.p90PickupSeconds ?? null)}
              />
              <Figure
                label={t('perf.perHour')}
                value={
                  figures?.ordersPerActiveHour == null ? '—' : String(figures.ordersPerActiveHour)
                }
              />
            </section>

            {(me.data?.targets.length ?? 0) === 0 && !me.isLoading ? (
              <EmptyState title={t('hr.emptyTitle')} detail={t('perf.emptyTargets')} />
            ) : (
              (me.data?.targets ?? []).map((target) => (
                <TargetCard key={target.id} target={target} />
              ))
            )}
          </>
        )}
      </div>
    </PermissionGate>
  );
}

function Figure({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="space-y-0.5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-base font-medium tabular-nums">{value}</p>
    </div>
  );
}

/** One target and its weeks: what was planned for each, and what has been done. */
export function TargetCard({ target }: { readonly target: Target }) {
  const t = usePerfT();
  return (
    <section
      aria-label={t(metricKey(target.metric))}
      className="space-y-3 rounded-lg border border-border bg-card p-4"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold">{t(metricKey(target.metric))}</h2>
        <div className="flex items-center gap-4 text-sm">
          <span className="text-muted-foreground">
            {t('perf.achieved')}{' '}
            <span className="font-medium text-foreground">
              <TargetFigure metric={target.metric} value={target.achieved} />
            </span>{' '}
            / <TargetFigure metric={target.metric} value={target.targetValue} />
          </span>
          <ProgressBar pctBps={target.pctBps} label={t('perf.progress')} />
        </div>
      </div>
      <table className="w-full text-sm">
        <caption className="sr-only">{t(metricKey(target.metric))}</caption>
        <thead>
          <tr className="border-b border-border text-left text-xs text-muted-foreground">
            <th scope="col" className="py-2">
              {t('perf.week')}
            </th>
            <th scope="col" className="py-2 text-right">
              {t('perf.workingDays')}
            </th>
            <th scope="col" className="py-2 text-right">
              {t('perf.planned')}
            </th>
            <th scope="col" className="py-2 text-right">
              {t('perf.achieved')}
            </th>
          </tr>
        </thead>
        <tbody>
          {target.weeks.map((week) => (
            <tr key={week.weekNo} className="h-9 border-b border-border/60">
              <td className="py-2 tabular-nums">
                {week.weekNo} · {week.startsOn.slice(5)}–{week.endsOn.slice(5)}
              </td>
              <td className="py-2 text-right tabular-nums">{week.workingDays}</td>
              <td className="py-2 text-right">
                <TargetFigure metric={target.metric} value={week.planned} />
              </td>
              <td className="py-2 text-right">
                <TargetFigure metric={target.metric} value={week.achieved} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
