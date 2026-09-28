import { OrderError } from './state.js';

/**
 * Order numbers (architecture §9: `order_no`, per-org sequence, e.g. `OUR-2609-00042`).
 *
 * The format is three parts and each one is doing a job:
 *
 * * **the prefix** identifies the brand on a printed invoice sitting on a desk with
 *   four other brands' invoices. It is per org and configurable, defaulting to the
 *   first three letters of the org's slug.
 * * **`2609`** is the Asia/Dhaka year and month (invariant 8). An order number carries
 *   its own month, so a warehouse can sort a shelf of parcels by eye and a support
 *   agent knows which period a dispute falls in without opening anything.
 * * **`00042`** is the counter, and it restarts each month. That is the reason the
 *   month is in the number at all: a counter that never resets reaches seven digits
 *   in a year of COD volume, and the number stops being something a customer can read
 *   over the phone.
 *
 * The counter itself is not here. It comes from one atomic
 * `insert … on conflict do update set last_no = last_no + 1 returning last_no`
 * against `sales.order_counters` — the same reason M07 reserves stock with a
 * conditional UPDATE rather than a read-then-write. Two agents confirming orders in
 * the same second must get different numbers, and a `select max(order_no)` version
 * gives them the same one. This module only formats what that statement returned, and
 * is therefore pure and testable (invariant 11).
 */

/** The `YYMM` period an order number and its counter belong to. */
export type OrderPeriod = string & { readonly __orderPeriod: true };

const PERIOD = /^\d{4}$/;
const PREFIX = /^[A-Z][A-Z0-9]{1,5}$/;

/**
 * The counter's period, from the order's business date.
 *
 * Takes the already-computed Asia/Dhaka date rather than a `Date`, so a number and the
 * journal beside it cannot end up in different months. An order confirmed at 00:30 on
 * the first of October in Dhaka is an October order; reading UTC would file it in
 * September, where the period may already be closed.
 */
export function orderPeriodFor(businessDate: string): OrderPeriod {
  const match = /^(\d{4})-(\d{2})-\d{2}$/.exec(businessDate);
  if (match === null) {
    throw new OrderError('ORDER_LINES_INVALID', `"${businessDate}" is not a calendar date.`);
  }
  const [, year = '', month = ''] = match;
  return `${year.slice(2)}${month}` as OrderPeriod;
}

/**
 * The brand's prefix, from a configured value or from the slug.
 *
 * Derived rather than required, so a new org gets a working number on its first order
 * instead of failing until somebody sets a setting. Uppercased and stripped of
 * anything that is not a letter or digit, because the prefix ends up in a filename, a
 * courier's reference field and a URL.
 */
export function orderPrefixFor(input: {
  readonly slug: string;
  readonly configured?: string | null;
}): string {
  const configured = (input.configured ?? '').trim().toUpperCase();
  if (configured !== '') {
    if (!PREFIX.test(configured)) {
      throw new OrderError(
        'ORDER_LINES_INVALID',
        'An order number prefix is two to six letters or digits, starting with a letter.',
      );
    }
    return configured;
  }

  const letters = input.slug.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const derived = letters.slice(0, 3);
  if (!PREFIX.test(derived)) {
    // A slug with fewer than two usable characters. Every seeded org has more, so this
    // is a guard against a future org created with a one-character slug rather than a
    // case anybody will hit — and silently padding it would produce two brands sharing
    // a prefix, which is precisely what the prefix exists to prevent.
    throw new OrderError(
      'ORDER_LINES_INVALID',
      `The slug "${input.slug}" gives no usable order number prefix; configure one.`,
    );
  }
  return derived;
}

export function formatOrderNo(input: {
  readonly prefix: string;
  readonly period: OrderPeriod | string;
  readonly sequence: number;
}): string {
  const prefix = input.prefix.toUpperCase();
  if (!PREFIX.test(prefix)) {
    throw new OrderError('ORDER_LINES_INVALID', `"${input.prefix}" is not a valid order prefix.`);
  }
  if (!PERIOD.test(input.period)) {
    throw new OrderError('ORDER_LINES_INVALID', `"${input.period}" is not a YYMM period.`);
  }
  if (!Number.isSafeInteger(input.sequence) || input.sequence <= 0) {
    throw new OrderError('ORDER_LINES_INVALID', 'An order sequence starts at one.');
  }

  /*
   * Five digits, and *not truncated* past them.
   *
   * A brand that does a hundred thousand orders in one month gets a six-digit number
   * rather than a number that collides with order 1. `padStart` widens; it never
   * clips, and there is a unique index behind it either way — but a format that
   * quietly wrapped would break the index rather than the display, which is the
   * expensive way to find out.
   */
  return `${prefix}-${input.period}-${String(input.sequence).padStart(5, '0')}`;
}

/** Split a number back into its parts, for a search box that accepts one. */
export function parseOrderNo(
  value: string,
): { readonly prefix: string; readonly period: string; readonly sequence: number } | undefined {
  const match = /^([A-Z][A-Z0-9]{1,5})-(\d{4})-(\d{5,})$/.exec(value.trim().toUpperCase());
  if (match === null) return undefined;
  const [, prefix = '', period = '', sequence = ''] = match;
  return { prefix, period, sequence: Number(sequence) };
}
