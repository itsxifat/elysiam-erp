import { formatMoney, type Locale } from '@elysium/i18n';
import {
  EmptyState,
  ErrorState,
  Money,
  PageHeader,
  Section,
  Select,
  Skeleton,
  StatCard,
  type StatDelta,
} from '@elysium/ui';
import type { FiguresWire, OverviewWire } from '@elysium/mother-shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router';
import { Building2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';

import { endpoints } from '../api.js';
import { useLocale, type MessageKey } from '../i18n/locale.js';
import { BrandFreshness } from '../ui/brand-status.js';
import { changeBps, count, percent, signedPercent, times } from '../ui/format.js';
import { RangeBar } from '../ui/range-bar.js';
import { rangeOf } from '../ui/range.js';
import { TrendChart } from '../ui/trend-chart.js';

/**
 * The overview (M32 screen 1): every brand's figures for a period, side by side and added
 * together, the positions each brand holds now, and a line per brand over the period.
 * The totals are the sums of the rows below them (check 1), computed by the server.
 */

const route = getRouteApi('/');

type TrendMeasure =
  | 'deliveredRevenuePoisha'
  | 'grossProfitPoisha'
  | 'spendPoisha'
  | 'ordersDelivered'
  | 'ordersPlaced';

const MEASURES: readonly {
  readonly key: TrendMeasure;
  readonly label: MessageKey;
  readonly money: boolean;
}[] = [
  { key: 'deliveredRevenuePoisha', label: 'metric.deliveredRevenue', money: true },
  { key: 'grossProfitPoisha', label: 'metric.grossProfit', money: true },
  { key: 'spendPoisha', label: 'metric.spend', money: true },
  { key: 'ordersDelivered', label: 'metric.ordersDelivered', money: false },
  { key: 'ordersPlaced', label: 'metric.ordersPlaced', money: false },
];

function delta(
  now: bigint,
  before: bigint,
  locale: Locale,
  caption: string,
): StatDelta | undefined {
  const change = changeBps(now, before);
  if (change === null) return undefined;
  return {
    label: signedPercent(change, locale),
    direction: change > 0n ? 'up' : change < 0n ? 'down' : 'flat',
    tone: change > 0n ? 'positive' : change < 0n ? 'negative' : 'neutral',
    caption,
  };
}

export function OverviewPage() {
  const { t, locale } = useLocale();
  const search = route.useSearch();
  const navigate = useNavigate();
  const range = rangeOf(search);
  const [measure, setMeasure] = useState<TrendMeasure>('deliveredRevenuePoisha');
  const query = useQuery({
    queryKey: ['overview', range.from, range.to],
    queryFn: () => endpoints.overview(range.from, range.to),
    placeholderData: keepPreviousData,
  });

  return (
    <div className="space-y-8">
      <PageHeader title={t('overview.title')} description={t('overview.description')} />
      <RangeBar
        value={range}
        onChange={(next) => void navigate({ to: '/', search: { from: next.from, to: next.to } })}
      />
      {query.isPending ? (
        <div className="grid gap-4 md:grid-cols-4" aria-busy="true">
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton key={index} className="h-32" />
          ))}
        </div>
      ) : query.isError ? (
        <ErrorState
          title={t('common.error')}
          detail={t('common.errorDetail')}
          action={
            <button
              type="button"
              className="text-sm text-primary underline-offset-4 hover:underline"
              onClick={() => void query.refetch()}
            >
              {t('common.retry')}
            </button>
          }
        />
      ) : query.data.brands.length === 0 ? (
        <EmptyState
          icon={Building2}
          title={t('overview.noBrands')}
          detail={t('overview.noBrandsDetail')}
          action={
            <Link
              to="/settings/brands"
              className="text-sm text-primary underline-offset-4 hover:underline"
            >
              {t('overview.aboutBrands')}
            </Link>
          }
        />
      ) : (
        <div className={query.isPlaceholderData ? 'space-y-8 opacity-60' : 'space-y-8'}>
          <Totals data={query.data} />
          <Positions data={query.data} />
          <Section
            title={t('overview.trend')}
            actions={
              <Select
                value={measure}
                onValueChange={(value) => setMeasure(value as TrendMeasure)}
                aria-label={t('overview.trendMetric')}
                size="sm"
                options={MEASURES.map((option) => ({ value: option.key, label: t(option.label) }))}
              />
            }
          >
            <Trend data={query.data} measure={measure} locale={locale} />
          </Section>
          <BrandTable data={query.data} />
        </div>
      )}
    </div>
  );
}

