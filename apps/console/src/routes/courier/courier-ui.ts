/**
 * The courier screens' pure helpers (M15).
 *
 * Their own module, so a unit test can import them without pulling in `../../api.js`, which
 * reads the app's environment at import time and throws in a test process that has none.
 */

import type {
  BookingState,
  ParcelStatus,
  SettlementMatch,
  SettlementStatus,
  StuckReason,
} from './api.js';

export type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

/**
 * A parcel's colour.
 *
 * Only a finished delivery is green, and `unknown` is the warning colour rather than grey: an
 * unrecognised courier word is how a delivered parcel goes unbooked, and grey reads as "fine,
 * nothing to see".
 */
export const PARCEL_TONE: Readonly<Record<ParcelStatus, Tone>> = {
  booked: 'neutral',
  pickup_pending: 'neutral',
  picked_up: 'info',
  in_transit: 'info',
  out_for_delivery: 'info',
  hold: 'warning',
  delivered: 'success',
  partial_delivered: 'success',
  return_in_transit: 'warning',
  returned_to_merchant: 'neutral',
  cancelled: 'neutral',
  unknown: 'warning',
};

export const BOOKING_TONE: Readonly<Record<BookingState, Tone>> = {
  pending: 'neutral',
  booked: 'info',
  failed: 'danger',
  cancelled: 'neutral',
};

export const REASON_TONE: Readonly<Record<StuckReason, Tone>> = {
  no_status_change: 'warning',
  unknown_status: 'warning',
  booking_failed: 'danger',
  unposted_delivery: 'danger',
  return_not_received: 'warning',
};

export const SETTLEMENT_TONE: Readonly<Record<SettlementStatus, Tone>> = {
  imported: 'neutral',
  pending_approval: 'warning',
  posted: 'success',
  rejected: 'neutral',
};

export const MATCH_TONE: Readonly<Record<SettlementMatch, Tone>> = {
  matched: 'success',
  unmatched: 'danger',
  amount_mismatch: 'danger',
  duplicate: 'warning',
  already_settled: 'warning',
};

/**
 * `6667` → `66.67%`, in integer arithmetic; null → an em dash.
 *
 * The server sends basis points precisely so no float touches a rate; dividing here would
 * undo that at the last step.
 */
export function percentOfBps(bps: number | null): string {
  if (bps === null) return '—';
  return `${String(Math.trunc(bps / 100))}.${String(bps % 100).padStart(2, '0')}%`;
}

/** Today in Asia/Dhaka, as `YYYY-MM-DD` (invariant 8). */
export function todayInDhaka(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Dhaka',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** An Asia/Dhaka calendar date `days` before `date`. Calendar arithmetic, not a duration. */
export function daysBefore(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) - days)).toISOString().slice(0, 10);
}

export interface ReceiptLine {
  readonly skuId: string;
  readonly outstandingQty: number;
}

export interface ReceiptEntry {
  readonly sellableQty: number;
  readonly damagedQty: number;
}

export type ReceiptProblem = 'nothing' | 'too_many' | 'needs_damaged_location';

/**
 * What is wrong with a return inspection, before it is sent.
 *
 * The server refuses all three as well; checking here puts the reason next to the field the
 * person is looking at instead of in a toast after the round trip. Quantities over what can
 * still come back are refused because the extra units would be stock that never left.
 */
export function receiptProblem(
  lines: readonly ReceiptLine[],
  entries: Readonly<Record<string, ReceiptEntry>>,
  damagedLocationId: string,
): ReceiptProblem | null {
  let total = 0;
  let damaged = 0;
  for (const line of lines) {
    const entry = entries[line.skuId] ?? { sellableQty: 0, damagedQty: 0 };
    if (entry.sellableQty < 0 || entry.damagedQty < 0) return 'too_many';
    if (entry.sellableQty + entry.damagedQty > line.outstandingQty) return 'too_many';
    total += entry.sellableQty + entry.damagedQty;
    damaged += entry.damagedQty;
  }
  if (total === 0) return 'nothing';
  if (damaged > 0 && damagedLocationId === '') return 'needs_damaged_location';
  return null;
}

/** A whole number from a quantity field, or 0 for anything else. */
export function quantity(value: string): number {
  return /^\d{1,6}$/.test(value.trim()) ? Number(value.trim()) : 0;
}
