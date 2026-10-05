import { formatMoney } from '@elysium/i18n';
import {
  Button,
  DateTime,
  EmptyState,
  ErrorState,
  Money,
  PageHeader,
  Section,
  Skeleton,
  StatCard,
  StatusBadge,
} from '@elysium/ui';
import type { BrandFiguresWire, BrandLiveWire } from '@elysium/mother-shared';
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { getRouteApi, useNavigate } from '@tanstack/react-router';
import { ExternalLink, RefreshCw } from 'lucide-react';
import { useState, type ReactNode } from 'react';

import { ApiError, endpoints } from '../api.js';
import { useLocale, type MessageKey } from '../i18n/locale.js';
import { BrandFreshness, brandErrorKey } from '../ui/brand-status.js';
import { count, percent, times } from '../ui/format.js';
import { Alert, Notice } from '../ui/primitives.js';
import { RangeBar } from '../ui/range-bar.js';
import { SimpleTable } from '../ui/simple-table.js';
import { rangeOf } from '../ui/range.js';
import { TrendChart } from '../ui/trend-chart.js';

/**
 * One brand's page (M32 screen 3): its figures and trend from the pulled rollups, lists
 * read live from its database when the page opens, and "Open <brand> ERP", which mints a
 * one-time owner link and goes there (D-490). The page carries no Referer to the brand:
 * `index.html` sets `no-referrer`, and nginx sends the same header.
 */

const route = getRouteApi('/brands/$brandId');

const ORDER_STATUS: Readonly<Record<string, MessageKey>> = {
  pending: 'orderStatus.pending',
  confirmed: 'orderStatus.confirmed',
  on_hold: 'orderStatus.on_hold',
  packed: 'orderStatus.packed',
  shipped: 'orderStatus.shipped',
  delivered: 'orderStatus.delivered',
  partially_delivered: 'orderStatus.partially_delivered',
  return_in_transit: 'orderStatus.return_in_transit',
  returned: 'orderStatus.returned',
  cancelled: 'orderStatus.cancelled',
  exchange: 'orderStatus.exchange',
};

const CHANNEL: Readonly<Record<string, MessageKey>> = {
  facebook: 'channel.facebook',
  whatsapp: 'channel.whatsapp',
  instagram: 'channel.instagram',
  tiktok: 'channel.tiktok',
  landing_page: 'channel.landing_page',
  website: 'channel.website',
  phone: 'channel.phone',
  walk_in: 'channel.walk_in',
  reseller: 'channel.reseller',
};

const WALLET_KIND: Readonly<Record<string, MessageKey>> = {
  wallet_cash: 'walletKind.wallet_cash',
  wallet_bank: 'walletKind.wallet_bank',
  wallet_bkash: 'walletKind.wallet_bkash',
  wallet_mfs_other: 'walletKind.wallet_mfs_other',
};