function Totals({ data }: { readonly data: OverviewWire }) {
  const { t, locale } = useLocale();
  const caption = t('common.vsBefore');
  const now = data.totals;
  const before = data.previousTotals;
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <StatCard
        label={t('metric.deliveredRevenue')}
        value={<Money poisha={now.deliveredRevenuePoisha} locale={locale} compact align="start" />}
        delta={delta(
          BigInt(now.deliveredRevenuePoisha),
          BigInt(before.deliveredRevenuePoisha),
          locale,
          caption,
        )}
      />
      <StatCard
        label={t('metric.grossProfit')}
        value={<Money poisha={now.grossProfitPoisha} locale={locale} compact align="start" />}
        delta={delta(
          BigInt(now.grossProfitPoisha),
          BigInt(before.grossProfitPoisha),
          locale,
          caption,
        )}
      />
      <StatCard
        label={t('metric.ordersDelivered')}
        value={count(now.ordersDelivered, locale)}
        delta={delta(BigInt(now.ordersDelivered), BigInt(before.ordersDelivered), locale, caption)}
        hint={`${t('metric.ordersPlaced')}: ${count(now.ordersPlaced, locale)}`}
      />
      <StatCard
        label={t('metric.spend')}
        value={<Money poisha={now.spendPoisha} locale={locale} compact align="start" />}
        hint={`${t('metric.roas')} ${times(now.roasBps, locale)} · ${t('metric.returnRate')} ${percent(now.returnRateBps, locale)}`}
      />
    </div>
  );
}

function Positions({ data }: { readonly data: OverviewWire }) {
  const { t, locale } = useLocale();
  const totals = data.snapshotTotals;
  const items: readonly { label: MessageKey; value: ReactNode }[] = [
    {
      label: 'metric.cash',
      value: <Money poisha={totals.cashPoisha} locale={locale} compact align="start" />,
    },
    {
      label: 'metric.stockValue',
      value: <Money poisha={totals.stockValuePoisha} locale={locale} compact align="start" />,
    },
    {
      label: 'metric.codHeld',
      value: <Money poisha={totals.codHeldPoisha} locale={locale} compact align="start" />,
    },
    {
      label: 'metric.supplierPayables',
      value: <Money poisha={totals.supplierPayablesPoisha} locale={locale} compact align="start" />,
    },
    { label: 'metric.openOrders', value: count(totals.openOrdersTotal, locale) },
    { label: 'metric.staff', value: count(totals.staffHeadcount, locale) },
  ];
  return (
    <Section title={t('overview.positions')} description={t('overview.positionsHint')}>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3 xl:grid-cols-6">
        {items.map((item) => (
          <div key={item.label}>
            <dt className="text-xs text-muted-foreground">{t(item.label)}</dt>
            <dd className="mt-1 text-lg font-medium">{item.value}</dd>
          </div>
        ))}
      </dl>
    </Section>
  );
}

function Trend({
  data,
  measure,
  locale,
}: {
  readonly data: OverviewWire;
  readonly measure: TrendMeasure;
  readonly locale: Locale;
}) {
  const { t } = useLocale();
  const option = MEASURES.find((entry) => entry.key === measure) ?? MEASURES[0];
  const brands = data.brands;
  const raw = (brandId: string, day: number): bigint => {
    const point = data.series[day]?.byBrand[brandId];
    if (point === undefined) return 0n;
    const value = point[measure];
    return typeof value === 'number' ? BigInt(value) : BigInt(value);
  };
  const series = brands.map((row, index) => ({
    key: row.brand.id,
    label: row.brand.displayName,
    slot: index,
    // Taka for money (poisha ÷ 100) so ticks read as taka; geometry only.
    values: data.series.map((_, day) =>
      option?.money === true
        ? Number(raw(row.brand.id, day)) / 100
        : Number(raw(row.brand.id, day)),
    ),
  }));
  return (
    <TrendChart
      dates={data.series.map((point) => point.date)}
      series={series}
      locale={locale}
      title={`${t('overview.trend')}: ${t(option?.label ?? 'metric.deliveredRevenue')}`}
      dateHeading={t('range.label')}
      showTableLabel={t('common.showTable')}
      showChartLabel={t('common.showChart')}
      tick={(value) =>
        option?.money === true
          ? formatMoney(BigInt(Math.round(value)) * 100n, { locale, trimWholePaisa: true })
          : count(Math.round(value), locale)
      }
      display={(seriesIndex, day) => {
        const id = brands[seriesIndex]?.brand.id ?? '';
        const value = raw(id, day);
        return option?.money === true
          ? formatMoney(value, { locale, trimWholePaisa: true })
          : count(Number(value), locale);
      }}
    />
  );
}

