import { addDays, daysBetween, type IsoDate } from '../dates/index.js';
import { BASIS_POINTS, divideRounded, poisha, ZERO, type Poisha } from '../money/index.js';

/**
 * §11's marketing metrics, exactly as defined (architecture §11 "Metric definitions"; M18).
 *
 * - `spend` = Σ ad spend in the period
 * - `confirmed_orders` = orders that reached confirmed
 * - `delivered_orders`, and `delivered_revenue` = Σ delivered net item value (excluding
 *   delivery charges)
 * - `CPO` = spend / confirmed_orders
 * - `CPDO` = spend / delivered_orders
 * - `ROAS` = delivered_revenue / spend, the primary ROAS; placed-order ROAS second,
 *   labelled optimistic
 * - `return_rate` = returned / (delivered + returned)
 *
 * What "in the period" means for each, and the units, are D-255:
 *
 * - an order counts as confirmed in the period its **confirmation** happened in, as
 *   delivered in the period its **delivery** happened in (a partial delivery is a delivery,
 *   with its delivered part as revenue), and as returned in the period it **came back** in.
 *   One order can therefore be confirmed in September and delivered in October, and it
 *   appears in each month for what happened in it. Every date is an Asia/Dhaka calendar
 *   date (invariant 8);
 * - placed-order revenue is the net item value of the orders confirmed in the period, as
 *   placed — optimistic because some of them will come back;
 * - CPO and CPDO are poisha, rounded half away from zero by the money module's one rule;
 *   ROAS and return rate are basis points (10,000 = 1×, or 100%), rounded the same way;
 * - a ratio whose denominator is zero is `null`, never zero and never infinity: "no orders
 *   yet" is not "free orders".
 */

export interface MetricPeriod {
  /** Both inclusive, Asia/Dhaka calendar dates. */
  readonly from: IsoDate;
  readonly to: IsoDate;
}

/** One order, as the dashboard needs it: the dates things happened and two revenues. */
export interface OrderFact {
  readonly orderId: string;
  /** From `resolveAttribution`; null is the unattributed bucket. */
  readonly campaignId: string | null;
  readonly confirmedOn: IsoDate | null;
  /** The delivery or partial delivery's date. */
  readonly deliveredOn: IsoDate | null;
  readonly returnedOn: IsoDate | null;
  /** Delivered net item value: after line and order discounts, without delivery charge. */
  readonly deliveredRevenuePoisha: Poisha;
  /** Net item value as placed (items less discounts), for the optimistic ROAS. */
  readonly placedRevenuePoisha: Poisha;
}

export interface SpendFact {
  readonly campaignId: string;
  readonly spendOn: IsoDate;
  readonly amountPoisha: Poisha;
}

/** The six inputs of §11's ratios. */
export interface MetricInputs {
  readonly spendPoisha: Poisha;
  readonly confirmedOrders: number;
  readonly deliveredOrders: number;
  readonly deliveredRevenuePoisha: Poisha;
  readonly placedRevenuePoisha: Poisha;
  readonly returnedOrders: number;
}

export interface CampaignMetrics extends MetricInputs {
  readonly cpoPoisha: Poisha | null;
  readonly cpdoPoisha: Poisha | null;
  /** Delivered ROAS, the primary one, in basis points. */
  readonly roasBps: bigint | null;
  /** Placed-order ROAS, optimistic, in basis points. */
  readonly placedRoasBps: bigint | null;
  /** returned / (delivered + returned), in basis points. */
  readonly returnRateBps: bigint | null;
}

export const EMPTY_INPUTS: MetricInputs = {
  spendPoisha: ZERO,
  confirmedOrders: 0,
  deliveredOrders: 0,
  deliveredRevenuePoisha: ZERO,
  placedRevenuePoisha: ZERO,
  returnedOrders: 0,
};

function ratio(numerator: bigint, denominator: bigint): bigint | null {
  return denominator === 0n ? null : divideRounded(numerator, denominator);
}

export function campaignMetrics(inputs: MetricInputs): CampaignMetrics {
  const spend = BigInt(inputs.spendPoisha);
  const cpo = ratio(spend, BigInt(inputs.confirmedOrders));
  const cpdo = ratio(spend, BigInt(inputs.deliveredOrders));
  return {
    ...inputs,
    cpoPoisha: cpo === null ? null : poisha(cpo),
    cpdoPoisha: cpdo === null ? null : poisha(cpdo),
    roasBps: ratio(BigInt(inputs.deliveredRevenuePoisha) * BASIS_POINTS, spend),
    placedRoasBps: ratio(BigInt(inputs.placedRevenuePoisha) * BASIS_POINTS, spend),
    returnRateBps: ratio(
      BigInt(inputs.returnedOrders) * BASIS_POINTS,
      BigInt(inputs.deliveredOrders + inputs.returnedOrders),
    ),
  };
}

