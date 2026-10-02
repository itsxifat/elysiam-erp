import { Button, EmptyState, ErrorState, PermissionGate } from '@elysium/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { useAbility } from '../../auth/session.js';
import { control, Field } from './hr-nav.js';
import { getProductivity } from './performance-api.js';
import { usePerfT } from './performance-messages.js';
import { currentMonth, minutesText, PerformanceNav, today } from './performance-shared.js';

/**
 * The order desk's productivity report (§12; M20; D-276).
 *
 * One row per employee with a login, inside the caller's scope: HR's brand, a branch
 * manager's branch, an agent's own row. Pickup time is the median and p90 over the
 * pickups in the window; an active hour is an Asia/Dhaka clock hour with at least one desk
 * action. The server caps a window at 92 days.
 */
export function ProductivityPage() {
  const t = usePerfT();
  const ability = useAbility();
  const mayRead = ability.can('read', 'Target');
  const [from, setFrom] = useState(`${currentMonth()}-01`);
  const [to, setTo] = useState(today());
  const [range, setRange] = useState({ from, to });

  const report = useQuery({
    queryKey: ['performance', 'productivity', range.from, range.to],
    queryFn: () => getProductivity(range.from, range.to),
    enabled: mayRead,
  });
  const items = report.data?.items ?? [];

  return (
    <PermissionGate
      allowed={mayRead}
      explain={{ title: t('perf.deniedTitle'), detail: t('perf.deniedDetail') }}
    >
      <div className="space-y-6">
        <header>
          <h1 className="text-lg font-semibold tracking-tight">{t('perf.productivity')}</h1>
          <p className="text-sm text-muted-foreground">{t('perf.productivityHint')}</p>
        </header>

        <PerformanceNav />

        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            setRange({ from, to });
          }}
        >
          <div className="w-40">
            <Field label={t('perf.from')} id="productivity-from">
              <input
                id="productivity-from"
                type="date"
                value={from}
                required
                className={control}
                onChange={(event) => setFrom(event.target.value)}
              />
            </Field>
          </div>
          <div className="w-40">
            <Field label={t('perf.to')} id="productivity-to">
              <input
                id="productivity-to"
                type="date"
                value={to}
                required
                className={control}
                onChange={(event) => setTo(event.target.value)}
              />
            </Field>
          </div>
          <Button type="submit" size="sm" variant="secondary">
            {t('perf.show')}
          </Button>
        </form>

        {report.isError ? (
          <ErrorState
            title={t('hr.errorTitle')}
            detail={t('hr.errorDetail')}
            action={
              <Button size="sm" variant="secondary" onClick={() => void report.refetch()}>
                {t('hr.retry')}
              </Button>
            }
          />
        ) : items.length === 0 && !report.isLoading ? (
          <EmptyState title={t('hr.emptyTitle')} detail={t('perf.emptyProductivity')} />
        ) : (
          <section aria-label={t('perf.productivity')}>
            <table className="w-full text-sm">
              <caption className="sr-only">{t('perf.productivity')}</caption>
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th scope="col" className="py-2">
                    {t('perf.employee')}
                  </th>
                  <th scope="col" className="py-2 text-right">
                    {t('perf.pickups')}
                  </th>
                  <th scope="col" className="py-2 text-right">
                    {t('perf.medianPickup')}
                  </th>
                  <th scope="col" className="py-2 text-right">
                    {t('perf.p90Pickup')}
                  </th>
                  <th scope="col" className="py-2 text-right">
                    {t('perf.handled')}
                  </th>
                  <th scope="col" className="py-2 text-right">
                    {t('perf.activeHours')}
                  </th>
                  <th scope="col" className="py-2 text-right">
                    {t('perf.perHour')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((row) => (
                  <tr key={row.employeeId} className="h-9 border-b border-border/60">
                    <td className="py-2">
                      <span className="text-muted-foreground tabular-nums">{row.employeeCode}</span>{' '}
                      {row.employeeName}
                    </td>
                    <td className="py-2 text-right tabular-nums">{row.pickups}</td>
                    <td className="py-2 text-right tabular-nums">
                      {minutesText(row.medianPickupSeconds)}
                    </td>
                    <td className="py-2 text-right tabular-nums">
                      {minutesText(row.p90PickupSeconds)}
                    </td>
                    <td className="py-2 text-right tabular-nums">{row.handledOrders}</td>
                    <td className="py-2 text-right tabular-nums">{row.activeHours}</td>
                    <td className="py-2 text-right tabular-nums">
                      {row.ordersPerActiveHour ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}
      </div>
    </PermissionGate>
  );
}