export function BrandPage() {
  const { t, locale } = useLocale();
  const { brandId } = route.useParams();
  const search = route.useSearch();
  const navigate = useNavigate();
  const range = rangeOf(search);
  const [queued, setQueued] = useState(false);

  const figures = useQuery({
    queryKey: ['brand-figures', brandId, range.from, range.to],
    queryFn: () => endpoints.brandFigures(brandId, range.from, range.to),
    placeholderData: keepPreviousData,
  });
  const live = useQuery({
    queryKey: ['brand-live', brandId],
    queryFn: () => endpoints.brandLive(brandId),
    staleTime: 60_000,
  });

  const open = useMutation({
    mutationFn: () => endpoints.ownerLink(brandId),
    onSuccess: ({ url }) => {
      // A full navigation, same tab: the link is single use and lives a minute.
      window.location.assign(url);
    },
  });
  const pull = useMutation({
    mutationFn: () => endpoints.pull(brandId, false),
    onSuccess: () => setQueued(true),
  });

  if (figures.isPending) return <Skeleton className="h-64 w-full" />;
  if (figures.isError) {
    return figures.error instanceof ApiError && figures.error.status === 404 ? (
      <EmptyState title={t('common.notFound')} detail={t('common.notFoundDetail')} />
    ) : (
      <ErrorState title={t('common.error')} detail={t('common.errorDetail')} />
    );
  }

  const data = figures.data;
  const brand = data.brand;
  const openError =
    open.error instanceof ApiError && open.error.code === 'OWNER_LINK_KEY_MISSING'
      ? 'brand.noKey'
      : open.isError
        ? 'brand.openFailed'
        : null;
  const openLabel = `${t('brand.openBefore')} ${brand.displayName} ${t('brand.openAfter')}`.trim();

  return (
    <div className="space-y-8">
      <PageHeader
        title={brand.displayName}
        meta={<BrandFreshness brand={brand} />}
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              disabled={pull.isPending}
              onClick={() => pull.mutate()}
            >
              <RefreshCw aria-hidden="true" />
              {t('brand.pullNow')}
            </Button>
            <Button
              size="sm"
              disabled={open.isPending || !brand.isActive}
              onClick={() => open.mutate()}
            >
              <ExternalLink aria-hidden="true" />
              {open.isPending ? t('brand.opening') : openLabel}
            </Button>
          </>
        }
      />
      {openError === null ? null : <Alert>{t(openError)}</Alert>}
      {queued ? <Notice>{t('brand.pullQueued')}</Notice> : null}
      {brand.lastError !== null &&
      (brand.figuresAt === null || brand.lastError.at > brand.figuresAt) ? (
        <Alert>{t(brandErrorKey(brand.lastError.code))}</Alert>
      ) : null}

      <RangeBar
        value={range}
        onChange={(next) =>
          void navigate({
            to: '/brands/$brandId',
            params: { brandId },
            search: { from: next.from, to: next.to },
          })
        }
      />

      <div className={figures.isPlaceholderData ? 'space-y-8 opacity-60' : 'space-y-8'}>
        <Figures data={data} />
        <Section title={t('metric.deliveredRevenue')}>
          <TrendChart
            legend={false}
            dates={data.series.map((point) => point.date)}
            series={[
              {
                key: brand.id,
                label: brand.displayName,
                slot: 0,
                values: data.series.map(
                  (point) => Number(BigInt(point.deliveredRevenuePoisha)) / 100,
                ),
              },
            ]}
            locale={locale}
            title={`${brand.displayName}: ${t('metric.deliveredRevenue')}`}
            dateHeading={t('range.label')}
            showTableLabel={t('common.showTable')}
            showChartLabel={t('common.showChart')}
            tick={(value) =>
              formatMoney(BigInt(Math.round(value)) * 100n, { locale, trimWholePaisa: true })
            }
            display={(_series, day) =>
              formatMoney(data.series[day]?.deliveredRevenuePoisha ?? '0', {
                locale,
                trimWholePaisa: true,
              })
            }
          />
        </Section>
        <div className="grid gap-6 xl:grid-cols-2">
          <Channels data={data} />
          <Campaigns data={data} />
        </div>
      </div>

      <Section title={t('brand.live')} description={t('brand.liveHint')} variant="plain">
        {live.isPending ? (
          <Skeleton className="h-48 w-full" />
        ) : live.isError || !live.data.ok ? (
          <ErrorState
            title={t('brand.liveUnavailable')}
            detail={
              live.data !== undefined && !live.data.ok
                ? t(brandErrorKey(live.data.error.code))
                : t('common.errorDetail')
            }
          />
        ) : (
          <Live live={live.data.live} />
        )}
      </Section>
    </div>
  );
}

