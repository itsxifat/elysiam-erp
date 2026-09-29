import { type IsoDate } from '../dates/index.js';
import { type ParcelStatus } from './status.js';

/**
 * Courier performance: delivery rate, average days and return rate, by zone (M15).
 *
 * The report a brand chooses couriers with, and the one the selection rules are argued
 * from. Pure, because three of its four numbers are ratios and the fourth is a mean, and a
 * ratio computed in a SQL `avg()` or in the browser is a float — which is how a delivery
 * rate ends up displayed as 87.49999999%.
 *
 * ## What counts
 *
 * The population is every parcel **booked** in the window (by its Asia/Dhaka booking date,
 * invariant 8). Of those:
 *
 * - **delivered** is `delivered` plus `partial_delivered` — the rider handed something over
 *   and collected for it. Partial deliveries are also counted on their own, because a
 *   courier with a high partial rate is a courier whose riders let customers pick and choose
 *   at the door, and that costs a return fee per parcel.
 * - **returned** is `return_in_transit` plus `returned_to_merchant` — the parcel failed,
 *   whether or not it is home yet.
 * - **resolved** is delivered plus returned, and it is the denominator of both rates.
 *   Parcels still moving are *not* in it: counting them as failures would punish whichever
 *   courier had the most parcels out on the day the report ran, and counting them as
 *   successes would reward it.
 * - **cancelled** parcels (cancelled before pickup) are reported and are in neither rate:
 *   the courier never had the chance to deliver them.
 *
 * Rates are **basis points**, integers, rounded half-up once. Average days is the mean of
 * whole calendar days from booking to delivery, as a one-decimal string computed in integer
 * arithmetic.
 */

export interface PerformanceParcel {
  readonly courierId: string;
  /** Null for a parcel booked before M15 recorded the zone. Reported as its own row. */
  readonly deliveryZoneId: string | null;
  readonly status: ParcelStatus;
  readonly bookedOn: IsoDate;
  /** The Asia/Dhaka date the courier reported delivery, when it did. */
  readonly deliveredOn: IsoDate | null;
}

export interface PerformanceRow {
  readonly courierId: string;
  readonly deliveryZoneId: string | null;
  readonly booked: number;
  readonly delivered: number;
  readonly partial: number;
  readonly returned: number;
  readonly cancelled: number;
  readonly inFlight: number;
  readonly resolved: number;
  /** delivered ÷ resolved, in basis points. Null when nothing has resolved yet. */
  readonly deliveryRateBps: number | null;
  /** returned ÷ resolved, in basis points. Null when nothing has resolved yet. */
  readonly returnRateBps: number | null;
  /** Mean booking-to-delivery days, one decimal, e.g. `"2.4"`. Null with no dated delivery. */
  readonly averageDeliveryDays: string | null;
}

export interface PerformanceReport {
  /** One row per (courier, zone) that booked anything in the window. */
  readonly rows: readonly PerformanceRow[];
  /** One row per courier across every zone — the headline the rows break down. */
  readonly couriers: readonly PerformanceRow[];
}

interface Tally {
  booked: number;
  delivered: number;
  partial: number;
  returned: number;
  cancelled: number;
  inFlight: number;
  deliveryDaysTotal: number;
  deliveriesWithDates: number;
}

function emptyTally(): Tally {
  return {
    booked: 0,
    delivered: 0,
    partial: 0,
    returned: 0,
    cancelled: 0,
    inFlight: 0,
    deliveryDaysTotal: 0,
    deliveriesWithDates: 0,
  };
}

function calendarDays(from: IsoDate, to: IsoDate): number {
  return Math.floor(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000,
  );
}

function count(tally: Tally, parcel: PerformanceParcel): void {
  tally.booked += 1;
  switch (parcel.status) {
    case 'delivered':
    case 'partial_delivered':
      tally.delivered += 1;
      if (parcel.status === 'partial_delivered') tally.partial += 1;
      if (parcel.deliveredOn !== null) {
        // A delivery dated before its booking is a clock or data fault; it counts as the
        // same day rather than dragging the mean below zero.
        tally.deliveryDaysTotal += Math.max(0, calendarDays(parcel.bookedOn, parcel.deliveredOn));
        tally.deliveriesWithDates += 1;
      }
      return;
    case 'return_in_transit':
    case 'returned_to_merchant':
      tally.returned += 1;
      return;
    case 'cancelled':
      tally.cancelled += 1;
      return;
    case 'booked':
    case 'pickup_pending':
    case 'picked_up':
    case 'in_transit':
    case 'out_for_delivery':
    case 'hold':
    case 'unknown':
      tally.inFlight += 1;
      return;
  }
}

/** `numerator ÷ denominator × 10 000`, rounded half-up. Both non-negative integers. */
export function basisPoints(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  const scaled = BigInt(numerator) * 10_000n;
  const d = BigInt(denominator);
  return Number((scaled * 2n + d) / (2n * d));
}

/** A mean as a one-decimal string, rounded half-up, in integer arithmetic. */
export function oneDecimalMean(total: number, n: number): string | null {
  if (n <= 0) return null;
  const tenths = (BigInt(total) * 10n * 2n + BigInt(n)) / (2n * BigInt(n));
  return `${(tenths / 10n).toString()}.${(tenths % 10n).toString()}`;
}

function rowOf(courierId: string, deliveryZoneId: string | null, tally: Tally): PerformanceRow {
  const resolved = tally.delivered + tally.returned;
  return {
    courierId,
    deliveryZoneId,
    booked: tally.booked,
    delivered: tally.delivered,
    partial: tally.partial,
    returned: tally.returned,
    cancelled: tally.cancelled,
    inFlight: tally.inFlight,
    resolved,
    deliveryRateBps: basisPoints(tally.delivered, resolved),
    returnRateBps: basisPoints(tally.returned, resolved),
    averageDeliveryDays: oneDecimalMean(tally.deliveryDaysTotal, tally.deliveriesWithDates),
  };
}

export function summarisePerformance(parcels: readonly PerformanceParcel[]): PerformanceReport {
  const byZone = new Map<string, { courierId: string; zoneId: string | null; tally: Tally }>();
  const byCourier = new Map<string, Tally>();

  for (const parcel of parcels) {
    const key = `${parcel.courierId}|${parcel.deliveryZoneId ?? ''}`;
    const zone = byZone.get(key) ?? {
      courierId: parcel.courierId,
      zoneId: parcel.deliveryZoneId,
      tally: emptyTally(),
    };
    count(zone.tally, parcel);
    byZone.set(key, zone);

    const courier = byCourier.get(parcel.courierId) ?? emptyTally();
    count(courier, parcel);
    byCourier.set(parcel.courierId, courier);
  }

  // Sorted by ids so the same data always produces the same report, row for row.
  const rows = [...byZone.values()]
    .sort((a, b) =>
      a.courierId === b.courierId
        ? (a.zoneId ?? '').localeCompare(b.zoneId ?? '')
        : a.courierId.localeCompare(b.courierId),
    )
    .map((entry) => rowOf(entry.courierId, entry.zoneId, entry.tally));

  const couriers = [...byCourier.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([courierId, tally]) => rowOf(courierId, null, tally));

  return { rows, couriers };
}
