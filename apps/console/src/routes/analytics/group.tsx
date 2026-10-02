import { Money, PermissionGate, Skeleton } from '@elysium/ui';
import { useQuery } from '@tanstack/react-query';
import { useId, useState } from 'react';

import { useSession } from '../../auth/session.js';
import { useLocale } from '../../i18n/locale.js';
import {
  AnalyticsHeader,
  BUTTON,
  CELL,
  HEAD,
  HEAD_NUMERIC,
  INPUT,
  NUMERIC,
  Section,
} from './analytics-nav.js';
import { getConsolidated, type Consolidated } from './api.js';
import { daysInclusive, dhakaToday, monthStart, percent, roas } from './format.js';
import { useAnalyticsT } from './messages.js';

type BrandLine = Consolidated['group'] & { readonly orgName: string };

/**
 * Every brand side by side, for the platform super admin only (§5 exception 3; M24).
 *
 * Read through the analytics role, which reads the rollups and the brand list and writes
 * nothing. The group line is the server's sum of the same rows the brand lines come from.
 */
export function GroupPage() {
  const t = useAnalyticsT();
  const session = useSession();
  return (
    <PermissionGate
      allowed={session.context?.isSuperAdmin === true}
      explain={{
        title: t('analytics.group.deniedTitle'),
        detail: t('analytics.group.deniedDetail'),
      }}
    >
      <Group />
    </PermissionGate>
  );
}

function Group() {
  const t = useAnalyticsT();
  const { locale } = useLocale();
  const id = useId();
  const today = dhakaToday();
  const [period, setPeriod] = useState({ from: monthStart(today), to: today });
  const days = daysInclusive(period.from, period.to);
  const valid = days >= 1 && days <= 366;
  const view = useQuery({
    queryKey: ['analytics', 'consolidated', period.from, period.to],
    queryFn: () => getConsolidated(period.from, period.to),
    enabled: valid,
  });

  const line = (row: BrandLine, emphasis: boolean, key: string) => (
    <tr key={key} className={emphasis ? 'bg-muted/40 font-semibold' : 'border-b border-border'}>
      <td className={CELL}>{row.orgName}</td>
      <td className={NUMERIC}>{row.ordersDelivered}</td>
      <td className={NUMERIC}>
        <Money poisha={row.deliveredRevenuePoisha} locale={locale} />
      </td>
      <td className={NUMERIC}>
        {row.grossProfitPoisha === undefined ? (
          '—'
        ) : (
          <Money poisha={row.grossProfitPoisha} locale={locale} />
        )}
      </td>
      <td className={NUMERIC}>
        <Money poisha={row.spendPoisha} locale={locale} />
      </td>
      <td className={NUMERIC}>{roas(row.roasBps)}</td>
      <td className={NUMERIC}>{percent(row.returnRateBps)}</td>
      <td className={NUMERIC}>{percent(row.deliverySuccessBps)}</td>
    </tr>
  );

  return (
    <div className="space-y-5">
      <AnalyticsHeader
        title={t('analytics.nav.group')}
        caption={t('analytics.group.subtitle')}
        actions={
          <>
            <label htmlFor={`${id}-from`} className="text-xs font-medium text-muted-foreground">
              {t('analytics.period.from')}
            </label>
            <input
              id={`${id}-from`}
              type="date"
              className={INPUT}
              value={period.from}
              max={period.to}
              onChange={(event) => {
                if (event.target.value !== '') setPeriod({ ...period, from: event.target.value });
              }}
            />
            <label htmlFor={`${id}-to`} className="text-xs font-medium text-muted-foreground">
              {t('analytics.period.to')}
            </label>
            <input
              id={`${id}-to`}
              type="date"
              className={INPUT}
              value={period.to}
              min={period.from}
              onChange={(event) => {
                if (event.target.value !== '') setPeriod({ ...period, to: event.target.value });
              }}
            />
          </>
        }
      />

      {valid ? null : (
        <p role="alert" className="text-sm font-medium text-destructive">
          {t('analytics.period.tooLong')}
        </p>
      )}

      {view.isError ? (
        <div role="alert" className="flex items-center gap-3 text-sm">
          <span>{t('analytics.loadFailed')}</span>
          <button type="button" className={BUTTON} onClick={() => void view.refetch()}>
            {t('analytics.retry')}
          </button>
        </div>
      ) : null}

      <Section title={t('analytics.nav.group')}>
        {view.data === undefined ? (
          <div className="p-4">
            <Skeleton className="h-40 w-full" />
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className={HEAD}>{t('analytics.col.brand')}</th>
                <th className={HEAD_NUMERIC}>{t('analytics.metric.delivered')}</th>
                <th className={HEAD_NUMERIC}>{t('analytics.metric.revenue')}</th>
                <th className={HEAD_NUMERIC}>{t('analytics.metric.grossProfit')}</th>
                <th className={HEAD_NUMERIC}>{t('analytics.metric.spend')}</th>
                <th className={HEAD_NUMERIC}>{t('analytics.metric.roas')}</th>
                <th className={HEAD_NUMERIC}>{t('analytics.metric.returnRate')}</th>
                <th className={HEAD_NUMERIC}>{t('analytics.metric.deliverySuccess')}</th>
              </tr>
            </thead>
            <tbody>
              {view.data.brands.map((brand) => line(brand, false, brand.orgId))}
              {line({ ...view.data.group, orgName: t('analytics.group.total') }, true, 'group')}
            </tbody>
          </table>
        )}
      </Section>
    </div>
  );
}