function Figures({ data }: { readonly data: BrandFiguresWire }) {
  const { t, locale } = useLocale();
  const f = data.figures;
  const s = data.snapshot;
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label={t('metric.deliveredRevenue')}
          value={<Money poisha={f.deliveredRevenuePoisha} locale={locale} compact align="start" />}
        />
        <StatCard
          label={t('metric.grossProfit')}
          value={<Money poisha={f.grossProfitPoisha} locale={locale} compact align="start" />}
        />
        <StatCard
          label={t('metric.ordersDelivered')}
          value={count(f.ordersDelivered, locale)}
          hint={`${t('metric.ordersPlaced')}: ${count(f.ordersPlaced, locale)} · ${t('metric.ordersConfirmed')}: ${count(f.ordersConfirmed, locale)}`}
        />
        <StatCard
          label={t('metric.spend')}
          value={<Money poisha={f.spendPoisha} locale={locale} compact align="start" />}
          hint={`${t('metric.roas')} ${times(f.roasBps, locale)}`}
        />
      </div>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-4 rounded-lg border border-border bg-card p-5 sm:grid-cols-4 xl:grid-cols-8">
        <Fact label={t('metric.deliverySuccess')} value={percent(f.deliverySuccessBps, locale)} />
        <Fact label={t('metric.returnRate')} value={percent(f.returnRateBps, locale)} />
        <Fact
          label={t('metric.cpdo')}
          value={
            f.cpdoPoisha === null ? (
              '—'
            ) : (
              <Money poisha={f.cpdoPoisha} locale={locale} align="start" />
            )
          }
        />
        <Fact
          label={t('metric.aov')}
          value={
            f.aovPoisha === null ? (
              '—'
            ) : (
              <Money poisha={f.aovPoisha} locale={locale} align="start" />
            )
          }
        />
        <Fact
          label={t('metric.cash')}
          value={
            s === null ? '—' : <Money poisha={s.cashPoisha} locale={locale} compact align="start" />
          }
        />
        <Fact
          label={t('metric.stockValue')}
          value={
            s === null ? (
              '—'
            ) : (
              <Money poisha={s.stockValuePoisha} locale={locale} compact align="start" />
            )
          }
        />
        <Fact
          label={t('metric.codHeld')}
          value={
            s === null ? (
              '—'
            ) : (
              <Money poisha={s.codHeldPoisha} locale={locale} compact align="start" />
            )
          }
        />
        <Fact
          label={t('metric.openOrders')}
          value={s === null ? '—' : count(s.openOrdersTotal, locale)}
        />
      </dl>
    </div>
  );
}

function Fact({ label, value }: { readonly label: string; readonly value: ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 font-medium tabular-nums">{value}</dd>
    </div>
  );
}

function Channels({ data }: { readonly data: BrandFiguresWire }) {
  const { t, locale } = useLocale();
  return (
    <Section title={t('brand.byChannel')} bodyClassName="p-0">
      {data.byChannel.length === 0 ? (
        <p className="px-5 pb-5 text-sm text-muted-foreground">{t('brand.empty')}</p>
      ) : (
        <SimpleTable
          caption={t('brand.byChannel')}
          numeric={[1, 2, 3]}
          head={[
            t('brand.channel'),
            t('metric.ordersDelivered'),
            t('metric.deliveredRevenue'),
            t('metric.returnRate'),
          ]}
          rows={data.byChannel.map((row) => ({
            key: row.channel,
            cells: [
              CHANNEL[row.channel] === undefined
                ? row.channel
                : t(CHANNEL[row.channel] ?? 'channel.website'),
              count(row.ordersDelivered, locale),
              <Money key="m" poisha={row.deliveredRevenuePoisha} locale={locale} />,
              percent(row.returnRateBps, locale),
            ],
          }))}
        />
      )}
    </Section>
  );
}

function Campaigns({ data }: { readonly data: BrandFiguresWire }) {
  const { t, locale } = useLocale();
  return (
    <Section title={t('brand.byCampaign')} bodyClassName="p-0">
      {data.byCampaign.length === 0 ? (
        <p className="px-5 pb-5 text-sm text-muted-foreground">{t('brand.empty')}</p>
      ) : (
        <SimpleTable
          caption={t('brand.byCampaign')}
          numeric={[1, 2, 3]}
          head={[
            t('brand.campaign'),
            t('metric.spend'),
            t('metric.ordersDelivered'),
            t('metric.roas'),
          ]}
          rows={data.byCampaign.map((row) => ({
            key: row.campaignKey,
            cells: [
              row.name ?? t('brand.unattributed'),
              <Money key="m" poisha={row.spendPoisha} locale={locale} />,
              count(row.ordersDelivered, locale),
              times(row.roasBps, locale),
            ],
          }))}
        />
      )}
    </Section>
  );
}

