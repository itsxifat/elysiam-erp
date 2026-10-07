import {
  addDays,
  aggregateBalanceOf,
  daysBetween,
  periodForMonth,
  type IsoDate,
  type NormalBalance,
} from '@elysium/domain';
import {
  kpis,
  normalizedMetrics,
  rankBoard,
  type BrandMonth,
  type Kpis,
  type LeaderboardWeights,
  type RankedEntry,
} from '@elysium/domain/analytics';

/**
 * The mother's arithmetic (D-484, D-485, D-492, D-493): pure, exact, and the only place
 * the figures of several brands are added together.
 *
 * Every money figure is integer poisha as `bigint` (invariant 1); every count an integer.
 * Ratios are never summed or averaged across brands: the group's ratio is computed once
 * from the group's sums, by the same `kpis()` each brand's own dashboard uses (§18), so
 * "the group's return rate" means returns over deliveries for the whole group, not the
 * mean of five percentages.
 *
 * Lives in `packages/mother-shared` rather than `packages/domain` so that no brand image
 * carries a function that only makes sense above several brands (D-495).
 */

// --- order and money figures over a range ---------------------------------------------

/** One brand-day of `analytics.daily_org`, or any sum of them. */
export interface Figures {
  readonly ordersPlaced: number;
  readonly ordersConfirmed: number;
  readonly ordersDelivered: number;
  readonly ordersReturned: number;
  /** Cancelled after confirmation only (D-321). */
  readonly ordersCancelled: number;
  readonly deliveredRevenuePoisha: bigint;
  readonly grossProfitPoisha: bigint;
  readonly spendPoisha: bigint;
  readonly pickupCount: number;
  readonly pickupSeconds: bigint;
  readonly deliveredOutsideDhaka: number;
  readonly returnedOutsideDhaka: number;
}

export const ZERO_FIGURES: Figures = {
  ordersPlaced: 0,
  ordersConfirmed: 0,
  ordersDelivered: 0,
  ordersReturned: 0,
  ordersCancelled: 0,
  deliveredRevenuePoisha: 0n,
  grossProfitPoisha: 0n,
  spendPoisha: 0n,
  pickupCount: 0,
  pickupSeconds: 0n,
  deliveredOutsideDhaka: 0,
  returnedOutsideDhaka: 0,
};

export function addFigures(a: Figures, b: Figures): Figures {
  return {
    ordersPlaced: a.ordersPlaced + b.ordersPlaced,
    ordersConfirmed: a.ordersConfirmed + b.ordersConfirmed,
    ordersDelivered: a.ordersDelivered + b.ordersDelivered,
    ordersReturned: a.ordersReturned + b.ordersReturned,
    ordersCancelled: a.ordersCancelled + b.ordersCancelled,
    deliveredRevenuePoisha: a.deliveredRevenuePoisha + b.deliveredRevenuePoisha,
    grossProfitPoisha: a.grossProfitPoisha + b.grossProfitPoisha,
    spendPoisha: a.spendPoisha + b.spendPoisha,
    pickupCount: a.pickupCount + b.pickupCount,
    pickupSeconds: a.pickupSeconds + b.pickupSeconds,
    deliveredOutsideDhaka: a.deliveredOutsideDhaka + b.deliveredOutsideDhaka,
    returnedOutsideDhaka: a.returnedOutsideDhaka + b.returnedOutsideDhaka,
  };
}

export function sumFigures(rows: Iterable<Figures>): Figures {
  let total = ZERO_FIGURES;
  for (const row of rows) total = addFigures(total, row);
  return total;
}

/** The dashboard's ratios for a sum of days, by the brand dashboard's own rule (§18). */
export function figureKpis(figures: Figures): Kpis {
  return kpis({
    ordersConfirmed: figures.ordersConfirmed,
    ordersDelivered: figures.ordersDelivered,
    ordersReturned: figures.ordersReturned,
    ordersCancelled: figures.ordersCancelled,
    deliveredRevenuePoisha: figures.deliveredRevenuePoisha,
    spendPoisha: figures.spendPoisha,
    pickupCount: figures.pickupCount,
    pickupSeconds: Number(figures.pickupSeconds),
  });
}

/** The leaderboard's view of a month (D-322). */
export function brandMonthOf(figures: Figures): BrandMonth {
  return {
    ordersDelivered: figures.ordersDelivered,
    ordersReturned: figures.ordersReturned,
    ordersCancelled: figures.ordersCancelled,
    deliveredRevenuePoisha: figures.deliveredRevenuePoisha,
    spendPoisha: figures.spendPoisha,
    pickupCount: figures.pickupCount,
    pickupSeconds: Number(figures.pickupSeconds),
  };
}

// --- the snapshot: positions at the moment of a pull ------------------------------------

/** The wallet kinds §7 names, in the order a screen lists them. */
export const WALLET_KINDS = [
  'wallet_cash',
  'wallet_bank',
  'wallet_bkash',
  'wallet_mfs_other',
] as const;
export type WalletKind = (typeof WALLET_KINDS)[number];

