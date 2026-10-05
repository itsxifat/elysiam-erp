import { addDays, periodForMonth } from '@elysium/domain';
import { LEADERBOARD_METRICS, type LeaderboardWeights } from '@elysium/domain/analytics';
import {
  daysOf,
  figuresWire,
  previousRange,
  profitAndLossFrom,
  rankBrands,
  snapshotWire,
  sumFigures,
  sumSnapshots,
  WALLET_KINDS,
  ZERO_FIGURES,
  type BrandFiguresWire,
  type DateRange,
  type Figures,
  type LeaderboardWire,
  type OverviewBrandWire,
  type OverviewWire,
  type ProfitAndLossWire,
  type SeriesPoint,
  type SnapshotFigures,
  type WalletKind,
  type WalletsWire,
} from '@elysium/mother-shared';

import { brandStatusWire, listBrands, requireBrand, type BrandRow } from '../brands/registry.js';
import { motherSql } from '../db/client.js';

/**
 * Everything the owner's screens show that comes from the pulled figures (D-484 to D-493).
 *
 * Read from the mother's own database only, so a brand that is down still shows the last
 * figures it gave, with their age (D-486). The arithmetic is `@elysium/mother-shared`'s:
 * SQL sums each brand's days exactly (bigint), and the group is the sum of the brands.
 */

interface FigureRow {
  readonly brand_id: string;
  readonly days: number;
  readonly orders_placed: number;
  readonly orders_confirmed: number;
  readonly orders_delivered: number;
  readonly orders_returned: number;
  readonly orders_cancelled: number;
  readonly delivered_revenue_poisha: string;
  readonly gross_profit_poisha: string;
  readonly spend_poisha: string;
  readonly pickup_count: number;
  readonly pickup_seconds: string;
  readonly delivered_outside_dhaka: number;
  readonly returned_outside_dhaka: number;
}

function figuresOf(row: FigureRow | undefined): Figures {
  if (row === undefined) return ZERO_FIGURES;
  return {
    ordersPlaced: row.orders_placed,
    ordersConfirmed: row.orders_confirmed,
    ordersDelivered: row.orders_delivered,
    ordersReturned: row.orders_returned,
    ordersCancelled: row.orders_cancelled,
    deliveredRevenuePoisha: BigInt(row.delivered_revenue_poisha),
    grossProfitPoisha: BigInt(row.gross_profit_poisha),
    spendPoisha: BigInt(row.spend_poisha),
    pickupCount: row.pickup_count,
    pickupSeconds: BigInt(row.pickup_seconds),
    deliveredOutsideDhaka: row.delivered_outside_dhaka,
    returnedOutsideDhaka: row.returned_outside_dhaka,
  };
}

/** Each brand's days in a range, summed exactly in SQL. */
async function figuresByBrand(range: DateRange): Promise<Map<string, FigureRow>> {
  const rows = await motherSql()<FigureRow[]>`
    select brand_id::text as brand_id, count(*)::int as days,
           coalesce(sum(orders_placed), 0)::int as orders_placed,
           coalesce(sum(orders_confirmed), 0)::int as orders_confirmed,
           coalesce(sum(orders_delivered), 0)::int as orders_delivered,
           coalesce(sum(orders_returned), 0)::int as orders_returned,
           coalesce(sum(orders_cancelled), 0)::int as orders_cancelled,
           coalesce(sum(delivered_revenue_poisha), 0)::text as delivered_revenue_poisha,
           coalesce(sum(gross_profit_poisha), 0)::text as gross_profit_poisha,
           coalesce(sum(spend_poisha), 0)::text as spend_poisha,
           coalesce(sum(pickup_count), 0)::int as pickup_count,
           coalesce(sum(pickup_seconds), 0)::text as pickup_seconds,
           coalesce(sum(delivered_outside_dhaka), 0)::int as delivered_outside_dhaka,
           coalesce(sum(returned_outside_dhaka), 0)::int as returned_outside_dhaka
    from mother.brand_daily
    where business_date between ${range.from}::date and ${range.to}::date
    group by brand_id
  `;
  return new Map(rows.map((row) => [row.brand_id, row]));
}