function Live({ live }: { readonly live: BrandLiveWire }) {
  const { t, locale } = useLocale();
  return (
    <div className="grid gap-6 xl:grid-cols-2">
      <Section title={t('brand.latestOrders')} bodyClassName="p-0">
        <SimpleTable
          caption={t('brand.latestOrders')}
          numeric={[3]}
          head={[t('brand.order'), t('brand.status'), t('brand.placed'), t('brand.value')]}
          empty={t('brand.empty')}
          rows={live.latestOrders.map((order) => ({
            key: order.orderNo,
            cells: [
              <span key="n" className="font-mono text-xs">
                {order.orderNo}
              </span>,
              <StatusBadge key="s" tone="neutral">
                {ORDER_STATUS[order.status] === undefined
                  ? order.status
                  : t(ORDER_STATUS[order.status] ?? 'orderStatus.pending')}
              </StatusBadge>,
              <DateTime key="d" value={order.createdAt} compact />,
              <Money key="m" poisha={order.totalPoisha} locale={locale} />,
            ],
          }))}
        />
      </Section>
      <Section title={t('brand.topProducts')} bodyClassName="p-0">
        <SimpleTable
          caption={t('brand.topProducts')}
          numeric={[2]}
          head={[t('brand.sku'), t('brand.product'), t('brand.units')]}
          empty={t('brand.empty')}
          rows={live.topProducts.map((row) => ({
            key: row.skuCode,
            cells: [
              <span key="c" className="font-mono text-xs">
                {row.skuCode}
              </span>,
              row.productName,
              count(row.units, locale),
            ],
          }))}
        />
      </Section>
      <Section title={t('brand.lowStock')} bodyClassName="p-0">
        <SimpleTable
          caption={t('brand.lowStock')}
          numeric={[2, 3]}
          head={[t('brand.sku'), t('brand.location'), t('brand.available'), t('brand.reorder')]}
          empty={t('brand.empty')}
          rows={live.lowStock.map((row) => ({
            key: `${row.skuCode}:${row.location}`,
            cells: [
              <span key="c" className="font-mono text-xs">
                {row.skuCode}
              </span>,
              row.location,
              count(row.available, locale),
              count(row.reorderLevel, locale),
            ],
          }))}
        />
      </Section>
      <Section title={t('brand.wallets')} bodyClassName="p-0">
        <SimpleTable
          caption={t('brand.wallets')}
          numeric={[2]}
          head={[t('brand.wallet'), t('brand.walletKind'), t('brand.balance')]}
          empty={t('brand.empty')}
          rows={live.wallets.map((row) => ({
            key: row.code,
            cells: [
              `${row.code} · ${row.name}`,
              WALLET_KIND[row.subtype] === undefined
                ? row.subtype
                : t(WALLET_KIND[row.subtype] ?? 'walletKind.wallet_cash'),
              <Money key="m" poisha={row.balancePoisha} locale={locale} />,
            ],
          }))}
        />
      </Section>
      <Section title={t('brand.courierCod')} bodyClassName="p-0">
        <SimpleTable
          caption={t('brand.courierCod')}
          numeric={[1]}
          head={[t('brand.courier'), t('brand.held')]}
          empty={t('brand.empty')}
          rows={live.courierCod.map((row) => ({
            key: row.courier,
            cells: [row.courier, <Money key="m" poisha={row.heldPoisha} locale={locale} />],
          }))}
        />
      </Section>
      <Section
        title={t('brand.staffList')}
        description={`${t('brand.headcount')}: ${count(live.staff.headcount, locale)}`}
        bodyClassName="p-0"
      >
        <SimpleTable
          caption={t('brand.staffList')}
          numeric={[]}
          head={[t('brand.name'), t('brand.role'), t('brand.branch'), t('brand.status')]}
          empty={t('brand.empty')}
          rows={live.staff.people.map((person) => ({
            key: person.code,
            cells: [
              person.fullName,
              person.designation ?? '—',
              person.branch ?? '—',
              <StatusBadge key="s" tone={person.status === 'active' ? 'success' : 'warning'}>
                {person.status === 'active' ? t('staffStatus.active') : t('staffStatus.suspended')}
              </StatusBadge>,
            ],
          }))}
        />
      </Section>
    </div>
  );
}
