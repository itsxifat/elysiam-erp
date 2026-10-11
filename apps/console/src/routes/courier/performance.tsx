import { Button, EmptyState, ErrorState, PermissionGate, Skeleton } from '@elysium/ui';
import { useQuery } from '@tanstack/react-query';
import { Fragment, useMemo, useState } from 'react';

import { useAbility } from '../../auth/session.js';
import { useLocale } from '../../i18n/locale.js';
import { deliveryZones, performance, type PerformanceRow } from './api.js';
import { CourierHeader, Field } from './courier-nav.js';
import { daysBefore, percentOfBps, todayInDhaka } from './courier-ui.js';
import { useCourierT } from './messages.js';
import { DateRangePicker } from '../../ui/date-picker.js';

/**
 * Courier performance by zone (M15): delivery rate, return rate and average days to deliver.
 *
 * `read LedgerReport`, like the other courier reports — it is what a brand chooses couriers
 * and writes its selection rules from. Every number comes from the server already computed
 * in integers (rates in basis points, the mean as a one-decimal string); this screen formats
 * and never divides.
 *
 * The window is by booking date in Asia/Dhaka, defaulting to the last thirty days. Zone names
 * come from the orders module's own zone list; a parcel booked before M15 recorded its zone
 * shows as "no zone recorded" rather than being guessed into one.
 */
export function CourierPerformancePage() {
  const t = useCourierT();
  const { locale } = useLocale();
  const ability = useAbility();
  const mayRead = ability.can('read', 'LedgerReport');

  const today = todayInDhaka();
  const [from, setFrom] = useState(daysBefore(today, 29));
  const [to, setTo] = useState(today);

  const report = useQuery({
    queryKey: ['courier', 'performance', from, to],
    queryFn: () => performance({ from, to }),
    enabled: mayRead && from <= to,
  });
  const zones = useQuery({
    queryKey: ['courier', 'delivery-zones'],
    queryFn: deliveryZones,
    enabled: mayRead && ability.can('read', 'Catalog'),
    staleTime: 10 * 60_000,
  });

  const zoneName = useMemo(() => {
    const names = new Map((zones.data?.zones ?? []).map((zone) => [zone.id, zone.nameEn]));
    return (id: string | null) =>
      id === null ? t('courier.performance.noZone') : (names.get(id) ?? id.slice(0, 8));
  }, [zones.data, locale, t]);

  const rows = report.data?.rows ?? [];
  const couriers = report.data?.couriers ?? [];

  return (
    <PermissionGate
      allowed={mayRead}
      explain={{ title: t('courier.deniedTitle'), detail: t('courier.deniedDetail') }}
    >
      <div className="space-y-5">
        <CourierHeader
          title={t('courier.performance.heading')}
          caption={t('courier.performance.caption')}
        />

        <div className="flex flex-wrap items-end gap-3">
          <Field
            label={`${t('courier.performance.from')} – ${t('courier.performance.to')}`}
            id="performance-period"
          >
            <DateRangePicker
              id="performance-period"
              value={{ from, to }}
              max={today}
              onValueChange={(range) => {
                if (range.from !== '') setFrom(range.from);
                if (range.to !== '') setTo(range.to);
              }}
            />
          </Field>
        </div>

        {report.isPending ? (
          <Skeleton className="h-40 w-full" />
        ) : report.isError ? (
          <ErrorState
            title={t('courier.errorTitle')}
            detail={report.error instanceof Error ? report.error.message : t('courier.errorDetail')}
            action={
              <Button size="sm" variant="outline" onClick={() => void report.refetch()}>
                {t('courier.retry')}
              </Button>
            }
          />
        ) : couriers.length === 0 ? (
          <EmptyState
            title={t('courier.performance.emptyTitle')}
            detail={t('courier.performance.emptyDetail')}
          />
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <caption className="sr-only">{t('courier.performance.heading')}</caption>
              <thead>
                <tr className="border-b border-border bg-muted text-left text-xs text-muted-foreground">
                  <th scope="col" className="px-3 py-2">
                    {t('courier.colCourier')}
                  </th>
                  <th scope="col" className="px-3 py-2">
                    {t('courier.performance.colZone')}
                  </th>
                  <th scope="col" className="px-3 py-2 text-right">
                    {t('courier.performance.colBooked')}
                  </th>
                  <th scope="col" className="px-3 py-2 text-right">
                    {t('courier.performance.colDelivered')}
                  </th>
                  <th scope="col" className="px-3 py-2 text-right">
                    {t('courier.performance.colReturned')}
                  </th>
                  <th scope="col" className="px-3 py-2 text-right">
                    {t('courier.performance.colInFlight')}
                  </th>
                  <th scope="col" className="px-3 py-2 text-right">
                    {t('courier.performance.colDeliveryRate')}
                  </th>
                  <th scope="col" className="px-3 py-2 text-right">
                    {t('courier.performance.colReturnRate')}
                  </th>
                  <th scope="col" className="px-3 py-2 text-right">
                    {t('courier.performance.colAvgDays')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {couriers.map((courier) => (
                  <Fragment key={courier.courierId}>
                    <Row
                      row={courier}
                      label={courier.courierName}
                      zone={t('courier.performance.allZones')}
                      strong
                    />
                    {rows
                      .filter((row) => row.courierId === courier.courierId)
                      .map((row) => (
                        <Row
                          key={`${row.courierId}:${row.deliveryZoneId ?? ''}`}
                          row={row}
                          label=""
                          zone={zoneName(row.deliveryZoneId)}
                        />
                      ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </PermissionGate>
  );
}

function Row({
  row,
  label,
  zone,
  strong = false,
}: {
  readonly row: PerformanceRow;
  readonly label: string;
  readonly zone: string;
  readonly strong?: boolean;
}) {
  const cell = 'px-3 text-right tabular-nums';
  return (
    <tr
      className={`h-row border-b border-border last:border-0 ${strong ? 'bg-muted/40 font-medium' : ''}`}
    >
      <td className="px-3">{label}</td>
      <td className={`px-3 ${strong ? '' : 'text-muted-foreground'}`}>{zone}</td>
      <td className={cell}>{row.booked}</td>
      <td className={cell}>{row.delivered}</td>
      <td className={cell}>{row.returned}</td>
      <td className={cell}>{row.inFlight}</td>
      <td className={cell}>{percentOfBps(row.deliveryRateBps)}</td>
      <td className={cell}>{percentOfBps(row.returnRateBps)}</td>
      <td className={cell}>{row.averageDeliveryDays ?? '—'}</td>
    </tr>
  );
}
