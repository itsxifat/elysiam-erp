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
 * unit price under the catalogue's, a line discount, and the order-level discount. It is held
 * to the ceiling **on every line and on the order as a whole**, and a markup on one line never
 * pays for a discount on another. The ledger audit showed why both matter: priced together, a
 * line at double the list could carry a free one, and the buyer then refused the expensive
 * line at the door (a partial delivery values each line at its own price) or exchanged it for
 * a full credit. A promo code is not counted: the server prices it from marketing's rules
 * (D-204), not from anything typed.
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
  readonly skuId: string;
  readonly qty: number;
  /** The catalogue's price for the SKU. */
  readonly listPricePoisha: Poisha;
  /** What the order charges per unit, as typed or defaulted to the list price. */
  readonly unitPricePoisha: Poisha;
  readonly lineDiscountPoisha: Poisha;
}

export interface DiscountedOrder {
  readonly lines: readonly DiscountedLine[];
  readonly orderDiscountPoisha: Poisha;
}

export interface TypedDiscount {
  /** The catalogue value of the lines. */
  readonly listPoisha: bigint;
  /** How far each line is priced below its list, summed, plus the order discount. */
  readonly discountPoisha: bigint;
}

/** How far one line is priced below its list; a markup counts as nothing, never as credit. */
function lineShortfall(line: DiscountedLine): { list: bigint; short: bigint } {
  const list = mulQty(line.listPricePoisha, line.qty);
  const charged = mulQty(line.unitPricePoisha, line.qty) - line.lineDiscountPoisha;
  const short = list - charged;
  return { list, short: short > 0n ? short : 0n };
}

/** The order's typed discount against its catalogue value, with no line offsetting another. */
export function typedDiscount(order: DiscountedOrder): TypedDiscount {
  let listPoisha = 0n;
  let discountPoisha = order.orderDiscountPoisha > 0n ? BigInt(order.orderDiscountPoisha) : 0n;
  for (const line of order.lines) {
    const { list, short } = lineShortfall(line);
    listPoisha += list;
    discountPoisha += short;
  }
  return { listPoisha, discountPoisha };
}

/** `part` is at most `ceilingBps` of `whole`, by cross-multiplication: nothing is rounded. */
function within(part: bigint, whole: bigint, ceilingBps: number): boolean {
  if (part <= 0n) return true;
  if (whole <= 0n) return ceilingBps >= 10_000;
  return part * 10_000n <= BigInt(ceilingBps) * whole;
}

/**
 * Whether every line, and the order as a whole, is within `ceilingBps` of its list value.
 *
 * Exactly the ceiling is within it, and one poisha more is not.
 */
export function withinDiscountCeiling(order: DiscountedOrder, ceilingBps: number): boolean {
  for (const line of order.lines) {
    const { list, short } = lineShortfall(line);
    if (!within(short, list, ceilingBps)) return false;
  }
  const total = typedDiscount(order);
  return within(total.discountPoisha, total.listPoisha, ceilingBps);
}

/** `a.part / a.whole` is at most `b.part / b.whole`, by cross-multiplication. */
function rateNotHigher(
  after: { part: bigint; whole: bigint },
  before: { part: bigint; whole: bigint },
): boolean {
  if (after.part <= 0n) return true;
  if (after.whole <= 0n || before.whole <= 0n) return false;
  return after.part * before.whole <= before.part * after.whole;
}

/**
 * Whether `after` only takes things away from `before`: the same SKUs or fewer, each at its
 * old price, no more units, and **no line and no order priced at a deeper rate** than before.
 *
 * An agent may drop a line or a unit from an order an org admin priced deeply. They may not
 * reshape it (another SKU at the same total discount would let them choose what goes out at
 * the admin's price), and they may not keep a discount's amount while the goods under it
 * shrink: ten units at 20% off as a ৳3,000 order discount, cut to two units with the ৳3,000
 * kept, is the whole order free (the ledger re-audit's critical finding). Rates are compared
 * by cross-multiplication, so nothing is rounded.
 */
