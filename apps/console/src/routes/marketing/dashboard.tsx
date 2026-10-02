import {
  DataTable,
  Money,
  PermissionGate,
  Skeleton,
  dataTableColumns,
  type DataTableColumn,
} from '@elysium/ui';
import { useQuery } from '@tanstack/react-query';
import { lazy, Suspense, useId, useMemo, useState, type ReactNode } from 'react';

import { useAbility } from '../../auth/session.js';
import { useLocale } from '../../i18n/locale.js';
import { singlePage } from '../campaigns/campaigns-nav.js';
import { getDashboard, type Dashboard, type Metrics } from './api.js';
import { daysInclusive, dhakaToday, monthStart, percent, roas } from './format.js';
import { MarketingHeader, PeriodPicker, useMarketingTableLabels } from './marketing-nav.js';
import { useMarketingT } from './messages.js';

/** Its own chunk: the figures render first, the picture follows (§24, check:bundle). */
const TrendChart = lazy(() =>
  import('./trend-chart.js').then((module) => ({ default: module.TrendChart })),
);

/**
 * The marketing dashboard (architecture §11; M18 check 1 made visible).
 *
 * §11's exact definitions, computed on the server by the domain's pure functions: CPO and
 * CPDO in taka, delivered ROAS first and labelled primary, placed-order ROAS beside it and
 * labelled optimistic, and the return rate. A dash means "nothing to divide by", never zero.
 */
export function MarketingDashboardPage() {
  const ability = useAbility();
  const t = useMarketingT();
  return (
    <PermissionGate
      allowed={ability.can('read', 'Campaign')}
      explain={{ title: t('marketing.deniedTitle'), detail: t('marketing.deniedDetail') }}
    >
      <DashboardScreen />
    </PermissionGate>
  );
}

type Row = Dashboard['campaigns'][number];