/**
 * The ledger subtypes a snapshot reads, and what each becomes (D-485).
 *
 * Stock value is the ledger's Inventory account, which the brand keeps equal to its
 * inventory module's valuation (M07; `preview:seed` fails when they disagree), so the
 * mother needs no grant on the cost tables to show it.
 */
export const SNAPSHOT_SUBTYPES = [
  ...WALLET_KINDS,
  'inventory',
  'goods_in_transit',
  'courier_receivable',
  'supplier_payable',
  'other_receivable',
  'employee_loan_receivable',
] as const;

export interface SnapshotMoney {
  readonly cashPoisha: bigint;
  readonly cashByKind: Readonly<Record<WalletKind, bigint>>;
  readonly stockValuePoisha: bigint;
  readonly goodsInTransitPoisha: bigint;
  /** What the couriers hold of the brand's cash: `courier_receivable`. */
  readonly codHeldPoisha: bigint;
  readonly supplierPayablesPoisha: bigint;
  /** `other_receivable` and staff loans; COD is apart, above. */
  readonly receivablesPoisha: bigint;
}

export interface SnapshotFigures extends SnapshotMoney {
  /** Open orders by status: everything not yet delivered, returned, cancelled or exchanged. */
  readonly openOrders: Readonly<Record<string, number>>;
  readonly staffHeadcount: number;
  readonly activeSkus: number;
  readonly lowStockSkus: number;
}

/** One subtype's summed lines as of a date, as the brand's ledger answers it. */
export interface SubtypeBalanceRow {
  readonly subtype: string;
  readonly normalBalance: NormalBalance;
  readonly debitPoisha: bigint;
  readonly creditPoisha: bigint;
}

const ZERO_BY_KIND: Readonly<Record<WalletKind, bigint>> = {
  wallet_cash: 0n,
  wallet_bank: 0n,
  wallet_bkash: 0n,
  wallet_mfs_other: 0n,
};

/** Positions on each account's normal side, from summed lines (D-485). */
export function snapshotMoneyFrom(rows: readonly SubtypeBalanceRow[]): SnapshotMoney {
  const balance = new Map<string, bigint>();
  for (const row of rows) {
    const value = aggregateBalanceOf(row.normalBalance, row.debitPoisha, row.creditPoisha);
    balance.set(row.subtype, (balance.get(row.subtype) ?? 0n) + value);
  }
  const of = (subtype: string): bigint => balance.get(subtype) ?? 0n;
  const cashByKind: Record<WalletKind, bigint> = { ...ZERO_BY_KIND };
  for (const kind of WALLET_KINDS) cashByKind[kind] = of(kind);
  return {
    cashPoisha: WALLET_KINDS.reduce((total, kind) => total + cashByKind[kind], 0n),
    cashByKind,
    stockValuePoisha: of('inventory'),
    goodsInTransitPoisha: of('goods_in_transit'),
    codHeldPoisha: of('courier_receivable'),
    supplierPayablesPoisha: of('supplier_payable'),
    receivablesPoisha: of('other_receivable') + of('employee_loan_receivable'),
  };
}

export const EMPTY_SNAPSHOT: SnapshotFigures = {
  cashPoisha: 0n,
  cashByKind: ZERO_BY_KIND,
  stockValuePoisha: 0n,
  goodsInTransitPoisha: 0n,
  codHeldPoisha: 0n,
  supplierPayablesPoisha: 0n,
  receivablesPoisha: 0n,
  openOrders: {},
  staffHeadcount: 0,
  activeSkus: 0,
  lowStockSkus: 0,
};

/** Every brand's latest snapshot added together. */
export function sumSnapshots(snapshots: Iterable<SnapshotFigures>): SnapshotFigures {
  let cashPoisha = 0n;
  const cashByKind: Record<WalletKind, bigint> = { ...ZERO_BY_KIND };
  let stockValuePoisha = 0n;
  let goodsInTransitPoisha = 0n;
  let codHeldPoisha = 0n;
  let supplierPayablesPoisha = 0n;
  let receivablesPoisha = 0n;
  const openOrders: Record<string, number> = {};
  let staffHeadcount = 0;
  let activeSkus = 0;
  let lowStockSkus = 0;
  for (const snapshot of snapshots) {
    cashPoisha += snapshot.cashPoisha;
    for (const kind of WALLET_KINDS) cashByKind[kind] += snapshot.cashByKind[kind];
    stockValuePoisha += snapshot.stockValuePoisha;
    goodsInTransitPoisha += snapshot.goodsInTransitPoisha;
    codHeldPoisha += snapshot.codHeldPoisha;
    supplierPayablesPoisha += snapshot.supplierPayablesPoisha;
    receivablesPoisha += snapshot.receivablesPoisha;
    for (const [status, count] of Object.entries(snapshot.openOrders)) {
      openOrders[status] = (openOrders[status] ?? 0) + count;
    }
    staffHeadcount += snapshot.staffHeadcount;
    activeSkus += snapshot.activeSkus;
    lowStockSkus += snapshot.lowStockSkus;
  }
  return {
    cashPoisha,
    cashByKind,
    stockValuePoisha,
    goodsInTransitPoisha,
    codHeldPoisha,
    supplierPayablesPoisha,
    receivablesPoisha,
    openOrders,
    staffHeadcount,
    activeSkus,
    lowStockSkus,
  };
}