export function inPeriod(date: IsoDate | null, period: MetricPeriod): boolean {
  return date !== null && date >= period.from && date <= period.to;
}

function plus(a: MetricInputs, b: Partial<MetricInputs>): MetricInputs {
  return {
    spendPoisha: poisha(BigInt(a.spendPoisha) + BigInt(b.spendPoisha ?? ZERO)),
    confirmedOrders: a.confirmedOrders + (b.confirmedOrders ?? 0),
    deliveredOrders: a.deliveredOrders + (b.deliveredOrders ?? 0),
    deliveredRevenuePoisha: poisha(
      BigInt(a.deliveredRevenuePoisha) + BigInt(b.deliveredRevenuePoisha ?? ZERO),
    ),
    placedRevenuePoisha: poisha(
      BigInt(a.placedRevenuePoisha) + BigInt(b.placedRevenuePoisha ?? ZERO),
    ),
    returnedOrders: a.returnedOrders + (b.returnedOrders ?? 0),
  };
}

/** What one order contributes to a period, by §11's definitions. */
function contribution(order: OrderFact, period: MetricPeriod): Partial<MetricInputs> {
  const confirmed = inPeriod(order.confirmedOn, period);
  const delivered = inPeriod(order.deliveredOn, period);
  return {
    confirmedOrders: confirmed ? 1 : 0,
    placedRevenuePoisha: confirmed ? order.placedRevenuePoisha : ZERO,
    deliveredOrders: delivered ? 1 : 0,
    deliveredRevenuePoisha: delivered ? order.deliveredRevenuePoisha : ZERO,
    returnedOrders: inPeriod(order.returnedOn, period) ? 1 : 0,
  };
}

export interface AggregatedMetrics {
  /** Keyed by campaign id; `null` is the orders no campaign claims (they carry no spend). */
  readonly byCampaign: ReadonlyMap<string | null, MetricInputs>;
  /** Every order and every taka of spend in the period: the blended figure. */
  readonly total: MetricInputs;
}

export function aggregateFacts(
  orders: readonly OrderFact[],
  spend: readonly SpendFact[],
  period: MetricPeriod,
): AggregatedMetrics {
  const byCampaign = new Map<string | null, MetricInputs>();
  let total = EMPTY_INPUTS;
  for (const row of spend) {
    if (!inPeriod(row.spendOn, period)) continue;
    const add = { spendPoisha: row.amountPoisha };
    byCampaign.set(row.campaignId, plus(byCampaign.get(row.campaignId) ?? EMPTY_INPUTS, add));
    total = plus(total, add);
  }
  for (const order of orders) {
    const add = contribution(order, period);
    const key = order.campaignId;
    byCampaign.set(key, plus(byCampaign.get(key) ?? EMPTY_INPUTS, add));
    total = plus(total, add);
  }
  return { byCampaign, total };
}

export interface DailyPoint {
  readonly date: IsoDate;
  readonly spendPoisha: Poisha;
  readonly deliveredRevenuePoisha: Poisha;
}

/** The most days a series is drawn for; a longer range is refused by the caller's schema. */
export const MAX_SERIES_DAYS = 92;

/** Spend and delivered revenue per day of the period, for the dashboard's chart. */
export function dailySeries(
  orders: readonly OrderFact[],
  spend: readonly SpendFact[],
  period: MetricPeriod,
): DailyPoint[] {
  const days = daysBetween(period.from, period.to) + 1;
  if (days < 1 || days > MAX_SERIES_DAYS) return [];
  const spendBy = new Map<string, bigint>();
  const revenueBy = new Map<string, bigint>();
  for (const row of spend) {
    if (!inPeriod(row.spendOn, period)) continue;
    spendBy.set(row.spendOn, (spendBy.get(row.spendOn) ?? 0n) + BigInt(row.amountPoisha));
  }
  for (const order of orders) {
    if (order.deliveredOn === null || !inPeriod(order.deliveredOn, period)) continue;
    revenueBy.set(
      order.deliveredOn,
      (revenueBy.get(order.deliveredOn) ?? 0n) + BigInt(order.deliveredRevenuePoisha),
    );
  }
  const points: DailyPoint[] = [];
  for (let offset = 0; offset < days; offset += 1) {
    const date = addDays(period.from, offset);
    points.push({
      date,
      spendPoisha: poisha(spendBy.get(date) ?? 0n),
      deliveredRevenuePoisha: poisha(revenueBy.get(date) ?? 0n),
    });
  }
  return points;
}