interface SnapshotRow {
  readonly brand_id: string;
  readonly taken_at: Date;
  readonly as_of: string;
  readonly cash_hand_poisha: string;
  readonly cash_bank_poisha: string;
  readonly cash_bkash_poisha: string;
  readonly cash_mfs_other_poisha: string;
  readonly stock_value_poisha: string;
  readonly goods_in_transit_poisha: string;
  readonly cod_held_poisha: string;
  readonly supplier_payables_poisha: string;
  readonly receivables_poisha: string;
  readonly open_orders: Record<string, number>;
  readonly staff_headcount: number;
  readonly active_skus: number;
  readonly low_stock_skus: number;
}

/** Each brand's latest snapshot. */
async function latestSnapshots(): Promise<Map<string, SnapshotRow>> {
  const rows = await motherSql()<SnapshotRow[]>`
    select distinct on (brand_id)
           brand_id::text as brand_id, taken_at, as_of::text as as_of,
           cash_hand_poisha::text as cash_hand_poisha, cash_bank_poisha::text as cash_bank_poisha,
           cash_bkash_poisha::text as cash_bkash_poisha,
           cash_mfs_other_poisha::text as cash_mfs_other_poisha,
           stock_value_poisha::text as stock_value_poisha,
           goods_in_transit_poisha::text as goods_in_transit_poisha,
           cod_held_poisha::text as cod_held_poisha,
           supplier_payables_poisha::text as supplier_payables_poisha,
           receivables_poisha::text as receivables_poisha,
           open_orders, staff_headcount, active_skus, low_stock_skus
    from mother.brand_snapshots
    order by brand_id, taken_at desc
  `;
  return new Map(rows.map((row) => [row.brand_id, row]));
}

function snapshotFigures(row: SnapshotRow): SnapshotFigures {
  const cashByKind: Record<WalletKind, bigint> = {
    wallet_cash: BigInt(row.cash_hand_poisha),
    wallet_bank: BigInt(row.cash_bank_poisha),
    wallet_bkash: BigInt(row.cash_bkash_poisha),
    wallet_mfs_other: BigInt(row.cash_mfs_other_poisha),
  };
  return {
    cashPoisha: WALLET_KINDS.reduce((total, kind) => total + cashByKind[kind], 0n),
    cashByKind,
    stockValuePoisha: BigInt(row.stock_value_poisha),
    goodsInTransitPoisha: BigInt(row.goods_in_transit_poisha),
    codHeldPoisha: BigInt(row.cod_held_poisha),
    supplierPayablesPoisha: BigInt(row.supplier_payables_poisha),
    receivablesPoisha: BigInt(row.receivables_poisha),
    openOrders: row.open_orders,
    staffHeadcount: row.staff_headcount,
    activeSkus: row.active_skus,
    lowStockSkus: row.low_stock_skus,
  };
}

function snapshotView(row: SnapshotRow | undefined): OverviewBrandWire['snapshot'] {
  if (row === undefined) return null;
  return {
    ...snapshotWire(snapshotFigures(row)),
    takenAt: row.taken_at.toISOString(),
    asOf: row.as_of,
  };
}

interface DayPoint {
  readonly brand_id: string;
  readonly business_date: string;
  readonly orders_placed: number;
  readonly orders_delivered: number;
  readonly delivered_revenue_poisha: string;
  readonly gross_profit_poisha: string;
  readonly spend_poisha: string;
}

async function dayPoints(range: DateRange, brandId?: string): Promise<DayPoint[]> {
  const sql = motherSql();
  return [
    ...(await sql<DayPoint[]>`
      select brand_id::text as brand_id, business_date::text as business_date,
             orders_placed, orders_delivered,
             delivered_revenue_poisha::text as delivered_revenue_poisha,
             gross_profit_poisha::text as gross_profit_poisha,
             spend_poisha::text as spend_poisha
      from mother.brand_daily
      where business_date between ${range.from}::date and ${range.to}::date
        ${brandId === undefined ? sql`` : sql`and brand_id = ${brandId}`}
      order by business_date
    `),
  ];
}

