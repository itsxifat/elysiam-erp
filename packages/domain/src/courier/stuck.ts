import { businessDate, type IsoDate } from '../dates/index.js';
import { isTerminalParcelStatus, type ParcelStatus } from './status.js';

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

function daysBetween(from: IsoDate, to: IsoDate): number {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  return Math.floor((end - start) / 86_400_000);
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
