import type { IsoDate } from '../dates/index.js';
import type { Poisha } from '../money/index.js';

/**
 * The daily order rollups (architecture §18; M24, D-321).
 *
 * One pure function turns the orders that had something happen on a set of days into the
 * rows `analytics.daily_org`, `daily_branch` and `daily_channel` hold. Every count is an
 * **event on its own day**, by Asia/Dhaka date (invariant 8), the way §11's metrics are
 * counted (D-255): an order is placed on the day it was created, confirmed on the day of
 * its confirmation, delivered on the day of its delivery (a partial delivery is a
 * delivery, with its delivered part as revenue), returned on the day it came back, and
 * cancelled on the day it was cancelled — counted only when it had been confirmed first,
 * because an unconfirmed order cancelled is a lead that did not convert, not a delivery
 * that failed.
 *
 * So one order can be confirmed on the 30th and delivered on the 2nd, and it appears on
 * each day for what happened on it. Summing days therefore gives the period's figure for
 * any period, which is what makes a rollup worth having.
 */

export interface OrderDayFact {
  readonly orderId: string;
  readonly channel: string;
  /** Null for an order no branch took (the online desk). */
  readonly branchId: string | null;
  readonly createdOn: IsoDate;
  readonly confirmedOn: IsoDate | null;
  /** Delivered or partially delivered. */
  readonly deliveredOn: IsoDate | null;
  readonly returnedOn: IsoDate | null;
  /** Set only for an order cancelled after it had been confirmed (D-321). */
  readonly cancelledOn: IsoDate | null;
  /** Shipped to a district other than Dhaka (D-321). */
  readonly outsideDhaka: boolean;
  /** Delivered net item value: after discounts, without the delivery charge (D-255). */
  readonly deliveredRevenuePoisha: Poisha;
  /**
   * What the delivered units cost when they left stock. Purchase cost (invariant 5): it is
   * used here only to derive gross profit and is never stored or returned.
   */
  readonly deliveredCostPoisha: Poisha;
}

/** One rollup row's order figures. Money is integer poisha (invariant 1). */
export interface OrderMetrics {
  readonly ordersPlaced: number;
  readonly ordersConfirmed: number;
  readonly ordersDelivered: number;
  readonly ordersReturned: number;
  readonly ordersCancelled: number;
  readonly deliveredRevenuePoisha: bigint;
  /** Delivered revenue less the cost of the delivered units. Cost roles only. */
  readonly grossProfitPoisha: bigint;
  readonly deliveredOutsideDhaka: number;
  readonly returnedOutsideDhaka: number;
}

export const EMPTY_ORDER_METRICS: OrderMetrics = {
  ordersPlaced: 0,
  ordersConfirmed: 0,
  ordersDelivered: 0,
  ordersReturned: 0,
  ordersCancelled: 0,
  deliveredRevenuePoisha: 0n,
  grossProfitPoisha: 0n,
  deliveredOutsideDhaka: 0,
  returnedOutsideDhaka: 0,
};

export function addOrderMetrics(a: OrderMetrics, b: OrderMetrics): OrderMetrics {
  return {
    ordersPlaced: a.ordersPlaced + b.ordersPlaced,
    ordersConfirmed: a.ordersConfirmed + b.ordersConfirmed,
    ordersDelivered: a.ordersDelivered + b.ordersDelivered,
    ordersReturned: a.ordersReturned + b.ordersReturned,
    ordersCancelled: a.ordersCancelled + b.ordersCancelled,
    deliveredRevenuePoisha: a.deliveredRevenuePoisha + b.deliveredRevenuePoisha,
    grossProfitPoisha: a.grossProfitPoisha + b.grossProfitPoisha,
    deliveredOutsideDhaka: a.deliveredOutsideDhaka + b.deliveredOutsideDhaka,
    returnedOutsideDhaka: a.returnedOutsideDhaka + b.returnedOutsideDhaka,
  };
}

export function sumOrderMetrics(rows: Iterable<OrderMetrics>): OrderMetrics {
  let total = EMPTY_ORDER_METRICS;
  for (const row of rows) total = addOrderMetrics(total, row);
  return total;
}

/** What one order contributes to one day, or null when nothing happened to it that day. */
export function contributionOn(fact: OrderDayFact, day: IsoDate): OrderMetrics | null {
  const placed = fact.createdOn === day;
  const confirmed = fact.confirmedOn === day;
  const delivered = fact.deliveredOn === day;
  const returned = fact.returnedOn === day;
  const cancelled = fact.cancelledOn === day;
  if (!placed && !confirmed && !delivered && !returned && !cancelled) return null;

  const revenue = delivered ? BigInt(fact.deliveredRevenuePoisha) : 0n;
  const cost = delivered ? BigInt(fact.deliveredCostPoisha) : 0n;
  return {
    ordersPlaced: placed ? 1 : 0,
    ordersConfirmed: confirmed ? 1 : 0,
    ordersDelivered: delivered ? 1 : 0,
    ordersReturned: returned ? 1 : 0,
    ordersCancelled: cancelled ? 1 : 0,
    deliveredRevenuePoisha: revenue,
    grossProfitPoisha: revenue - cost,
    deliveredOutsideDhaka: delivered && fact.outsideDhaka ? 1 : 0,
    returnedOutsideDhaka: returned && fact.outsideDhaka ? 1 : 0,
  };
}

export interface DayRollup {
  readonly date: IsoDate;
  /** Always present, zeros included: "nothing happened" is a computed answer. */
  readonly org: OrderMetrics;
  /** Only orders a branch took; a key only where something happened. */
  readonly byBranch: ReadonlyMap<string, OrderMetrics>;
  readonly byChannel: ReadonlyMap<string, OrderMetrics>;
}

function accumulate(map: Map<string, OrderMetrics>, key: string, add: OrderMetrics): void {
  map.set(key, addOrderMetrics(map.get(key) ?? EMPTY_ORDER_METRICS, add));
}

/** The org, branch and channel rows for each of `days`, from the orders that touched them. */
export function rollupOrders(
  facts: readonly OrderDayFact[],
  days: readonly IsoDate[],
): DayRollup[] {
  return days.map((date) => {
    let org = EMPTY_ORDER_METRICS;
    const byBranch = new Map<string, OrderMetrics>();
    const byChannel = new Map<string, OrderMetrics>();
    for (const fact of facts) {
      const add = contributionOn(fact, date);
      if (add === null) continue;
      org = addOrderMetrics(org, add);
      accumulate(byChannel, fact.channel, add);
      if (fact.branchId !== null) accumulate(byBranch, fact.branchId, add);
    }
    return { date, org, byBranch, byChannel };
  });
}
