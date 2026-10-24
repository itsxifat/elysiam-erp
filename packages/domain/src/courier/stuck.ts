import { businessDate, daysBetween, type IsoDate } from '../dates/index.js';
import {
  isTerminalParcelStatus,
  LEFT_THE_MERCHANT,
  normalizeStatus,
  type ParcelStatus,
  type ProviderStatusMap,
} from './status.js';

/**
 * The stuck-parcel queue (M15: "active consignments with no status change in N days").
 *
 * M15's own sentence for why this exists is the right one: this is where COD cash goes
 * missing. A parcel the courier has stopped talking about is, more often than not, a
 * parcel a rider delivered and did not report — the cash is in somebody's pocket, our
 * books still say `shipped`, and no settlement will ever list it because the courier's
 * system does not know it was delivered either. Nothing else in the system surfaces it:
 * the COD reconciliation report only sees parcels that *reached* delivered.
 *
 * ## "No status change", not "no event"
 *
 * The clock is the last time the parcel's **status changed**, not the last time the courier
 * said anything. A poller asking Steadfast every six hours gets `in_transit` back every six
 * hours with no timestamp of its own, and M12's `last_status_at` moved on each answer — so
 * measured against it, a parcel that had been "in transit" for three weeks looked like one
 * the courier spoke about this morning, and the queue built on it would have been empty in
 * exactly the case it exists for. `status_changed_at` moves only when the status does.
 *
 * Days are counted in Asia/Dhaka calendar days (invariant 8), so "stuck for 3 days" means
 * the same thing to the person reading the queue at 9am as to the one reading it at 11pm.
 */

/** Whether a consignment is still with the courier and still expected to move. */
export function isActiveConsignment(input: {
  readonly bookingState: string;
  readonly status: ParcelStatus;
}): boolean {
  return input.bookingState === 'booked' && !isTerminalParcelStatus(input.status);
}

/** Whole Asia/Dhaka calendar days from `since` to `now`. Never negative. */
export function calendarDaysSince(since: Date, now: Date): number {
  const from = businessDate(since);
  const to = businessDate(now);
  return Math.max(0, daysBetween(from, to));
}

export interface StuckCandidate {
  readonly bookingState: string;
  readonly status: ParcelStatus;
  /** When the status last changed. Null for a row M12 wrote before the column existed. */
  readonly statusChangedAt: Date | null;
  /** M12's column, the fallback for such a row. */
  readonly lastStatusAt: Date | null;
  readonly bookedAt: Date | null;
}

/** The instant the stuck clock starts from. */
export function stuckSince(candidate: StuckCandidate): Date | null {
  return candidate.statusChangedAt ?? candidate.lastStatusAt ?? candidate.bookedAt;
}

/** The smallest and largest threshold the queue accepts, in days. */
export const STUCK_THRESHOLD_DAYS = { min: 1, max: 60, default: 3 } as const;

/**
 * Whether a consignment belongs in the stuck-parcel queue.
 *
 * `thresholdDays` calendar days or more since the status last changed. "3 days" means a
 * parcel whose status last changed on Monday is stuck from Thursday, whatever the hour —
 * the same answer the SQL gives, which compares Asia/Dhaka dates for the same reason.
 */
export function isStuck(candidate: StuckCandidate, now: Date, thresholdDays: number): boolean {
  if (!isActiveConsignment(candidate)) return false;
  const since = stuckSince(candidate);
  if (since === null) return false;
  return calendarDaysSince(since, now) >= thresholdDays;
}

/**
 * The cut-off the SQL filters on: a status last changed on or before this Asia/Dhaka date
 * is stuck.
 */
export function stuckCutoffDate(now: Date, thresholdDays: number): IsoDate {
  const today = businessDate(now);
  const cutoff = new Date(Date.parse(`${today}T00:00:00Z`) - thresholdDays * 86_400_000);
  return cutoff.toISOString().slice(0, 10) as IsoDate;
}

export function assertStuckThreshold(days: number): void {
  if (
    !Number.isSafeInteger(days) ||
    days < STUCK_THRESHOLD_DAYS.min ||
    days > STUCK_THRESHOLD_DAYS.max
  ) {
    throw new RangeError(
      `A stuck-parcel threshold is ${String(STUCK_THRESHOLD_DAYS.min)} to ${String(STUCK_THRESHOLD_DAYS.max)} days.`,
    );
  }
}

/**
 * The hours a parcel may wait for its courier's first word of having it (D-903): handed over and
 * shipped by us, and still no status that proves the courier took it. Steadfast's `in_review`
 * changes to `pending` once its hub has the parcel; a parcel still `in_review` hours after the
 * rider left with it is one the courier never received. The rider's trip to the hub takes about
 * five hours, so the default is five.
 */
export const NOT_RECEIVED_HOURS = { min: 1, max: 72, default: 5 } as const;

/** The statuses that say nothing about the courier having the parcel. */
export const NOT_YET_WITH_COURIER: readonly ParcelStatus[] = ['booked', 'pickup_pending', 'hold'];

/**
 * Whether the courier has ever said it has the parcel (D-903): its status now, or any word it
 * gave, read through the account's vocabulary as it stands today. Read again rather than taken
 * from the stored status, because a word's meaning can be corrected after it was stored (D-902:
 * Steadfast's `pending`, stored as `pickup_pending` before), and the events cannot be rewritten.
 * A parcel the courier took and later put on hold (a failed delivery, a cancellation waiting for
 * approval) was received: it is not missing.
 */
export function courierHadParcel(input: {
  readonly status: ParcelStatus;
  readonly map: ProviderStatusMap | undefined;
  readonly events: readonly { readonly status: string; readonly rawStatus: string | null }[];
}): boolean {
  if (LEFT_THE_MERCHANT.includes(input.status)) return true;
  return input.events.some((event) => {
    if (LEFT_THE_MERCHANT.includes(event.status as ParcelStatus)) return true;
    if (input.map === undefined || event.rawStatus === null) return false;
    return LEFT_THE_MERCHANT.includes(normalizeStatus(input.map, event.rawStatus).status);
  });
}

/**
 * Whether a parcel we handed over has not reached its courier (D-903): booked, its handover
 * `hours` or more ago, its status one that proves nothing (`NOT_YET_WITH_COURIER`), and nothing
 * the courier ever said shows it had the parcel (`courierHadParcel`). A parcel never handed
 * over is not missing; it is still at the hub.
 */
export function notReceivedByCourier(input: {
  readonly bookingState: string;
  readonly status: ParcelStatus;
  readonly handedOverAt: Date | null;
  readonly courierHadIt: boolean;
  readonly now: Date;
  readonly hours: number;
}): boolean {
  if (input.bookingState !== 'booked' || input.handedOverAt === null) return false;
  if (input.courierHadIt || !NOT_YET_WITH_COURIER.includes(input.status)) return false;
  return input.now.getTime() - input.handedOverAt.getTime() >= input.hours * 3_600_000;
}

export function assertNotReceivedHours(hours: number): void {
  if (
    !Number.isSafeInteger(hours) ||
    hours < NOT_RECEIVED_HOURS.min ||
    hours > NOT_RECEIVED_HOURS.max
  ) {
    throw new RangeError(
      `The courier's time to receive a parcel is ${String(NOT_RECEIVED_HOURS.min)} to ${String(NOT_RECEIVED_HOURS.max)} hours.`,
    );
  }
}
