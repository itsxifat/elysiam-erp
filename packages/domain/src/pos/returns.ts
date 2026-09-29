import { divideRounded, poisha, sub, type Poisha } from '../money/index.js';
import { PosError } from './errors.js';

/**
 * Returns and exchanges at the till, by receipt (architecture §14).
 *
 * The refund for a returned unit is what the customer **paid** for it — the
 * line's net, after its discount — not today's price and not the list price.
 * Refunding the list price on a discounted line hands back money the customer
 * never gave; refunding today's price turns a price rise into a profit on every
 * return.
 *
 * ## Cumulative rounding
 *
 * A line of 3 units that cost ৳1,000 together does not split into equal poisha:
 * ৳333.33 each. Rounding each return on its own gives ৳333.33 × 3 = ৳999.99, and
 * the missing poisha is revenue that was never reversed. So the refund for
 * returning `q` more units, when `r` have come back already, is the difference of
 * two cumulative shares: `share(r + q) − share(r)`. Whatever order the units come
 * back in, the refunds sum to the line's net exactly — the same largest-remainder
 * guarantee `allocate` gives, made incremental so a second return next week does
 * not need the first to be recomputed.
 */

export function cumulativeShare(netPoisha: Poisha, units: number, of: number): Poisha {
  if (!Number.isSafeInteger(of) || of <= 0) {
    throw new PosError('POS_RETURN_INVALID', 'A line has at least one unit.');
  }
  if (!Number.isSafeInteger(units) || units < 0 || units > of) {
    throw new PosError('POS_RETURN_INVALID', 'A share lies between none and all of the units.');
  }
  return poisha(divideRounded(netPoisha * BigInt(units), BigInt(of)));
}

export interface ReturnableLine {
  readonly qty: number;
  readonly netPoisha: Poisha;
  /** Units of this line already brought back by earlier returns. */
  readonly returnedQty: number;
}

/** What returning `qty` more units of a line refunds, or a refusal. */
export function refundFor(line: ReturnableLine, qty: number): Poisha {
  if (!Number.isSafeInteger(qty) || qty <= 0) {
    throw new PosError('POS_RETURN_INVALID', 'A returned quantity is a whole number of units.');
  }
  if (line.returnedQty + qty > line.qty) {
    throw new PosError(
      'POS_RETURN_INVALID',
      'More units would come back than the receipt sold on that line.',
    );
  }
  return sub(
    cumulativeShare(line.netPoisha, line.returnedQty + qty, line.qty),
    cumulativeShare(line.netPoisha, line.returnedQty, line.qty),
  );
}
