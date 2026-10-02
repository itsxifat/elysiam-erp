import { type OrderStatus } from '../orders/state.js';
import { type ParcelStatus } from './status.js';

/**
 * The public tracking page's rules (M15: "order number plus the last 4 digits of the
 * phone").
 *
 * This is the one part of the ERP a stranger can reach without signing in, so the rules
 * are about what it must *not* say. Without the right four digits it says nothing — not
 * the courier, not the status, not whether an order with that number exists. The last of
 * those is the one that is easy to get wrong: a "wrong digits" message that differs from a
 * "no such order" message is an oracle that tells anyone which order numbers are real, and
 * from there the four digits are ten thousand guesses away. So there is exactly one
 * negative answer, and it is the same bytes whatever the reason.
 *
 * With the right digits the page shows a *stage*, not our internal status. `on_hold` is a
 * stock or desk hold, and telling a buyer their order is "on hold" invites exactly the call
 * the hold exists to avoid; it reads as "processing" here. Likewise the courier's own
 * vocabulary never reaches the page — only which of five steps the parcel has reached.
 */

/** Bangla numerals as a customer types them on a phone keyboard. */
const BANGLA_DIGITS = '০১২৩৪৫৬৭৮৯';

/** Every Bangla digit as its ASCII twin; nothing else changes. */
function banglaToAscii(input: string): string {
  let out = '';
  for (const char of input) {
    const index = BANGLA_DIGITS.indexOf(char);
    out += index >= 0 ? String(index) : char;
  }
  return out;
}

/**
 * A phone number or its tail, as bare ASCII digits: Bangla digits converted, and the spaces
 * and dashes a keyboard inserts dropped. The ASCII hyphen and the Unicode dash block
 * (U+2010–U+2015) are both dashes to a customer.
 */
export function asciiDigits(input: string): string {
  return banglaToAscii(input).replace(/[\s\-‐-―]/g, '');
}

/**
 * An order number as the database spells it: Bangla digits converted, spaces dropped, any
 * Unicode dash turned into the hyphen `OUR-2609-00042` is written with, upper-cased.
 */
function orderNumber(input: string): string {
  return banglaToAscii(input).replace(/\s/g, '').replace(/[‐-―]/g, '-').toUpperCase();
}

const ORDER_NO = /^[A-Z0-9][A-Z0-9-]{2,39}$/;

export interface TrackingQuery {
  readonly orderNo: string;
  readonly phoneLast4: string;
}

/**
 * Normalise what a customer typed, or refuse it.
 *
 * Refusing a malformed query is not a leak — it is a statement about the input, the same
 * for every order — and it keeps garbage out of the rate limiter's keys.
 */
export function parseTrackingQuery(input: {
  readonly orderNo: string;
  readonly phoneLast4: string;
}): TrackingQuery | null {
  const orderNo = orderNumber(input.orderNo);
  const phoneLast4 = asciiDigits(input.phoneLast4.trim());
  if (!ORDER_NO.test(orderNo)) return null;
  if (!/^\d{4}$/.test(phoneLast4)) return null;
  return { orderNo, phoneLast4 };
}

/**
 * Whether the presented digits end any of the order's phone numbers.
 *
 * Every candidate is compared, every character, whatever the earlier ones answered: the
 * comparison takes the same work for a match, a near-miss and no phone at all, so the time
 * it takes is not a way to learn the digits one at a time. `null` candidates are compared
 * against a fixed placeholder for the same reason — "this order has no second phone" must
 * cost what "this order's second phone did not match" costs.
 */
export function lastFourMatches(presented: string, phones: readonly (string | null)[]): boolean {
  const want = presented.padStart(4, '#').slice(-4);
  let matched = 0;
  for (const phone of phones) {
    const tail = (phone === null ? '' : asciiDigits(phone)).padStart(4, '*').slice(-4);
    let difference = phone === null ? 1 : 0;
    for (let index = 0; index < 4; index += 1) {
      difference |= want.charCodeAt(index) ^ tail.charCodeAt(index);
    }
    matched |= difference === 0 ? 1 : 0;
  }
  return matched === 1;
}

/** The five steps a customer sees, in order, plus the two ways a parcel can end badly. */
export const TRACKING_STEPS = [
  'received',
  'processing',
  'with_courier',
  'out_for_delivery',
  'delivered',
] as const;

export type TrackingStep = (typeof TRACKING_STEPS)[number];
export type TrackingStage = TrackingStep | 'returned' | 'cancelled';

/**
 * Which stage an order is at, from our status and (once shipped) the courier's.
 *
 * The order's status leads, because it is the one our books agree with. The parcel's status
 * refines only `shipped`: a rider carrying the parcel today is worth telling a customer, so
 * they stay home. A parcel the courier calls delivered while our order still says shipped
 * shows as "with courier" — the page never gets ahead of the books.
 */
export function trackingStage(order: OrderStatus, parcel: ParcelStatus | null): TrackingStage {
  switch (order) {
    case 'pending':
      return 'received';
    case 'confirmed':
    case 'on_hold':
    case 'packed':
      return 'processing';
    case 'shipped':
      return parcel === 'out_for_delivery' ? 'out_for_delivery' : 'with_courier';
    case 'delivered':
    case 'partially_delivered':
    case 'exchange':
      return 'delivered';
    case 'return_in_transit':
    case 'returned':
      return 'returned';
    case 'cancelled':
      return 'cancelled';
  }
}

export interface TrackingStepView {
  readonly step: TrackingStep;
  readonly reached: boolean;
}

/**
 * The ladder the page draws: each of the five steps, and whether it has been reached.
 *
 * A returned parcel reached `with_courier` and no further; a cancelled order reached
 * `received`. The ladder never claims a step the order did not take.
 */
export function trackingLadder(stage: TrackingStage): readonly TrackingStepView[] {
  const reachedIndex =
    stage === 'returned'
      ? TRACKING_STEPS.indexOf('with_courier')
      : stage === 'cancelled'
        ? TRACKING_STEPS.indexOf('received')
        : TRACKING_STEPS.indexOf(stage);
  return TRACKING_STEPS.map((step, index) => ({ step, reached: index <= reachedIndex }));
}