function Tile({
  label,
  value,
  hint,
}: {
  readonly label: string;
  readonly value: ReactNode;
  readonly hint?: string;
}) {
  return (
    <div className="space-y-1 rounded-lg border border-border bg-card p-4">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="text-xl font-semibold tabular-nums">{value}</p>
      {hint === undefined ? null : <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function DashboardScreen() {
  const t = useMarketingT();
  const { locale } = useLocale();
  const id = useId();
  const today = dhakaToday();
  const [period, setPeriod] = useState({ from: monthStart(today), to: today });
  const days = daysInclusive(period.from, period.to);
  const valid = days >= 1 && days <= 92;

  const board = useQuery({
    queryKey: ['marketing', 'dashboard', period.from, period.to],
    queryFn: () => getDashboard(period.from, period.to),
    enabled: valid,
  });

  const columns = useMemo<readonly DataTableColumn<Row>[]>(() => {
    const money = (value: string | null) =>
      value === null ? '—' : <Money poisha={value} locale={locale} />;
    const column = dataTableColumns<Row>();
    const metric = (key: keyof Metrics, header: string, render: (m: Metrics) => ReactNode) =>
      column.display({
        id: key,
        header,
        meta: { numeric: true },
        cell: (cell) => render(cell.row.original.metrics),
      });
    return column.columns([
      column.accessor('name', {
        header: t('marketing.col.campaign'),
        cell: (cell) => <span className="font-medium">{cell.getValue()}</span>,
      }),
      metric('spendPoisha', t('marketing.metric.spend'), (m) => money(m.spendPoisha)),
      metric('confirmedOrders', t('marketing.metric.confirmed'), (m) => m.confirmedOrders),
      metric('deliveredOrders', t('marketing.metric.delivered'), (m) => m.deliveredOrders),
      metric('deliveredRevenuePoisha', t('marketing.metric.revenue'), (m) =>
        money(m.deliveredRevenuePoisha),
      ),
      metric('cpoPoisha', t('marketing.metric.cpo'), (m) => money(m.cpoPoisha)),
      metric('cpdoPoisha', t('marketing.metric.cpdo'), (m) => money(m.cpdoPoisha)),
      metric('roasBps', t('marketing.metric.roas'), (m) => roas(m.roasBps)),
      metric('placedRoasBps', t('marketing.metric.placedRoas'), (m) => roas(m.placedRoasBps)),
      metric('returnRateBps', t('marketing.metric.returnRate'), (m) => percent(m.returnRateBps)),
    ]);
  }, [t, locale]);

  const data = board.data;
  const total = data?.total;
  const rows = data?.campaigns ?? [];
  const labels = useMarketingTableLabels(
    t('marketing.dashboard.emptyTitle'),
    t('marketing.dashboard.emptyDetail'),
  );
  const money = (value: string | null | undefined) =>
    value === null || value === undefined ? '—' : <Money poisha={value} locale={locale} />;

  return (
    <div className="space-y-5">
      <MarketingHeader
        title={t('marketing.title')}
        caption={t('marketing.dashboard.subtitle')}
        actions={
          <PeriodPicker idPrefix={id} from={period.from} to={period.to} onChange={setPeriod} />
        }
      />

      {valid ? null : (
        <p role="alert" className="text-sm font-medium text-destructive">
          {t('marketing.period.tooLong')}
        </p>
      )}

      <section
        aria-label={t('marketing.dashboard.totals')}
        className="grid grid-cols-2 gap-3 md:grid-cols-4"
      >
        <Tile
          label={t('marketing.metric.roas')}
          value={total === undefined ? '—' : roas(total.roasBps)}
          hint={t('marketing.metric.roasHint')}
        />
        <Tile label={t('marketing.metric.spend')} value={money(total?.spendPoisha)} />
        <Tile label={t('marketing.metric.cpo')} value={money(total?.cpoPoisha)} />
        <Tile label={t('marketing.metric.cpdo')} value={money(total?.cpdoPoisha)} />
        <Tile
          label={t('marketing.metric.revenue')}
          value={money(total?.deliveredRevenuePoisha)}
          hint={t('marketing.metric.revenueHint')}
        />
        <Tile
          label={t('marketing.metric.placedRoas')}
          value={total === undefined ? '—' : roas(total.placedRoasBps)}
          hint={t('marketing.metric.placedRoasHint')}
        />
        <Tile
          label={t('marketing.metric.ordersLabel')}
          value={
            total === undefined
              ? '—'
              : `${String(total.confirmedOrders)} / ${String(total.deliveredOrders)}`
          }
          hint={t('marketing.metric.ordersHint')}
        />
        <Tile
          label={t('marketing.metric.returnRate')}
          value={total === undefined ? '—' : percent(total.returnRateBps)}
        />
      </section>

      <section
        className="rounded-lg border border-border bg-card p-4"
        aria-label={t('marketing.dashboard.trend')}
      >
        {data === undefined ? (
          <Skeleton className="h-44 w-full" />
        ) : (
          <Suspense fallback={<Skeleton className="h-44 w-full" />}>
            <TrendChart
              series={data.series}
              label={t('marketing.dashboard.trend')}
              spendLabel={t('marketing.metric.spend')}
              revenueLabel={t('marketing.metric.revenue')}
            />
          </Suspense>
        )}
      </section>

      <DataTable
        columns={columns}
        data={rows}
        getRowId={(row) => row.campaignId}
        page={singlePage(rows.length)}
        onPageChange={() => undefined}
        sort={null}
        onSortChange={() => undefined}
        loading={board.isPending && valid}
        error={board.error}
        onRetry={() => void board.refetch()}
        caption={t('marketing.dashboard.byCampaign')}
        labels={labels}
      />

      {data === undefined ? null : (
        <p className="text-sm text-muted-foreground">
          {t('marketing.dashboard.attribution')}: {t('marketing.rule.explicit')}{' '}
          {data.attribution.explicit} · {t('marketing.rule.ad_referral')}{' '}
          {data.attribution.ad_referral} · {t('marketing.rule.utm')} {data.attribution.utm} ·{' '}
          {t('marketing.rule.none')} {data.attribution.none}
          {data.unattributed === null ? null : (
            <>
              {' — '}
              {t('marketing.dashboard.unattributedRevenue')}:{' '}
              <Money poisha={data.unattributed.deliveredRevenuePoisha} locale={locale} />
            </>
          )}
        </p>
      )}
    </div>
  );
}
