import { addDays, businessDate, type IsoDate } from '../dates/index.js';
import type { OrderStatus } from '../orders/state.js';

/**
 * How long a packing video is kept (M38b, D-612).
 *
 * The owner's rule: "kept up to 7 days after delivery". A video is evidence for a complaint,
 * and a complaint comes after the parcel arrives (or comes back), so the clock starts when
 * the order reaches the state that ends its journey:
 *
 * - `delivered` or `partially_delivered`: the day it was delivered;
 * - `returned`, `cancelled`, `exchange`: the day it reached that state (a partly delivered
 *   order that later comes back starts again from the return).
 *
 * An order still on its way (`pending` to `shipped`, `return_in_transit`) keeps its video.
 *
 * Counted in Asia/Dhaka calendar days (invariant 8): the video is kept through the seventh
 * Dhaka day after the day of that state and may be deleted from the eighth. So it is never
 * deleted less than seven whole days after the state was reached, and a daily job deletes it
 * within a day of the eighth Dhaka day starting.
 */
export const PACKING_VIDEO_KEEP_DAYS = 7;

export const PACKING_VIDEO_RETENTION_REASONS = [
  'delivered',
  'partially_delivered',
  'returned',
  'cancelled',
  'exchange',
] as const;

export type PackingVideoRetentionReason = (typeof PACKING_VIDEO_RETENTION_REASONS)[number];

function isRetentionReason(status: string): status is PackingVideoRetentionReason {
  return (PACKING_VIDEO_RETENTION_REASONS as readonly string[]).includes(status);
}

export interface PackingVideoOrderFacts {
  readonly status: OrderStatus;
  /** When the order reached its current status; null when no record says. */
  readonly statusSince: Date | null;
}

export interface PackingVideoExpiry {
  readonly reason: PackingVideoRetentionReason;
  /** The last Asia/Dhaka date the video is kept. */
  readonly keepThrough: IsoDate;
  /** The first Asia/Dhaka date it may be deleted. */
  readonly deleteFrom: IsoDate;
}

/** When this order's packing video may go, or null while it must be kept. */
export function packingVideoExpiry(order: PackingVideoOrderFacts): PackingVideoExpiry | null {
  if (!isRetentionReason(order.status)) return null;
  // An ended order with no record of when it ended keeps its video: deleting evidence on a
  // guess is the one mistake that cannot be undone.
  if (order.statusSince === null || Number.isNaN(order.statusSince.getTime())) return null;
  const day = businessDate(order.statusSince);
  const keepThrough = addDays(day, PACKING_VIDEO_KEEP_DAYS);
  return { reason: order.status, keepThrough, deleteFrom: addDays(keepThrough, 1) };
}

/** Whether, at `now`, this order's packing video is past keeping. */
export function isPackingVideoExpired(order: PackingVideoOrderFacts, now: Date): boolean {
  const expiry = packingVideoExpiry(order);
  if (expiry === null) return false;
  return businessDate(now) >= expiry.deleteFrom;
}
