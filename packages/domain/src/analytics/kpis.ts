import { BASIS_POINTS, divideRounded } from '../money/index.js';

/**
 * The dashboard's ratios, from summed rollup figures (architecture §18; M24, D-321).
 *
 * Every ratio is computed once, here, from the period's sums — never averaged from daily
 * ratios, which would weight a quiet Friday the same as Eid. Money ratios are poisha and
 * rates are basis points (10,000 = 100%, or 1× for ROAS), rounded half away from zero by
 * the money module's one rule. A ratio whose denominator is zero is `null`: "no deliveries
 * yet" is not "a 0% return rate".
 */

export interface KpiInputs {
  readonly ordersConfirmed: number;
  readonly ordersDelivered: number;
  readonly ordersReturned: number;
  readonly ordersCancelled: number;
  readonly deliveredRevenuePoisha: bigint;
  readonly spendPoisha: bigint;
  readonly pickupCount: number;
  readonly pickupSeconds: number;
}

export interface Kpis {
  /** Average delivered order value: delivered revenue ÷ delivered orders. */
  readonly aovPoisha: bigint | null;
  /** returned ÷ (delivered + returned), §11's definition. */
  readonly returnRateBps: bigint | null;
  /** delivered ÷ (delivered + returned + cancelled after confirmation). */
  readonly deliverySuccessBps: bigint | null;
  /** spend ÷ confirmed orders. */
  readonly cpoPoisha: bigint | null;
  /** spend ÷ delivered orders. */
  readonly cpdoPoisha: bigint | null;
  /** delivered revenue ÷ spend: §11's primary, delivered ROAS. */
  readonly roasBps: bigint | null;
  /** Mean desk pickup in whole seconds (D-322). */
  readonly pickupMeanSeconds: number | null;
}

export function ratio(numerator: bigint, denominator: bigint): bigint | null {
  return denominator === 0n ? null : divideRounded(numerator, denominator);
}

export function returnRateBps(delivered: number, returned: number): bigint | null {
  return ratio(BigInt(returned) * BASIS_POINTS, BigInt(delivered + returned));
}

export function deliverySuccessBps(
  delivered: number,
  returned: number,
  cancelled: number,
): bigint | null {
  return ratio(BigInt(delivered) * BASIS_POINTS, BigInt(delivered + returned + cancelled));
}

export function pickupMeanSeconds(count: number, seconds: number): number | null {
  const mean = ratio(BigInt(seconds), BigInt(count));
  return mean === null ? null : Number(mean);
}

export function kpis(inputs: KpiInputs): Kpis {
  const spend = inputs.spendPoisha;
  return {
    aovPoisha: ratio(inputs.deliveredRevenuePoisha, BigInt(inputs.ordersDelivered)),
    returnRateBps: returnRateBps(inputs.ordersDelivered, inputs.ordersReturned),
    deliverySuccessBps: deliverySuccessBps(
      inputs.ordersDelivered,
      inputs.ordersReturned,
      inputs.ordersCancelled,
    ),
    cpoPoisha: ratio(spend, BigInt(inputs.ordersConfirmed)),
    cpdoPoisha: ratio(spend, BigInt(inputs.ordersDelivered)),
    roasBps: ratio(inputs.deliveredRevenuePoisha * BASIS_POINTS, spend),
    pickupMeanSeconds: pickupMeanSeconds(inputs.pickupCount, inputs.pickupSeconds),
  };
}

/** The middle value of the non-null ones; the mean of the middle two, rounded, when even. */
export function median(values: readonly (bigint | null)[]): bigint | null {
  const present = values
    .filter((value): value is bigint => value !== null)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (present.length === 0) return null;
  const middle = Math.floor(present.length / 2);
  const upper = present[middle] ?? 0n;
  if (present.length % 2 === 1) return upper;
  const lower = present[middle - 1] ?? 0n;
  return divideRounded(lower + upper, 2n);
}
