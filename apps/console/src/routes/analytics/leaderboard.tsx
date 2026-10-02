import { Money, PermissionGate, Skeleton } from '@elysium/ui';
import { useQuery } from '@tanstack/react-query';
import { useId, useState, type ReactNode } from 'react';

import { useAbility, useSession } from '../../auth/session.js';
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
  Template,
} from './analytics-nav.js';
import {
  getLeaderboard,
  LEADERBOARD_METRICS,
  type BoardRow,
  type LeaderboardMetric,
} from './api.js';
import { dhakaToday, duration, percent, roas, signedPercent } from './format.js';
import { fill, useAnalyticsT, type AnalyticsMessageKey } from './messages.js';

const METRIC_LABEL: Readonly<Record<LeaderboardMetric, AnalyticsMessageKey>> = {
  revenueGrowth: 'analytics.metric.revenueGrowth',
  deliverySuccess: 'analytics.metric.deliverySuccess',
  returnRate: 'analytics.metric.returnRate',
  roas: 'analytics.metric.roas',
  cpdo: 'analytics.metric.cpdo',
  aovGrowth: 'analytics.metric.aovGrowth',
  pickupTime: 'analytics.metric.pickupTime',
};

/**
 * The cross-brand leaderboard (architecture §18; M24, D-023).
 *
 * Every brand's normalized metrics, each metric's rank, and the composite score as a bar
 * (0–100, the one accent token, value at the tip). The viewer's own brand also shows its
 * delivered revenue and orders; another brand's row arrives from the server without them,
 * so there is nothing here to hide.
 */
export function LeaderboardPage() {
  const ability = useAbility();
  const t = useAnalyticsT();
  return (
    <PermissionGate
      allowed={ability.can('read', 'Leaderboard')}
      explain={{
        title: t('analytics.leaderboard.deniedTitle'),
        detail: t('analytics.leaderboard.deniedDetail'),
      }}
    >
      <Board />
    </PermissionGate>
  );
}

function Board() {
  const t = useAnalyticsT();
  const { locale } = useLocale();
  const id = useId();
  const orgId = useSession().context?.orgId ?? null;
  const [month, setMonth] = useState(dhakaToday().slice(0, 7));
  const board = useQuery({
    queryKey: ['analytics', 'leaderboard', month],
    queryFn: () => getLeaderboard(month),
  });

  const value = (metric: LeaderboardMetric, raw: string | null): ReactNode => {
    switch (metric) {
      case 'revenueGrowth':
      case 'aovGrowth':
        return signedPercent(raw);
      case 'deliverySuccess':
      case 'returnRate':
        return percent(raw);
      case 'roas':
        return roas(raw);
      case 'cpdo':
        return raw === null ? '—' : <Money poisha={raw} locale={locale} />;
      case 'pickupTime':
        return duration(raw === null ? null : Number(raw), {
          seconds: t('analytics.seconds'),
          minutes: t('analytics.minutes'),
        });
    }
  };

  const rows: readonly BoardRow[] = board.data?.rows ?? [];

  return (
    <div className="space-y-5">
      <AnalyticsHeader
        title={t('analytics.nav.leaderboard')}
        caption={t('analytics.leaderboard.subtitle')}
        actions={
          <>
            <label htmlFor={`${id}-month`} className="text-xs font-medium text-muted-foreground">
              {t('analytics.leaderboard.month')}
            </label>
            <input
              id={`${id}-month`}
              type="month"
              className={INPUT}
              value={month}
              onChange={(event) => {
                if (/^\d{4}-\d{2}$/.test(event.target.value)) setMonth(event.target.value);
              }}
            />
          </>
        }
      />

      {board.isError ? (
        <div role="alert" className="flex items-center gap-3 text-sm">
          <span>{t('analytics.loadFailed')}</span>
          <button type="button" className={BUTTON} onClick={() => void board.refetch()}>
            {t('analytics.retry')}
          </button>
        </div>
      ) : null}

      <Section title={t('analytics.nav.leaderboard')}>
        {board.isPending ? (
          <div className="p-4">
            <Skeleton className="h-40 w-full" />
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className={HEAD_NUMERIC}>{t('analytics.col.rank')}</th>
                <th className={HEAD}>{t('analytics.col.brand')}</th>
                <th className={`${HEAD} min-w-40`}>{t('analytics.col.score')}</th>
                {LEADERBOARD_METRICS.map((metric) => (
                  <th key={metric} className={HEAD_NUMERIC}>
                    {t(METRIC_LABEL[metric])}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const score = Math.round(row.compositeBps / 100);
                return (
                  <tr
                    key={row.orgId}
                    className={`border-b border-border last:border-0 ${row.orgId === orgId ? 'bg-muted/40' : ''}`}
                  >
                    <td className={`${NUMERIC} font-semibold`}>{row.rank}</td>
                    <td className={CELL}>
                      <p className="font-medium">
                        {row.orgName}
                        {row.orgId === orgId ? (
                          <span className="ml-2 rounded-sm bg-muted px-1.5 py-0.5 text-xs font-normal text-muted-foreground">
                            {t('analytics.leaderboard.yours')}
                          </span>
                        ) : null}
                      </p>
                      {row.raw === undefined ? null : (
                        <p className="text-xs text-muted-foreground tabular-nums">
                          <Template
                            text={t('analytics.leaderboard.raw')}
                            values={{
                              orders: String(row.raw.current.ordersDelivered),
                              revenue: (
                                <Money
                                  poisha={row.raw.current.deliveredRevenuePoisha}
                                  locale={locale}
                                />
                              ),
                            }}
                          />
                        </p>
                      )}
                    </td>
                    <td className={CELL}>
                      <div
                        className="flex items-center gap-2"
                        role="img"
                        aria-label={fill(t('analytics.leaderboard.scoreLabel'), {
                          score: String(score),
                        })}
                      >
                        <svg viewBox="0 0 100 8" className="h-2 w-28" aria-hidden="true">
                          <rect width={100} height={8} rx={4} className="fill-primary/15" />
                          <rect width={score} height={8} rx={4} className="fill-primary" />
                        </svg>
                        <span className="text-xs tabular-nums">{score}</span>
                      </div>
                    </td>
                    {LEADERBOARD_METRICS.map((metric) => (
                      <td key={metric} className={NUMERIC}>
                        <span>{value(metric, row.metrics[metric])}</span>
                        <span className="ml-1.5 text-xs text-muted-foreground">
                          {row.ranks[metric] === null ? '' : `#${String(row.ranks[metric])}`}
                        </span>
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Section>

      {board.data === undefined ? null : (
        <p className="text-xs text-muted-foreground">
          {t('analytics.leaderboard.weights')}:{' '}
          {LEADERBOARD_METRICS.map(
            (metric) => `${t(METRIC_LABEL[metric])} ${String(board.data.weights[metric])}`,
          ).join(' · ')}
        </p>
      )}
    </div>
  );
}
