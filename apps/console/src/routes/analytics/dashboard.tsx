import {
  Menu,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  MenuTrigger,
  MetricList,
  Money,
  PermissionGate,
  Section as KitSection,
  Skeleton,
  StatCard,
} from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Database, Download, Info, RefreshCw, TriangleAlert } from 'lucide-react';
import { lazy, Suspense, useState, type ReactNode } from 'react';

import { useAbility } from '../../auth/session.js';
import { useLocale, useT } from '../../i18n/locale.js';
import { DateRangePicker } from '../../ui/date-picker.js';
import {
  CELL,
  HEAD,
  HEAD_NUMERIC,
  NUMERIC,
  AnalyticsHeader,
  BUTTON,
  Section,
  Template,
} from './analytics-nav.js';
import {
  exportUrl,
  getDashboard,
  getInsights,
  getNarrative,
  refreshRollups,
  type InsightItem,
} from './api.js';
import { daysInclusive, dhakaToday, duration, monthStart, percent, roas } from './format.js';
import { fill, isAnalyticsKey, useAnalyticsT, type AnalyticsMessageKey } from './messages.js';

/** Its own chunk: the figures render first, the picture follows (§24, check:bundle). */
const TrendChart = lazy(() =>
  import('./trend-chart.js').then((module) => ({ default: module.TrendChart })),
);

/** The insight codes as their message keys (keys are lowerCamel; codes are snake_case). */
const INSIGHT_KEY: Readonly<Record<InsightItem['code'], string>> = {
  outside_dhaka_returns: 'outsideDhakaReturns',
  return_rate_rising: 'returnRateRising',
  campaign_below_break_even: 'campaignBelowBreakEven',
  cpdo_rising: 'cpdoRising',
  slow_pickup: 'slowPickup',
  channel_returns: 'channelReturns',
  delivery_success_below_usual: 'deliverySuccessBelowUsual',
};

/**
 * The org dashboard (architecture §18; M24): the brand's own figures for a period, from the
 * daily rollups. Gross profit and stock value appear for a role with cost (the server sends
 * them to nobody else). Insights and the narrative read the month the period ends in.
 */
export function AnalyticsDashboardPage() {
  const ability = useAbility();
  const t = useAnalyticsT();
  return (
    <PermissionGate
      allowed={ability.can('read', 'Dashboard')}
      explain={{ title: t('analytics.deniedTitle'), detail: t('analytics.deniedDetail') }}
    >
      <Dashboard />
    </PermissionGate>
  );
}