/** The brands the screens add up: the active ones, in the registry's order. */
async function activeBrands(): Promise<BrandRow[]> {
  return (await listBrands()).filter((brand) => brand.is_active);
}

// --- the overview ------------------------------------------------------------------------

export async function overview(range: DateRange): Promise<OverviewWire> {
  const before = previousRange(range);
  const brands = await activeBrands();
  const [current, previous, snapshots, points] = await Promise.all([
    figuresByBrand(range),
    figuresByBrand(before),
    latestSnapshots(),
    dayPoints(range),
  ]);

  const rows: OverviewBrandWire[] = brands.map((brand) => ({
    brand: brandStatusWire(brand),
    figures: figuresWire(figuresOf(current.get(brand.id))),
    previous: figuresWire(figuresOf(previous.get(brand.id))),
    snapshot: snapshotView(snapshots.get(brand.id)),
    computedDays: current.get(brand.id)?.days ?? 0,
  }));

  const included = new Set(brands.map((brand) => brand.id));
  const totals = sumFigures(brands.map((brand) => figuresOf(current.get(brand.id))));
  const previousTotals = sumFigures(brands.map((brand) => figuresOf(previous.get(brand.id))));
  const snapshotTotals = sumSnapshots(
    brands.flatMap((brand) => {
      const row = snapshots.get(brand.id);
      return row === undefined ? [] : [snapshotFigures(row)];
    }),
  );

  const byDate = new Map<string, Record<string, SeriesPoint['byBrand'][string]>>();
  for (const point of points) {
    if (!included.has(point.brand_id)) continue;
    const day = byDate.get(point.business_date) ?? {};
    day[point.brand_id] = {
      ordersPlaced: point.orders_placed,
      ordersDelivered: point.orders_delivered,
      deliveredRevenuePoisha: point.delivered_revenue_poisha,
      grossProfitPoisha: point.gross_profit_poisha,
      spendPoisha: point.spend_poisha,
    };
    byDate.set(point.business_date, day);
  }

  const days = daysOf(range);
  return {
    from: range.from,
    to: range.to,
    previousFrom: before.from,
    previousTo: before.to,
    days: days.length,
    totals: figuresWire(totals),
    previousTotals: figuresWire(previousTotals),
    snapshotTotals: snapshotWire(snapshotTotals),
    brands: rows,
    series: days.map((date) => ({ date, byBrand: byDate.get(date) ?? {} })),
  };
}

// --- the leaderboard (D-492) ---------------------------------------------------------------

export async function leaderboard(
  month: string,
  weights: LeaderboardWeights,
): Promise<LeaderboardWire> {
  const current = periodForMonth(month);
  const previousMonth = addDays(current.startsOn, -1).slice(0, 7);
  const previous = periodForMonth(previousMonth);
  const brands = await activeBrands();
  const [now, before] = await Promise.all([
    figuresByBrand({ from: current.startsOn, to: current.endsOn }),
    figuresByBrand({ from: previous.startsOn, to: previous.endsOn }),
  ]);
  const months = brands.map((brand) => ({
    brandId: brand.id,
    current: figuresOf(now.get(brand.id)),
    previous: figuresOf(before.get(brand.id)),
  }));
  const ranked = rankBrands(months, weights);
  const byId = new Map(months.map((entry) => [entry.brandId, entry]));
  const names = new Map(brands.map((brand) => [brand.id, brand.display_name]));
  return {
    month,
    previousMonth,
    metrics: LEADERBOARD_METRICS,
    weights,
    rows: ranked.map((entry) => {
      const source = byId.get(entry.orgId);
      return {
        brandId: entry.orgId,
        name: names.get(entry.orgId) ?? '',
        rank: entry.rank,
        compositeBps: entry.compositeBps,
        metrics: Object.fromEntries(
          LEADERBOARD_METRICS.map((metric) => [
            metric,
            entry.metrics[metric] === null ? null : String(entry.metrics[metric]),
          ]),
        ) as LeaderboardWire['rows'][number]['metrics'],
        ranks: entry.ranks,
        scores: entry.scores,
        current: figuresWire(source?.current ?? ZERO_FIGURES),
        previous: figuresWire(source?.previous ?? ZERO_FIGURES),
      };
    }),
  };
}