const COLUMNS: readonly {
  readonly label: MessageKey;
  readonly cell: (figures: FiguresWire, locale: Locale) => ReactNode;
}[] = [
  { label: 'metric.ordersPlaced', cell: (f, l) => count(f.ordersPlaced, l) },
  { label: 'metric.ordersConfirmed', cell: (f, l) => count(f.ordersConfirmed, l) },
  { label: 'metric.ordersDelivered', cell: (f, l) => count(f.ordersDelivered, l) },
  { label: 'metric.ordersReturned', cell: (f, l) => count(f.ordersReturned, l) },
  { label: 'metric.ordersCancelled', cell: (f, l) => count(f.ordersCancelled, l) },
  {
    label: 'metric.deliveredRevenue',
    cell: (f, l) => <Money poisha={f.deliveredRevenuePoisha} locale={l} />,
  },
  {
    label: 'metric.grossProfit',
    cell: (f, l) => <Money poisha={f.grossProfitPoisha} locale={l} />,
  },
  { label: 'metric.spend', cell: (f, l) => <Money poisha={f.spendPoisha} locale={l} /> },
  { label: 'metric.roas', cell: (f, l) => times(f.roasBps, l) },
  {
    label: 'metric.cpdo',
    cell: (f, l) => (f.cpdoPoisha === null ? '—' : <Money poisha={f.cpdoPoisha} locale={l} />),
  },
  { label: 'metric.deliverySuccess', cell: (f, l) => percent(f.deliverySuccessBps, l) },
  { label: 'metric.returnRate', cell: (f, l) => percent(f.returnRateBps, l) },
];

function BrandTable({ data }: { readonly data: OverviewWire }) {
  const { t, locale } = useLocale();
  return (
    <Section title={t('overview.orders')} bodyClassName="p-0">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[1200px] text-sm">
          <caption className="sr-only">{t('overview.orders')}</caption>
          <thead>
            <tr className="border-b border-border text-xs text-muted-foreground">
              <th
                scope="col"
                className="sticky left-0 min-w-52 bg-card px-4 py-2.5 text-left font-medium"
              >
                {t('overview.brand')}
              </th>
              {COLUMNS.map((column) => (
                <th key={column.label} scope="col" className="px-3 py-2.5 text-right font-medium">
                  {t(column.label)}
                </th>
              ))}
              <th scope="col" className="px-3 py-2.5 text-right font-medium">
                {t('metric.cash')}
              </th>
              <th scope="col" className="px-3 py-2.5 text-right font-medium">
                {t('metric.stockValue')}
              </th>
              <th scope="col" className="px-4 py-2.5 text-right font-medium">
                {t('metric.codHeld')}
              </th>
            </tr>
          </thead>
          <tbody>
            {data.brands.map((row) => (
              <tr key={row.brand.id} className="border-b border-border">
                <th scope="row" className="sticky left-0 bg-card px-4 py-2.5 text-left font-normal">
                  <Link
                    to="/brands/$brandId"
                    params={{ brandId: row.brand.id }}
                    search={{ from: data.from, to: data.to }}
                    className="font-medium text-foreground underline-offset-4 hover:underline"
                  >
                    {row.brand.displayName}
                  </Link>
                  <div className="mt-0.5">
                    <BrandFreshness brand={row.brand} />
                  </div>
                </th>
                {COLUMNS.map((column) => (
                  <td key={column.label} className="px-3 py-2.5 text-right tabular-nums">
                    {column.cell(row.figures, locale)}
                  </td>
                ))}
                <td className="px-3 py-2.5 text-right tabular-nums">
                  {row.snapshot === null ? (
                    '—'
                  ) : (
                    <Money poisha={row.snapshot.cashPoisha} locale={locale} />
                  )}
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums">
                  {row.snapshot === null ? (
                    '—'
                  ) : (
                    <Money poisha={row.snapshot.stockValuePoisha} locale={locale} />
                  )}
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums">
                  {row.snapshot === null ? (
                    '—'
                  ) : (
                    <Money poisha={row.snapshot.codHeldPoisha} locale={locale} />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="font-medium">
              <th scope="row" className="sticky left-0 bg-card px-4 py-2.5 text-left">
                {t('overview.allBrands')}
              </th>
              {COLUMNS.map((column) => (
                <td key={column.label} className="px-3 py-2.5 text-right tabular-nums">
                  {column.cell(data.totals, locale)}
                </td>
              ))}
              <td className="px-3 py-2.5 text-right tabular-nums">
                <Money poisha={data.snapshotTotals.cashPoisha} locale={locale} />
              </td>
              <td className="px-3 py-2.5 text-right tabular-nums">
                <Money poisha={data.snapshotTotals.stockValuePoisha} locale={locale} />
              </td>
              <td className="px-4 py-2.5 text-right tabular-nums">
                <Money poisha={data.snapshotTotals.codHeldPoisha} locale={locale} />
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </Section>
  );
}
