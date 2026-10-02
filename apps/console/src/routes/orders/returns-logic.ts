/**
 * The returns report's small pure helpers (M17), tested in `orders-ui.test.ts`.
 *
 * Dates are Asia/Dhaka calendar dates (invariant 8): "this month" for a desk in Dhaka is
 * Dhaka's month, whatever the browser's own zone says.
 */

/** The fixed list of return reasons (D-234), in the server's order. */
export const RETURN_REASONS = [
  'customer_refused',
  'customer_unreachable',
  'wrong_address',
  'changed_mind',
  'size_issue',
  'quality_issue',
  'wrong_item',
  'damaged_in_transit',
  'late_delivery',
  'price_dispute',
  'other',
] as const;
export type ReturnReason = (typeof RETURN_REASONS)[number];

/** Today's Asia/Dhaka date as `YYYY-MM-DD`. */
export function todayInDhaka(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Dhaka',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** The first day of the month a `YYYY-MM-DD` date is in. */
export function monthStartOf(date: string): string {
  return `${date.slice(0, 8)}01`;
}

/** Basis points as a percentage with two decimals, from integers only: 3333 → "33.33%". */
export function formatShare(bps: number): string {
  const whole = Math.trunc(bps / 100);
  const rest = String(bps % 100).padStart(2, '0');
  return `${String(whole)}.${rest}%`;
}