// --- one brand's page ----------------------------------------------------------------------

export async function brandFigures(brandId: string, range: DateRange): Promise<BrandFiguresWire> {
  const brand = await requireBrand(brandId);
  const before = previousRange(range);
  const sql = motherSql();
  const [current, previous, snapshots, points] = await Promise.all([
    figuresByBrand(range),
    figuresByBrand(before),
    latestSnapshots(),
    dayPoints(range, brand.id),
  ]);
  const channels = await sql<(FigureRow & { channel: string })[]>`
    select channel, brand_id::text as brand_id, count(*)::int as days,
           coalesce(sum(orders_placed), 0)::int as orders_placed,
           coalesce(sum(orders_confirmed), 0)::int as orders_confirmed,
           coalesce(sum(orders_delivered), 0)::int as orders_delivered,
           coalesce(sum(orders_returned), 0)::int as orders_returned,
           coalesce(sum(orders_cancelled), 0)::int as orders_cancelled,
           coalesce(sum(delivered_revenue_poisha), 0)::text as delivered_revenue_poisha,
           coalesce(sum(gross_profit_poisha), 0)::text as gross_profit_poisha,
           '0' as spend_poisha, 0 as pickup_count, '0' as pickup_seconds,
           coalesce(sum(delivered_outside_dhaka), 0)::int as delivered_outside_dhaka,
           coalesce(sum(returned_outside_dhaka), 0)::int as returned_outside_dhaka
    from mother.brand_daily_channel
    where brand_id = ${brand.id}
      and business_date between ${range.from}::date and ${range.to}::date
    group by channel, brand_id
    order by sum(delivered_revenue_poisha) desc, channel
  `;
  const campaigns = await sql<
    {
      campaign_key: string;
      name: string | null;
      spend_poisha: string;
      orders_confirmed: number;
      orders_delivered: number;
      delivered_revenue_poisha: string;
    }[]
  >`
    select campaign_key, max(campaign_name) as name,
           coalesce(sum(spend_poisha), 0)::text as spend_poisha,
           coalesce(sum(orders_confirmed), 0)::int as orders_confirmed,
           coalesce(sum(orders_delivered), 0)::int as orders_delivered,
           coalesce(sum(delivered_revenue_poisha), 0)::text as delivered_revenue_poisha
    from mother.brand_daily_campaign
    where brand_id = ${brand.id}
      and business_date between ${range.from}::date and ${range.to}::date
    group by campaign_key
    order by sum(spend_poisha) desc, campaign_key
  `;
  const byDate = new Map(points.map((point) => [point.business_date, point]));
  return {
    brand: brandStatusWire(brand),
    from: range.from,
    to: range.to,
    figures: figuresWire(figuresOf(current.get(brand.id))),
    previous: figuresWire(figuresOf(previous.get(brand.id))),
    snapshot: snapshotView(snapshots.get(brand.id)),
    series: daysOf(range).map((date) => {
      const point = byDate.get(date);
      return {
        date,
        ordersPlaced: point?.orders_placed ?? 0,
        ordersDelivered: point?.orders_delivered ?? 0,
        deliveredRevenuePoisha: point?.delivered_revenue_poisha ?? '0',
        grossProfitPoisha: point?.gross_profit_poisha ?? '0',
        spendPoisha: point?.spend_poisha ?? '0',
      };
    }),
    byChannel: channels.map((row) => ({ channel: row.channel, ...figuresWire(figuresOf(row)) })),
    byCampaign: campaigns.map((row) => {
      const ratios = figuresWire({
        ...ZERO_FIGURES,
        ordersConfirmed: row.orders_confirmed,
        ordersDelivered: row.orders_delivered,
        deliveredRevenuePoisha: BigInt(row.delivered_revenue_poisha),
        spendPoisha: BigInt(row.spend_poisha),
      });
      return {
        campaignKey: row.campaign_key,
        name: row.name,
        spendPoisha: row.spend_poisha,
        ordersConfirmed: row.orders_confirmed,
        ordersDelivered: row.orders_delivered,
        deliveredRevenuePoisha: row.delivered_revenue_poisha,
        roasBps: ratios.roasBps,
        cpdoPoisha: ratios.cpdoPoisha,
      };
    }),
  };
}

