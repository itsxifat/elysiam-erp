import { formatMonth, type Locale } from '@elysium/i18n';
import {
  EmptyState,
  ErrorState,
  Money,
  MonthPicker,
  PageHeader,
  Section,
  Skeleton,
} from '@elysium/ui';
import type { LeaderboardWire } from '@elysium/mother-shared';
import { useQuery } from '@tanstack/react-query';
import { getRouteApi, useNavigate } from '@tanstack/react-router';
import { Trophy } from 'lucide-react';

import { endpoints } from '../api.js';
import { useLocale, type MessageKey } from '../i18n/locale.js';
import { count, percent, signedPercent, times } from '../ui/format.js';
import { todayInDhaka } from '../ui/range.js';

/**
 * The leaderboard across brands (M32 screen 2; D-322, D-323, D-492): M24's rules over the
 * pulled months. Each metric is ranked, each rank scored, and the weighted mean of the
 * scores orders the brands. The owner sees every brand's raw figures beside them.
 */

const route = getRouteApi('/leaderboard');

type Metric = LeaderboardWire['metrics'][number];

const LABELS: Readonly<Record<Metric, MessageKey>> = {
  revenueGrowth: 'leaderboard.metric.revenueGrowth',
  deliverySuccess: 'leaderboard.metric.deliverySuccess',
  returnRate: 'leaderboard.metric.returnRate',
  roas: 'leaderboard.metric.roas',
  cpdo: 'leaderboard.metric.cpdo',
  aovGrowth: 'leaderboard.metric.aovGrowth',
  pickupTime: 'leaderboard.metric.pickupTime',
};

function metricText(metric: Metric, value: string | null, locale: Locale, seconds: string) {
  if (value === null) return '—';
  switch (metric) {
    case 'revenueGrowth':
    case 'aovGrowth':
      return signedPercent(BigInt(value), locale);
    case 'deliverySuccess':
    case 'returnRate':
      return percent(value, locale);
    case 'roas':
      return times(value, locale);
    case 'cpdo':
      return <Money poisha={value} locale={locale} />;
    case 'pickupTime':
      return `${count(Number(value), locale)} ${seconds}`;
  }
}

export function LeaderboardPage() {
  const { t, locale } = useLocale();
  const search = route.useSearch();
  const navigate = useNavigate();
  const month = search.month ?? todayInDhaka().slice(0, 7);
  const query = useQuery({
    queryKey: ['leaderboard', month],
    queryFn: () => endpoints.leaderboard(month),
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('leaderboard.title')}
        description={t('leaderboard.description')}
        actions={
          <MonthPicker
            value={month}
            onValueChange={(next) => {
              if (next !== '') void navigate({ to: '/leaderboard', search: { month: next } });
            }}
            locale={locale}
            max={todayInDhaka().slice(0, 7)}
            aria-label={t('leaderboard.month')}
            labels={{ previousYear: t('picker.previousYear'), nextYear: t('picker.nextYear') }}
          />
        }
      />
      {query.isPending ? (
        <Skeleton className="h-64 w-full" />
      ) : query.isError ? (
        <ErrorState title={t('common.error')} detail={t('common.errorDetail')} />
      ) : query.data.rows.length === 0 ? (
        <EmptyState icon={Trophy} title={t('leaderboard.empty')} />
      ) : (
        <Section
          title={`${formatMonth(query.data.month, { locale, style: 'long' })}`}
          bodyClassName="p-0"
        >
          <div className="overflow-x-auto">
            <table className="w-full min-w-[960px] text-sm">
              <caption className="sr-only">{t('leaderboard.title')}</caption>
              <thead>
                <tr className="border-b border-border text-xs text-muted-foreground">
                  <th scope="col" className="px-4 py-2.5 text-left font-medium">
                    {t('leaderboard.rank')}
                  </th>
                  <th scope="col" className="px-3 py-2.5 text-left font-medium">
                    {t('overview.brand')}
                  </th>
                  <th scope="col" className="px-3 py-2.5 text-right font-medium">
                    {t('leaderboard.score')}
                  </th>
                  {query.data.metrics.map((metric) => (
                    <th key={metric} scope="col" className="px-3 py-2.5 text-right font-medium">
                      {t(LABELS[metric])}
                      <span className="block font-normal">
                        {t('leaderboard.weight')} {count(query.data.weights[metric], locale)}
                      </span>
                    </th>
                  ))}
                  <th scope="col" className="px-4 py-2.5 text-right font-medium">
                    {t('metric.deliveredRevenue')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {query.data.rows.map((row) => (
                  <tr key={row.brandId} className="border-b border-border last:border-0">
                    <td className="px-4 py-2.5 text-lg font-semibold tabular-nums">
                      {count(row.rank, locale)}
                    </td>
                    <th scope="row" className="px-3 py-2.5 text-left font-medium">
                      {row.name}
                    </th>
                    <td className="px-3 py-2.5 text-right tabular-nums">
                      {percent(String(row.compositeBps), locale)}
                    </td>
                    {query.data.metrics.map((metric) => (
                      <td key={metric} className="px-3 py-2.5 text-right tabular-nums">
                        {metricText(metric, row.metrics[metric], locale, t('leaderboard.seconds'))}
                        {row.ranks[metric] === null ? null : (
                          <span className="block text-xs text-muted-foreground">
                            #{count(row.ranks[metric] ?? 0, locale)}
                          </span>
                        )}
                      </td>
                    ))}
                    <td className="px-4 py-2.5 text-right tabular-nums">
                      <Money poisha={row.current.deliveredRevenuePoisha} locale={locale} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}
    </div>
  );
}