export function openOrdersTotal(openOrders: Readonly<Record<string, number>>): number {
  return Object.values(openOrders).reduce((total, count) => total + count, 0);
}

/** Order statuses that are closed for the "open orders" count (D-485). */
export const CLOSED_ORDER_STATUSES = [
  'delivered',
  'partially_delivered',
  'returned',
  'cancelled',
  'exchange',
] as const;

// --- profit and loss from daily ledger flows -------------------------------------------

/** One day's summed lines on one income or expense subtype. */
export interface LedgerFlowRow {
  readonly subtype: string;
  readonly accountClass: 'income' | 'expense';
  readonly debitPoisha: bigint;
  readonly creditPoisha: bigint;
}

export interface ProfitAndLoss {
  readonly incomePoisha: bigint;
  readonly expensePoisha: bigint;
  readonly netPoisha: bigint;
  /**
   * Per subtype, signed by its effect on the result: income as credit − debit (so sales
   * discounts, a debit-normal contra-revenue account, show negative) and expense as
   * debit − credit. The lines of each class add up to its total exactly.
   */
  readonly lines: readonly {
    readonly subtype: string;
    readonly accountClass: 'income' | 'expense';
    readonly amountPoisha: bigint;
  }[];
}

/**
 * Income, expense and net over the flows given, the way the brand's own consolidated P&L
 * computes them (M08): income credit − debit, expense debit − credit (D-493).
 */
export function profitAndLossFrom(rows: readonly LedgerFlowRow[]): ProfitAndLoss {
  const bySubtype = new Map<string, { accountClass: 'income' | 'expense'; amount: bigint }>();
  for (const row of rows) {
    const effect =
      row.accountClass === 'income'
        ? row.creditPoisha - row.debitPoisha
        : row.debitPoisha - row.creditPoisha;
    const key = `${row.accountClass}:${row.subtype}`;
    const existing = bySubtype.get(key);
    bySubtype.set(key, {
      accountClass: row.accountClass,
      amount: (existing?.amount ?? 0n) + effect,
    });
  }
  let incomePoisha = 0n;
  let expensePoisha = 0n;
  const lines = [...bySubtype.entries()]
    .map(([key, value]) => ({
      subtype: key.slice(key.indexOf(':') + 1),
      accountClass: value.accountClass,
      amountPoisha: value.amount,
    }))
    .sort((a, b) =>
      a.accountClass === b.accountClass
        ? a.subtype.localeCompare(b.subtype)
        : a.accountClass === 'income'
          ? -1
          : 1,
    );
  for (const line of lines) {
    if (line.accountClass === 'income') incomePoisha += line.amountPoisha;
    else expensePoisha += line.amountPoisha;
  }
  return { incomePoisha, expensePoisha, netPoisha: incomePoisha - expensePoisha, lines };
}

// --- ranges --------------------------------------------------------------------------

export interface DateRange {
  readonly from: IsoDate;
  readonly to: IsoDate;
}

export type RangePreset = 'today' | 'week' | 'month';

/**
 * Today, this week (from Sunday, D-459) and this month (from the 1st), in Asia/Dhaka
 * calendar dates (invariant 8), each up to and including `today`.
 */
export function presetRange(preset: RangePreset, today: IsoDate): DateRange {
  switch (preset) {
    case 'today':
      return { from: today, to: today };
    case 'week': {
      const weekday = new Date(`${today}T00:00:00Z`).getUTCDay();
      return { from: addDays(today, -weekday), to: today };
    }
    case 'month':
      return { from: periodForMonth(today.slice(0, 7)).startsOn, to: today };
  }
}

/** The same number of days, immediately before (for "against the period before"). */
export function previousRange(range: DateRange): DateRange {
  const length = daysBetween(range.from, range.to) + 1;
  return { from: addDays(range.from, -length), to: addDays(range.from, -1) };
}

/** Every date from `from` to `to`, inclusive. */
export function daysOf(range: DateRange): IsoDate[] {
  const days: IsoDate[] = [];
  for (let day = range.from; day <= range.to; day = addDays(day, 1)) days.push(day);
  return days;
}

// --- the leaderboard across brands ------------------------------------------------------

export interface BrandMonths {
  readonly brandId: string;
  readonly current: Figures;
  readonly previous: Figures;
}

/**
 * M24's board (D-322, D-323) over the mother's pulled rollups (D-492): each brand's month
 * against the month before, normalized, ranked, scored and weighted by the domain's own
 * functions. The owner sees every brand's raw figures too; there is no peer view here.
 */
export function rankBrands(
  months: readonly BrandMonths[],
  weights: LeaderboardWeights,
): RankedEntry[] {
  return rankBoard(
    months.map((month) => ({
      orgId: month.brandId,
      metrics: normalizedMetrics(brandMonthOf(month.current), brandMonthOf(month.previous)),
    })),
    weights,
  );
}
