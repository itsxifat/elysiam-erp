import { mulQty, type Poisha } from '../money/index.js';

/**
 * How far below the catalogue an order may be priced, and by whom (M30, D-364).
 *
 * The order desk lets an agent type a unit price and a discount, because haggling on the
 * phone is the ordinary case in this business (see `createOrderLineSchema`). Nothing bounded
 * it: a sales agent could book a line at ৳0 to an accomplice, the warehouse would ship it,
 * and the delivery journal would post full cost against no revenue with nobody else having
 * seen the price. The till has had a per-role ceiling since M23 (D-164); this is the same
 * idea for the desk.
 *
 * "Discount" here is everything the caller typed that takes the order below list price: a
 * unit price under the catalogue's, a line discount, and the order-level discount. A unit
 * price above the list counts against it, so a markup on one line can pay for a discount on
 * another. A promo code is not counted: its discount is priced by the server from rules
 * marketing set (D-204), not typed by the agent.
 */
export const ORDER_DISCOUNT_CEILING_BPS: Readonly<Record<string, number>> = {
  // An org admin may give anything, including a free replacement.
  org_admin: 10_000,
  // A fifth off: enough for a regular buyer or a damaged item, not enough to give stock
  // away. The same figure the till gives a showroom manager.
  branch_manager: 2_000,
  sales: 2_000,
};

export interface DiscountedLine {
  readonly qty: number;
  /** The catalogue's price for the SKU. */
  readonly listPricePoisha: Poisha;
  /** What the order charges per unit, as typed or defaulted to the list price. */
  readonly unitPricePoisha: Poisha;
  readonly lineDiscountPoisha: Poisha;
}

export interface TypedDiscount {
  /** The catalogue value of the lines. */
  readonly listPoisha: bigint;
  /** List value minus what the order charges for its goods, before any promo code. */
  readonly discountPoisha: bigint;
}

/** The order's typed discount against its catalogue value. */
export function typedDiscount(
  lines: readonly DiscountedLine[],
  orderDiscountPoisha: Poisha,
): TypedDiscount {
  let listPoisha = 0n;
  let chargedPoisha = 0n;
  for (const line of lines) {
    listPoisha += mulQty(line.listPricePoisha, line.qty);
    chargedPoisha += mulQty(line.unitPricePoisha, line.qty) - line.lineDiscountPoisha;
  }
  chargedPoisha -= orderDiscountPoisha;
  return { listPoisha, discountPoisha: listPoisha - chargedPoisha };
}

/**
 * Whether a discount is within `ceilingBps` of its list value.
 *
 * Compared as a cross-multiplication rather than a division, so nothing is rounded: a
 * discount of exactly the ceiling is within it, and one poisha more is not.
 */
export function withinDiscountCeiling(discount: TypedDiscount, ceilingBps: number): boolean {
  if (discount.discountPoisha <= 0n) return true;
  if (discount.listPoisha <= 0n) return ceilingBps >= 10_000;
  return discount.discountPoisha * 10_000n <= BigInt(ceilingBps) * discount.listPoisha;
}

/**
 * The discount as whole basis points, rounded up, for a message and for "no worse than it
 * already was". Never used to decide a boundary case: `withinDiscountCeiling` does that.
 */
export function discountBasisPoints(discount: TypedDiscount): number {
  if (discount.discountPoisha <= 0n || discount.listPoisha <= 0n) return 0;
  const scaled = discount.discountPoisha * 10_000n;
  const bps = (scaled + discount.listPoisha - 1n) / discount.listPoisha;
  return Number(bps > 10_000n ? 10_000n : bps);
}