function Dashboard() {
  const t = useAnalyticsT();
  const common = useT();
  const { locale } = useLocale();
  const ability = useAbility();
  const queries = useQueryClient();
  const today = dhakaToday();
  const [period, setPeriod] = useState({ from: monthStart(today), to: today });
  const [notice, setNotice] = useState<string | null>(null);
  const days = daysInclusive(period.from, period.to);
  const valid = days >= 1 && days <= 366;
  const month = period.to.slice(0, 7);

  const board = useQuery({
    queryKey: ['analytics', 'dashboard', period.from, period.to],
    queryFn: () => getDashboard(period.from, period.to),
    enabled: valid,
  });
  const insights = useQuery({
    queryKey: ['analytics', 'insights', month],
    queryFn: () => getInsights(month),
    enabled: valid,
  });
  const narrative = useQuery({
    queryKey: ['analytics', 'narrative', month],
    queryFn: () => getNarrative(month),
    enabled: valid,
    retry: false,
  });
  const refresh = useMutation({
    mutationFn: () => refreshRollups(period.from, period.to),
    onSuccess: async (result) => {
      setNotice(fill(t('analytics.refreshDone'), { days: String(result.days) }));
      await queries.invalidateQueries({ queryKey: ['analytics'] });
    },
    onError: () => {
      setNotice(t('analytics.refreshFailed'));
    },
  });

  // Figures (the cards and the statements) drop ".00" on whole taka; tables keep it (D-455).
  const figure = (value: string | null | undefined) =>
    value === null || value === undefined ? '—' : <Money poisha={value} locale={locale} compact />;
  const money = (value: string | null | undefined) =>
    value === null || value === undefined ? '—' : <Money poisha={value} locale={locale} />;
  const seconds = (value: number | null) =>
    duration(value, { seconds: t('analytics.seconds'), minutes: t('analytics.minutes') });
  const channelName = (code: string) => {
    const key = `orders.channel.${code}`;
    return isAnalyticsKey(key) ? t(key) : code;
  };

  const data = board.data;
  const totals = data?.totals;

  return (
    <div className="space-y-5">
      <AnalyticsHeader
        title={t('analytics.title')}
        caption={t('analytics.dashboard.subtitle')}
        actions={
          <>
            <DateRangePicker
              aria-label={`${t('analytics.period.from')} – ${t('analytics.period.to')}`}
              value={period}
              max={today}
              onValueChange={(next) => {
                if (next.from !== '' && next.to !== '') setPeriod(next);
              }}
            />
            {/*
             * The operator's corner (D-460): the exports, recomputing the days and when they
             * were last computed sit behind one quiet menu, so the page leads with figures.
             */}
            <Menu>
              <MenuTrigger className={BUTTON}>
                <Database aria-hidden="true" className="size-4" />
                {common('analytics.dataMenu')}
              </MenuTrigger>
              <MenuContent className="w-72">
                {data === undefined ? null : (
                  <MenuLabel className="text-xs font-normal tabular-nums">
                    {fill(t('analytics.coverage'), {
                      computed: String(data.coverage.computedDays),
                      days: String(data.coverage.days),
                    })}
                    {data.coverage.computedAt === null
                      ? null
                      : ` · ${fill(t('analytics.coverage.at'), {
                          at: new Date(data.coverage.computedAt).toLocaleString('en-GB', {
                            timeZone: 'Asia/Dhaka',
                            dateStyle: 'medium',
                            timeStyle: 'short',
                          }),
                        })}`}
                  </MenuLabel>
                )}
                <MenuItem asChild>
                  <a href={exportUrl(period.from, period.to, 'csv')}>
                    <Download aria-hidden="true" />
                    {t('analytics.exportCsv')}
                  </a>
                </MenuItem>
                <MenuItem asChild>
                  <a href={exportUrl(period.from, period.to, 'xlsx')}>
                    <Download aria-hidden="true" />
                    {t('analytics.exportXlsx')}
                  </a>
                </MenuItem>
                {ability.can('update', 'Dashboard') ? (
                  <>
                    <MenuSeparator />
                    <MenuItem
                      disabled={refresh.isPending || !valid || days > 92}
                      onSelect={() => {
                        setNotice(null);
                        refresh.mutate();
                      }}
                    >
                      <RefreshCw aria-hidden="true" />
                      {refresh.isPending ? t('analytics.refreshing') : t('analytics.refresh')}
                    </MenuItem>
                    {days > 92 ? (
                      <MenuLabel className="text-xs font-normal">
                        {t('analytics.refreshTooLong')}
                      </MenuLabel>
                    ) : null}
                  </>
                ) : null}
              </MenuContent>
            </Menu>
          </>
        }
      />

      {valid ? null : (
        <p role="alert" className="text-sm font-medium text-destructive">
          {t('analytics.period.tooLong')}
        </p>
      )}

      {notice === null ? null : (
        <p role="status" className="text-sm text-muted-foreground">
          {notice}
        </p>
      )}

      {board.isError ? (
        <div role="alert" className="flex items-center gap-3 text-sm">
          <span>{t('analytics.loadFailed')}</span>
          <button type="button" className={BUTTON} onClick={() => void board.refetch()}>
            {t('analytics.retry')}
          </button>
        </div>
      ) : null}

      {/* The figures, with a hierarchy (D-453): the four a person opens this page for,
          large and with their shape over the period, then the rest as statements. */}
      <section aria-label={t('analytics.title')} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard
            label={t('analytics.metric.revenue')}
            value={figure(totals?.deliveredRevenuePoisha)}
            hint={t('analytics.metric.revenueHint')}
            {...(data === undefined
              ? {}
              : { trend: data.series.map((day) => Number(day.deliveredRevenuePoisha)) })}
          />
          {totals?.grossProfitPoisha === undefined ? (
            <StatCard label={t('analytics.metric.aov')} value={figure(totals?.aovPoisha)} />
          ) : (
            <StatCard
              label={t('analytics.metric.grossProfit')}
              value={figure(totals.grossProfitPoisha)}
            />
          )}
          <StatCard
            label={t('analytics.metric.confirmed')}
            value={totals === undefined ? '—' : String(totals.ordersConfirmed)}
            hint={
              totals === undefined
                ? undefined
                : `${t('analytics.metric.placed')} ${String(totals.ordersPlaced)} · ${t('analytics.metric.delivered')} ${String(totals.ordersDelivered)}`
            }
            {...(data === undefined
              ? {}
              : { trend: data.series.map((day) => day.ordersConfirmed) })}
          />
          <StatCard
            label={t('analytics.metric.deliverySuccess')}
            value={totals === undefined ? '—' : percent(totals.deliverySuccessBps)}
            hint={t('analytics.metric.deliverySuccessHint')}
          />
        </div>

        <div className="grid gap-4 lg:grid-cols-3">
          <KitSection title={common('nav.orders')}>
            <MetricList
              items={[
                {
                  label: t('analytics.metric.placed'),
                  value: totals === undefined ? '—' : String(totals.ordersPlaced),
                },
                {
                  label: t('analytics.metric.delivered'),
                  value: totals === undefined ? '—' : String(totals.ordersDelivered),
                },
                {
                  label: t('analytics.metric.returned'),
                  value: totals === undefined ? '—' : String(totals.ordersReturned),
                },
                {
                  label: t('analytics.metric.cancelled'),
                  value: totals === undefined ? '—' : String(totals.ordersCancelled),
                },
                {
                  label: t('analytics.metric.returnRate'),
                  value: totals === undefined ? '—' : percent(totals.returnRateBps),
                },
                { label: t('analytics.metric.aov'), value: figure(totals?.aovPoisha) },
              ]}
            />
          </KitSection>
          <KitSection title={common('nav.marketing')}>
            <MetricList
              items={[
                { label: t('analytics.metric.spend'), value: figure(totals?.spendPoisha) },
                { label: t('analytics.metric.cpo'), value: figure(totals?.cpoPoisha) },
                { label: t('analytics.metric.cpdo'), value: figure(totals?.cpdoPoisha) },
                {
                  label: t('analytics.metric.roas'),
                  value: totals === undefined ? '—' : roas(totals.roasBps),
                },
                {
                  label: t('analytics.metric.pickup'),
                  value: totals === undefined ? '—' : seconds(totals.pickupMeanSeconds),
                },
              ]}
            />
          </KitSection>
          <KitSection title={common('nav.sectionMoney')}>
            <MetricList
              items={[
                {
                  label: t('analytics.metric.cash'),
                  value: figure(data?.cashPoisha),
                  hint: t('analytics.metric.cashHint'),
                },
                ...(data?.stockValuePoisha === undefined
                  ? []
                  : [
                      {
                        label: t('analytics.metric.stockValue'),
                        value: figure(data.stockValuePoisha),
                      },
                    ]),
                ...(totals?.grossProfitPoisha === undefined
                  ? []
                  : [
                      {
                        label: t('analytics.metric.grossProfit'),
                        value: figure(totals.grossProfitPoisha),
                      },
                    ]),
              ]}
            />
          </KitSection>
        </div>
      </section>

      <InsightsPanel month={month} items={insights.data?.items} failed={insights.isError} />

      {narrative.data?.enabled === true ? (
        <Section title={t('analytics.narrative')}>
          <div className="space-y-2 px-4 py-3">
            <p className="text-sm leading-relaxed">{narrative.data.text}</p>
            <p className="text-xs text-muted-foreground">
              {fill(t('analytics.narrative.note'), { provider: narrative.data.provider })}
            </p>
          </div>
        </Section>
      ) : narrative.isError ? (
        <p className="text-sm text-muted-foreground">{t('analytics.narrative.failed')}</p>
      ) : null}

      <Section title={t('analytics.trend')}>
        <div className="p-4">
          {data === undefined ? (
            <Skeleton className="h-52 w-full" />
          ) : (
            <Suspense fallback={<Skeleton className="h-52 w-full" />}>
              <TrendChart
                series={data.series}
                label={t('analytics.trend')}
                tableLabel={t('analytics.trend.table')}
                dateLabel={t('analytics.col.date')}
                revenueLabel={t('analytics.metric.revenue')}
                deliveredLabel={t('analytics.metric.delivered')}
                locale={locale}
              />
            </Suspense>
          )}
        </div>
      </Section>

      <div className="grid gap-5 xl:grid-cols-2">
        <MetricTable
          title={t('analytics.byChannel')}
          keyLabel={t('analytics.col.channel')}
          rows={(data?.byChannel ?? []).map((row) => ({
            ...row,
            id: row.channel,
            name: channelName(row.channel),
          }))}
        />
        <MetricTable
          title={t('analytics.byBranch')}
          keyLabel={t('analytics.col.branch')}
          rows={(data?.byBranch ?? []).map((row) => ({
            ...row,
            id: row.branchId,
            name: row.name ?? t('analytics.unnamedBranch'),
          }))}
        />
      </div>

      <Section title={t('analytics.byCampaign')}>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border">
              <th className={HEAD}>{t('analytics.col.campaign')}</th>
              <th className={HEAD_NUMERIC}>{t('analytics.metric.spend')}</th>
              <th className={HEAD_NUMERIC}>{t('analytics.metric.confirmed')}</th>
              <th className={HEAD_NUMERIC}>{t('analytics.metric.delivered')}</th>
              <th className={HEAD_NUMERIC}>{t('analytics.metric.revenue')}</th>
              <th className={HEAD_NUMERIC}>{t('analytics.metric.cpdo')}</th>
              <th className={HEAD_NUMERIC}>{t('analytics.metric.roas')}</th>
            </tr>
          </thead>
          <tbody>
            {(data?.byCampaign ?? []).map((row) => (
              <tr key={row.campaignId ?? 'none'} className="border-b border-border last:border-0">
                <td className={CELL}>{row.name ?? t('analytics.unattributed')}</td>
                <td className={NUMERIC}>{money(row.spendPoisha)}</td>
                <td className={NUMERIC}>{row.ordersConfirmed}</td>
                <td className={NUMERIC}>{row.ordersDelivered}</td>
                <td className={NUMERIC}>{money(row.deliveredRevenuePoisha)}</td>
                <td className={NUMERIC}>{money(row.cpdoPoisha)}</td>
                <td className={NUMERIC}>{roas(row.roasBps)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <Empty when={data?.byCampaign.length === 0} />
      </Section>

      <div className="grid gap-5 xl:grid-cols-2">
        <Section title={t('analytics.agents')}>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className={HEAD}>{t('analytics.col.agent')}</th>
                <th className={HEAD_NUMERIC}>{t('analytics.metric.confirmed')}</th>
                <th className={HEAD_NUMERIC}>{t('analytics.metric.delivered')}</th>
                <th className={HEAD_NUMERIC}>{t('analytics.metric.revenue')}</th>
                <th className={HEAD_NUMERIC}>{t('analytics.metric.pickup')}</th>
              </tr>
            </thead>
            <tbody>
              {(data?.agents ?? []).map((row) => (
                <tr key={row.userId} className="border-b border-border last:border-0">
                  <td className={CELL}>{row.name ?? t('analytics.unknownAgent')}</td>
                  <td className={NUMERIC}>{row.ordersConfirmed}</td>
                  <td className={NUMERIC}>{row.ordersDelivered}</td>
                  <td className={NUMERIC}>{money(row.deliveredRevenuePoisha)}</td>
                  <td className={NUMERIC}>{seconds(row.pickupMeanSeconds)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <Empty when={data?.agents.length === 0} />
        </Section>
        <Section title={t('analytics.topSkus')}>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className={HEAD}>{t('analytics.col.sku')}</th>
                <th className={HEAD}>{t('analytics.col.product')}</th>
                <th className={HEAD_NUMERIC}>{t('analytics.col.units')}</th>
              </tr>
            </thead>
            <tbody>
              {(data?.topSkus ?? []).map((row) => (
                <tr key={row.skuId} className="border-b border-border last:border-0">
                  <td className={`${CELL} font-mono text-xs`}>{row.skuCode}</td>
                  <td className={CELL}>{row.productName}</td>
                  <td className={NUMERIC}>{row.units}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <Empty when={data?.topSkus.length === 0} />
        </Section>
      </div>
    </div>
  );
}

function Empty({ when }: { readonly when: boolean }) {
  const t = useAnalyticsT();
  return when ? (
    <p className="px-4 py-3 text-sm text-muted-foreground">{t('analytics.empty')}</p>
  ) : null;
}

function MetricTable({
  title,
  keyLabel,
  rows,
}: {
  readonly title: string;
  readonly keyLabel: string;
  readonly rows: readonly {
    readonly id: string;
    readonly name: string;
    readonly ordersConfirmed: number;
    readonly ordersDelivered: number;
    readonly ordersReturned: number;
    readonly deliveredRevenuePoisha: string;
    readonly returnRateBps: string | null;
  }[];
}) {
  const t = useAnalyticsT();
  const { locale } = useLocale();
  return (
    <Section title={title}>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border">
            <th className={HEAD}>{keyLabel}</th>
            <th className={HEAD_NUMERIC}>{t('analytics.metric.confirmed')}</th>
            <th className={HEAD_NUMERIC}>{t('analytics.metric.delivered')}</th>
            <th className={HEAD_NUMERIC}>{t('analytics.metric.revenue')}</th>
            <th className={HEAD_NUMERIC}>{t('analytics.metric.returnRate')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className="border-b border-border last:border-0">
              <td className={CELL}>{row.name}</td>
              <td className={NUMERIC}>{row.ordersConfirmed}</td>
              <td className={NUMERIC}>{row.ordersDelivered}</td>
              <td className={NUMERIC}>
                <Money poisha={row.deliveredRevenuePoisha} locale={locale} />
              </td>
              <td className={NUMERIC}>{percent(row.returnRateBps)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 ? (
        <p className="px-4 py-3 text-sm text-muted-foreground">{t('analytics.empty')}</p>
      ) : null}
    </Section>
  );
}

/** Each fired rule as a sentence in the viewer's language, its numbers formatted here. */
function InsightsPanel({
  month,
  items,
  failed,
}: {
  readonly month: string;
  readonly items: readonly InsightItem[] | undefined;
  readonly failed: boolean;
}) {
  const t = useAnalyticsT();
  const { locale } = useLocale();
  const amount = (poisha: string | undefined): ReactNode =>
    poisha === undefined ? '—' : <Money poisha={poisha} locale={locale} />;

  const sentence = (item: InsightItem): ReactNode => {
    const detailKey = `analytics.insight.${INSIGHT_KEY[item.code]}.detail`;
    if (!isAnalyticsKey(detailKey)) return null;
    const p = item.params;
    const rate = (key: string) => percent(p[key] ?? null);
    const channelKey = `orders.channel.${p.channel ?? ''}`;
    return (
      <Template
        text={t(detailKey)}
        values={{
          rate: rate('rateBps'),
          median: rate('medianBps'),
          gap: rate('gapBps'),
          rise: rate('riseBps'),
          brand: rate('brandRateBps'),
          success: rate('successBps'),
          // CPDO's "previous" is an amount; the return rate's is a rate.
          previous: item.code === 'cpdo_rising' ? amount(p.previousPoisha) : rate('previousBps'),
          spend: amount(p.spendPoisha),
          cpdo: amount(p.cpdoPoisha),
          roas: roas(p.roasBps ?? null),
          campaign: item.campaignName ?? t('analytics.unattributed'),
          channel: isAnalyticsKey(channelKey) ? t(channelKey) : (p.channel ?? ''),
          pickups: p.pickups ?? '',
          mean: duration(p.meanSeconds === undefined ? null : Number(p.meanSeconds), {
            seconds: t('analytics.seconds'),
            minutes: t('analytics.minutes'),
          }),
        }}
      />
    );
  };

  return (
    <Section title={t('analytics.insights')}>
      <div className="space-y-3 px-4 py-3">
        <p className="text-xs text-muted-foreground">
          {fill(t('analytics.insights.month'), { month })}
        </p>
        {failed ? (
          <p className="text-sm text-muted-foreground">{t('analytics.loadFailed')}</p>
        ) : items === undefined ? (
          <Skeleton className="h-10 w-full" />
        ) : items.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('analytics.insights.none')}</p>
        ) : (
          <ul className="space-y-3">
            {items.map((item, index) => {
              const titleKey = `analytics.insight.${INSIGHT_KEY[item.code]}.title`;
              const severityKey: AnalyticsMessageKey =
                item.severity === 'warning'
                  ? 'analytics.severity.warning'
                  : 'analytics.severity.info';
              return (
                <li key={`${item.code}-${String(index)}`} className="flex gap-3">
                  {item.severity === 'warning' ? (
                    <TriangleAlert
                      aria-hidden="true"
                      className="mt-0.5 size-4 shrink-0 text-warning"
                    />
                  ) : (
                    <Info
                      aria-hidden="true"
                      className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                    />
                  )}
                  <div className="space-y-0.5">
                    <p className="text-sm font-medium">
                      <span className="sr-only">{t(severityKey)}: </span>
                      {isAnalyticsKey(titleKey) ? t(titleKey) : item.code}
                    </p>
                    <p className="text-sm text-muted-foreground">{sentence(item)}</p>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Section>
  );
}