// --- accounts across brands (D-493) -------------------------------------------------------

export async function wallets(): Promise<WalletsWire> {
  const brands = await activeBrands();
  const snapshots = await latestSnapshots();
  const total: Record<WalletKind, bigint> = {
    wallet_cash: 0n,
    wallet_bank: 0n,
    wallet_bkash: 0n,
    wallet_mfs_other: 0n,
  };
  const rows = brands.map((brand) => {
    const row = snapshots.get(brand.id);
    if (row === undefined) {
      return {
        brand: brandStatusWire(brand),
        asOf: null,
        takenAt: null,
        cashByKind: null,
        totalPoisha: null,
      };
    }
    const figures = snapshotFigures(row);
    for (const kind of WALLET_KINDS) total[kind] += figures.cashByKind[kind];
    const wire = snapshotWire(figures);
    return {
      brand: brandStatusWire(brand),
      asOf: row.as_of,
      takenAt: row.taken_at.toISOString(),
      cashByKind: wire.cashByKind,
      totalPoisha: wire.cashPoisha,
    };
  });
  const cashByKind = Object.fromEntries(
    WALLET_KINDS.map((kind) => [kind, total[kind].toString()]),
  ) as Record<WalletKind, string>;
  return {
    brands: rows,
    cashByKind,
    totalPoisha: WALLET_KINDS.reduce((sum, kind) => sum + total[kind], 0n).toString(),
  };
}

export async function profitAndLoss(range: DateRange): Promise<ProfitAndLossWire> {
  const brands = await activeBrands();
  const rows = await motherSql()<
    {
      brand_id: string;
      subtype: string;
      account_class: 'income' | 'expense';
      debit_poisha: string;
      credit_poisha: string;
    }[]
  >`
    select brand_id::text as brand_id, subtype, account_class,
           sum(debit_poisha)::text as debit_poisha, sum(credit_poisha)::text as credit_poisha
    from mother.brand_daily_ledger
    where business_date between ${range.from}::date and ${range.to}::date
    group by brand_id, subtype, account_class
  `;
  let income = 0n;
  let expense = 0n;
  const perBrand = brands.map((brand) => {
    const result = profitAndLossFrom(
      rows
        .filter((row) => row.brand_id === brand.id)
        .map((row) => ({
          subtype: row.subtype,
          accountClass: row.account_class,
          debitPoisha: BigInt(row.debit_poisha),
          creditPoisha: BigInt(row.credit_poisha),
        })),
    );
    income += result.incomePoisha;
    expense += result.expensePoisha;
    return {
      brand: brandStatusWire(brand),
      incomePoisha: result.incomePoisha.toString(),
      expensePoisha: result.expensePoisha.toString(),
      netPoisha: result.netPoisha.toString(),
      lines: result.lines.map((line) => ({
        subtype: line.subtype,
        accountClass: line.accountClass,
        amountPoisha: line.amountPoisha.toString(),
      })),
    };
  });
  return {
    from: range.from,
    to: range.to,
    brands: perBrand,
    incomePoisha: income.toString(),
    expensePoisha: expense.toString(),
    netPoisha: (income - expense).toString(),
  };
}