export function onlyShrinks(before: DiscountedOrder, after: DiscountedOrder): boolean {
  if (after.orderDiscountPoisha > before.orderDiscountPoisha) return false;
  for (const line of after.lines) {
    const old = before.lines.find((candidate) => candidate.skuId === line.skuId);
    if (old === undefined) return false;
    if (line.unitPricePoisha !== old.unitPricePoisha) return false;
    if (line.qty > old.qty) return false;
    const now = lineShortfall(line);
    const then = lineShortfall(old);
    if (
      !rateNotHigher({ part: now.short, whole: now.list }, { part: then.short, whole: then.list })
    ) {
      return false;
    }
  }
  const now = typedDiscount(after);
  const then = typedDiscount(before);
  return rateNotHigher(
    { part: now.discountPoisha, whole: now.listPoisha },
    { part: then.discountPoisha, whole: then.listPoisha },
  );
}

/** Who is asking, as the request context holds it. */
export interface OrderPricingAuthority {
  readonly isSuperAdmin: boolean;
  readonly roles: readonly string[];
}

/**
 * The caller's ceiling: the highest any of their roles grants.
 *
 * Not per branch, unlike the till's (D-075). Whether the caller may touch an order at all
 * is the order's scope check; this only says how deep a price they may type into one they
 * can. With sales and branch_manager at the same figure, a per-branch reading would change
 * nothing but the number of ways to get it wrong.
 */
export function orderDiscountCeilingBps(authority: OrderPricingAuthority): number {
  if (authority.isSuperAdmin) return 10_000;
  let best = 0;
  for (const role of authority.roles) {
    best = Math.max(best, ORDER_DISCOUNT_CEILING_BPS[role] ?? 0);
  }
  return best;
}

/**
 * Whether the caller may save an order priced like this: within their ceiling, or an edit
 * that only shrinks what the order already was (`onlyShrinks`).
 */
export function discountAllowed(input: {
  readonly after: DiscountedOrder;
  readonly before?: DiscountedOrder;
  readonly ceilingBps: number;
}): boolean {
  if (withinDiscountCeiling(input.after, input.ceilingBps)) return true;
  return input.before !== undefined && onlyShrinks(input.before, input.after);
}

/**
 * How much of the cash on delivery a person may write off at the door, by role (D-365).
 *
 * The desk's ceilings, plus warehouse: the people who record a parcel's delivery by hand. With
 * no row of its own warehouse could record no shortfall at all, not even a buyer short by the
 * change, and an org admin would have to record every one.
 */
export const SHORT_COLLECTION_CEILING_BPS: Readonly<Record<string, number>> = {
  ...ORDER_DISCOUNT_CEILING_BPS,
  warehouse: 2_000,
};

export function shortCollectionCeilingBps(authority: OrderPricingAuthority): number {
  if (authority.isSuperAdmin) return 10_000;
  let best = 0;
  for (const role of authority.roles) {
    best = Math.max(best, SHORT_COLLECTION_CEILING_BPS[role] ?? 0);
  }
  return best;
}

/**
 * Whether a person may record this short collection (M30, D-365): at the desk, or on a
 * parcel's manual status.
 *
 * Less than the cash on delivery posts the difference to Sales discounts (§7), so a typed
 * shortfall is a discount given at the door. It is held to the same ceiling as a discount
 * typed at the order: otherwise an agent could price within 20% and then deliver at
 * nothing, which the re-audit found still open. The courier's own figure arrives through the
 * parcel and is checked by the settlement instead.
 */
export function shortCollectionAllowed(input: {
  readonly expectedPoisha: bigint;
  readonly collectedPoisha: bigint;
  readonly ceilingBps: number;
}): boolean {
  const shortfall = input.expectedPoisha - input.collectedPoisha;
  return within(shortfall, input.expectedPoisha, input.ceilingBps);
}

/** Basis points as a percentage for a message, in integer arithmetic: 2_000 → "20". */
export function basisPointsAsPercent(bps: number): string {
  const whole = Math.trunc(bps / 100);
  const rest = bps % 100;
  return rest === 0 ? String(whole) : `${String(whole)}.${String(rest).padStart(2, '0')}`;
}
