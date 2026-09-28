import { add, allocate, mulQty, sub, sum, ZERO, type Poisha } from '../money/index.js';
import { OrderError } from './state.js';

/**
 * Order totals (architecture §9 "Totals", invariant 11).
 *
 * §9 gives one formula and it is the whole of this file:
 *
 *     COD = items − discount + delivery − advance
 *
 * and "the domain rejects a negative COD". Both halves matter. The formula lives
 * here, in a pure function, rather than in the SQL that inserts the order or in the
 * screen that shows it, because a total computed in two places is a total that
 * disagrees with itself the first time somebody adds a promo code to one of them —
 * and the number the courier collects is the one the customer argues about.
 *
 * A negative COD is refused rather than clamped to zero. It means the discount and
 * the advance together exceed what was sold, which is either a mis-keyed discount or
 * a refund pretending to be an order; clamping would hide the first and post the
 * second as a delivery worth nothing. A refund is its own event with its own
 * journal, and it is not this.
 *
 * Sales are recorded **net of discount** (§7's accounting policies), and the discount
 * is kept on the order for reporting. So `netItemsPoisha` — not `itemsPoisha` — is
 * what the delivered journal credits to revenue, and `discountPoisha` is what the
 * order row stores so "how much did we give away on Eid" stays answerable.
 */

export interface OrderLineTotalsInput {
  readonly qty: number;
  /** The selling price, or a reseller's customer price (§9). Never a cost. */
  readonly unitPricePoisha: Poisha;
  /** A discount on this line specifically. Order-level discount is separate. */
  readonly lineDiscountPoisha?: Poisha;
}

export interface OrderTotalsInput {
  readonly lines: readonly OrderLineTotalsInput[];
  /** A discount on the order as a whole: a promo code, or an agent's goodwill. */
  readonly orderDiscountPoisha?: Poisha;
  readonly deliveryChargePoisha?: Poisha;
  /** What the customer has already paid — bKash before dispatch, or an exchange credit. */
  readonly advancePaidPoisha?: Poisha;
}

export interface OrderTotals {
  /** Σ qty × unit price, before any discount. */
  readonly itemsPoisha: Poisha;
  /** Line discounts plus the order discount. Kept for reporting (§7). */
  readonly discountPoisha: Poisha;
  /** What revenue is recognised at on delivery: items − discount. */
  readonly netItemsPoisha: Poisha;
  readonly deliveryChargePoisha: Poisha;
  readonly advancePaidPoisha: Poisha;
  /** What the courier collects at the door. */
  readonly codAmountPoisha: Poisha;
}

const MAX_QTY = 100_000;

export function computeOrderTotals(input: OrderTotalsInput): OrderTotals {
  if (input.lines.length === 0) {
    throw new OrderError('ORDER_LINES_INVALID', 'An order needs at least one line.');
  }

  const lineGross: Poisha[] = [];
  const lineDiscounts: Poisha[] = [];

  for (const line of input.lines) {
    if (!Number.isSafeInteger(line.qty) || line.qty <= 0 || line.qty > MAX_QTY) {
      throw new OrderError('ORDER_LINES_INVALID', 'A line quantity must be a positive integer.');
    }
    if (line.unitPricePoisha < 0n) {
      throw new OrderError('ORDER_LINES_INVALID', 'A unit price cannot be negative.');
    }
    const gross = mulQty(line.unitPricePoisha, line.qty);
    const discount = line.lineDiscountPoisha ?? ZERO;
    if (discount < 0n) {
      throw new OrderError('ORDER_LINES_INVALID', 'A line discount cannot be negative.');
    }
    if (discount > gross) {
      // A line given away for more than it is worth. Refused rather than netted
      // against the next line: a discount that can exceed its own line lets one
      // mis-keyed row silently reduce the value of the others, and the order's
      // revenue then does not match any line on the invoice the customer holds.
      throw new OrderError(
        'ORDER_TOTAL_INVALID',
        'A line discount cannot be more than the line is worth.',
      );
    }
    lineGross.push(gross);
    lineDiscounts.push(discount);
  }

  const itemsPoisha = sum(lineGross);
  const orderDiscount = input.orderDiscountPoisha ?? ZERO;
  if (orderDiscount < 0n) {
    throw new OrderError('ORDER_TOTAL_INVALID', 'An order discount cannot be negative.');
  }

  const discountPoisha = add(sum(lineDiscounts), orderDiscount);
  if (discountPoisha > itemsPoisha) {
    throw new OrderError(
      'ORDER_TOTAL_INVALID',
      'The discount is more than the items are worth; revenue cannot be negative.',
    );
  }
  const netItemsPoisha = sub(itemsPoisha, discountPoisha);

  const deliveryChargePoisha = input.deliveryChargePoisha ?? ZERO;
  if (deliveryChargePoisha < 0n) {
    throw new OrderError('ORDER_TOTAL_INVALID', 'A delivery charge cannot be negative.');
  }
  const advancePaidPoisha = input.advancePaidPoisha ?? ZERO;
  if (advancePaidPoisha < 0n) {
    throw new OrderError('ORDER_TOTAL_INVALID', 'An advance cannot be negative.');
  }

  const codAmountPoisha = sub(add(netItemsPoisha, deliveryChargePoisha), advancePaidPoisha);
  if (codAmountPoisha < 0n) {
    // §9: "The domain rejects a negative COD." Named plainly, because the caller
    // that hits this is almost always applying a credit bigger than the order — an
    // exchange for something cheaper — and the fix is to cap the credit applied and
    // leave the remainder as a customer advance, not to let the courier hand money
    // back at the door.
    throw new OrderError(
      'ORDER_TOTAL_INVALID',
      'The discount and advance exceed the order value, so there is nothing to collect on delivery.',
    );
  }

  return {
    itemsPoisha,
    discountPoisha,
    netItemsPoisha,
    deliveryChargePoisha,
    advancePaidPoisha,
    codAmountPoisha,
  };
}

/**
 * How much of an advance an order can absorb.
 *
 * Used by the exchange flow. An exchange credits the customer with what they paid for
 * the units they sent back, and the replacement may be worth less — in which case the
 * credit cannot all be applied, because §9's COD may not go negative. The remainder
 * stays in `customer_advance`, which is where a store credit belongs: a liability the
 * brand owes, visible on the balance sheet, spendable on the next order.
 */
export function applicableAdvance(input: {
  readonly netItemsPoisha: Poisha;
  readonly deliveryChargePoisha: Poisha;
  readonly creditPoisha: Poisha;
}): { readonly appliedPoisha: Poisha; readonly remainingPoisha: Poisha } {
  const payable = add(input.netItemsPoisha, input.deliveryChargePoisha);
  const appliedPoisha = input.creditPoisha > payable ? payable : input.creditPoisha;
  return { appliedPoisha, remainingPoisha: sub(input.creditPoisha, appliedPoisha) };
}

export interface DeliveredLineInput extends OrderLineTotalsInput {
  /** How many of this line's units the courier actually handed over. */
  readonly deliveredQty: number;
}

export interface PartialDeliveryTotals {
  /** Net item value of the delivered units: what revenue is recognised at. */
  readonly deliveredNetItemsPoisha: Poisha;
  /** Net item value of the units that are coming back. */
  readonly undeliveredNetItemsPoisha: Poisha;
  /** The order-level discount apportioned to the delivered units. */
  readonly deliveredDiscountPoisha: Poisha;
  /** What the courier should have collected: delivered net items + delivery charge. */
  readonly expectedCollectionPoisha: Poisha;
}

/**
 * A partial delivery, split line by line (§9, §7 "Partially delivered").
 *
 * The order-level discount is the interesting part. It was given on the order as a
 * whole, so when half the parcel comes back the question is how much of the discount
 * belongs to the half that stayed. Apportioned by gross line value with
 * `allocate` — largest remainder — so the delivered and undelivered shares always sum
 * to exactly the discount that was given. Dividing and rounding each share
 * independently loses or invents a poisha, and that poisha reappears as an
 * unexplained difference in the Sales discounts account that no report can source.
 */
export function computePartialDelivery(input: {
  readonly lines: readonly DeliveredLineInput[];
  readonly orderDiscountPoisha?: Poisha;
  readonly deliveryChargePoisha?: Poisha;
}): PartialDeliveryTotals {
  if (input.lines.length === 0) {
    throw new OrderError('ORDER_LINES_INVALID', 'A partial delivery needs at least one line.');
  }

  const deliveredNet: Poisha[] = [];
  const deliveredGrossValues: Poisha[] = [];
  const undeliveredNet: Poisha[] = [];
  const deliveredWeights: bigint[] = [];
  const undeliveredWeights: bigint[] = [];
  let anyDelivered = false;

  for (const line of input.lines) {
    if (
      !Number.isSafeInteger(line.deliveredQty) ||
      line.deliveredQty < 0 ||
      line.deliveredQty > line.qty
    ) {
      throw new OrderError(
        'ORDER_LINES_INVALID',
        'A delivered quantity must be between zero and the ordered quantity.',
      );
    }
    if (line.deliveredQty > 0) anyDelivered = true;

    const gross = mulQty(line.unitPricePoisha, line.qty);
    const lineDiscount = line.lineDiscountPoisha ?? ZERO;
    if (lineDiscount > gross) {
      throw new OrderError(
        'ORDER_TOTAL_INVALID',
        'A line discount cannot be more than the line is worth.',
      );
    }
    /*
     * The line's own discount follows its own units, apportioned by quantity.
     *
     * `allocate` again rather than `discount * delivered / qty`: a ৳101 discount on
     * three units delivered two is 67.33 poisha per unit, and any per-unit rounding
     * leaves the two shares summing to 100 or 102 rather than 101.
     */
    const [deliveredShare = ZERO, undeliveredShare = ZERO] = allocate(lineDiscount, [
      line.deliveredQty,
      line.qty - line.deliveredQty,
    ]);
    const deliveredGross = mulQty(line.unitPricePoisha, line.deliveredQty);
    const undeliveredGross = sub(gross, deliveredGross);
    deliveredGrossValues.push(deliveredGross);

    deliveredNet.push(sub(deliveredGross, deliveredShare));
    undeliveredNet.push(sub(undeliveredGross, undeliveredShare));
    deliveredWeights.push(BigInt(sub(deliveredGross, deliveredShare)));
    undeliveredWeights.push(BigInt(sub(undeliveredGross, undeliveredShare)));
  }

  if (!anyDelivered) {
    // Nothing delivered is not a partial delivery; it is a return, and §9 sends it
    // down the return path where the stock and the postings are different. Saying so
    // stops a courier's "0 of 3 delivered" from posting a revenue journal of zero.
    throw new OrderError(
      'ORDER_LINES_INVALID',
      'No units were delivered, so this is a return rather than a partial delivery.',
    );
  }

  const orderDiscount = input.orderDiscountPoisha ?? ZERO;
  /*
   * The order discount is apportioned by the lines' **net** value, not their gross.
   *
   * Weighting by gross is the obvious choice and it is wrong in a way that only a
   * property test finds: a line already discounted to nearly nothing still carries its
   * full gross weight, so its share of the order discount can exceed what is left to
   * discount, and the delivered net goes negative. Net weighting cannot do that —
   * `computeOrderTotals` has already refused an order whose discounts exceed its items,
   * so each share is bounded by the value it is taken from.
   */
  const deliveredNetGross = deliveredWeights.reduce((acc, value) => acc + value, 0n);
  const undeliveredNetGross = undeliveredWeights.reduce((acc, value) => acc + value, 0n);
  /*
   * Nothing to apportion when the whole parcel is carried at no price.
   *
   * `allocate` refuses weights that are all zero, and rightly — splitting an amount
   * across nothing has no answer. A free order is a real thing (a replacement, a gift),
   * and it reaches here with both totals zero, so the shares are named as zero rather
   * than left to throw a money error from three frames down.
   */
  const [deliveredOrderDiscount = ZERO, undeliveredOrderDiscount = ZERO] =
    deliveredNetGross + undeliveredNetGross === 0n
      ? [ZERO, ZERO]
      : allocate(orderDiscount, [deliveredNetGross, undeliveredNetGross]);

  const deliveredNetItemsPoisha = sub(sum(deliveredNet), deliveredOrderDiscount);
  const undeliveredNetItemsPoisha = sub(sum(undeliveredNet), undeliveredOrderDiscount);
  if (deliveredNetItemsPoisha < 0n || undeliveredNetItemsPoisha < 0n) {
    // Only reachable when the caller's order discount exceeds its own net items, which
    // `computeOrderTotals` refuses — so this is the guard that keeps the two functions
    // from disagreeing if one of them is ever relaxed.
    throw new OrderError(
      'ORDER_TOTAL_INVALID',
      'The discount is more than the delivered items are worth.',
    );
  }

  const deliveryCharge = input.deliveryChargePoisha ?? ZERO;

  return {
    deliveredNetItemsPoisha,
    undeliveredNetItemsPoisha,
    // Both line and order discount shares, so the number reconciles to the order.
    deliveredDiscountPoisha: add(
      sub(sum(deliveredGrossValues), sum(deliveredNet)),
      deliveredOrderDiscount,
    ),
    /*
     * The delivery charge stays whole with the delivered part.
     *
     * The van went to the address once and the charge is for the journey, not for the
     * units — splitting it would make a two-item order delivered one collect half a
     * delivery charge, which is not what any courier's invoice says.
     */
    expectedCollectionPoisha: add(deliveredNetItemsPoisha, deliveryCharge),
  };
}

// --- exchanges ----------------------------------------------------------------

/** One SKU coming back, as the exchange endpoint receives it. */
export interface ExchangeReturnRequest {
  readonly skuId: string;
  readonly qty: number;
}

/** A delivered order's line, as the exchange needs to see it. */
export interface ExchangeLineState {
  readonly skuId: string;
  readonly qty: number;
  readonly deliveredQty: number;
  readonly returnedQty: number;
  readonly unitPricePoisha: Poisha;
  readonly lineDiscountPoisha?: Poisha;
  /** What the dispatch movement recorded. Zero for units carried at nothing. */
  readonly dispatchUnitCostPoisha: Poisha;
}

export interface ExchangeReturnLine {
  readonly skuId: string;
  /** The **aggregated** quantity for this SKU, whatever the request split it into. */
  readonly qty: number;
  readonly dispatchUnitCostPoisha: Poisha;
  /** What the line's counters become: delivered falls as returned rises. */
  readonly deliveredQty: number;
  readonly returnedQty: number;
}

export interface ExchangeReturnTotals {
  readonly lines: readonly ExchangeReturnLine[];
  /** Σ returned qty × the cost recorded on each dispatch movement. */
  readonly costPoisha: Poisha;
  /** Net item value of the returned units: what revenue was recognised on them. */
  readonly netItemsPoisha: Poisha;
}

/**
 * What an exchange sends back to the shelf, and what it is worth (architecture §9's last
 * transition row, M10 check 7).
 *
 * Pure, and here rather than in the service, for two reasons that are the same reason:
 *
 * **It aggregates by SKU before it checks anything.** A request naming the same SKU twice
 * — `[{A, 2}, {A, 2}]` against a line of two delivered units — passes a per-entry "is this
 * more than was delivered" test twice over. What followed was a journal crediting COGS
 * with four units of cost and the buyer with two line-values of credit, while inventory's
 * dedupe key wrote **one** movement of two units: a balanced journal, a trial balance still
 * at zero, inventory carrying value with no units behind it, and the replacement order
 * absorbing a credit large enough to make it free. Nothing reported it. Summing first makes
 * that request an `ORDER_LINES_INVALID` instead.
 *
 * **The returned value is apportioned with `allocate`, not by dividing.** A partial-line
 * exchange used to take `lineNet × qty / line.qty` in truncating bigint division, so the
 * buyer's credit came out up to `line.qty − 1` poisha short of what they paid. Largest
 * remainder is what `computePartialDelivery` already uses for exactly this split, two
 * functions up — and being here is what lets the property tests reach it (invariant 11).
 */
export function computeExchangeReturn(input: {
  readonly lines: readonly ExchangeLineState[];
  readonly returning: readonly ExchangeReturnRequest[];
}): ExchangeReturnTotals {
  if (input.returning.length === 0) {
    throw new OrderError('ORDER_LINES_INVALID', 'An exchange needs at least one unit back.');
  }

  const wanted = new Map<string, number>();
  for (const entry of input.returning) {
    if (!Number.isSafeInteger(entry.qty) || entry.qty <= 0 || entry.qty > MAX_QTY) {
      throw new OrderError(
        'ORDER_LINES_INVALID',
        'A returned quantity must be a positive integer.',
      );
    }
    wanted.set(entry.skuId, (wanted.get(entry.skuId) ?? 0) + entry.qty);
  }

  const lines: ExchangeReturnLine[] = [];
  const costs: Poisha[] = [];
  const nets: Poisha[] = [];

  for (const [skuId, qty] of wanted) {
    const line = input.lines.find((candidate) => candidate.skuId === skuId);
    if (line === undefined) {
      throw new OrderError('ORDER_LINES_INVALID', 'That SKU is not on the delivered order.');
    }
    if (qty > line.deliveredQty) {
      throw new OrderError(
        'ORDER_LINES_INVALID',
        'More units were sent back than were delivered on that line.',
      );
    }
    if (line.dispatchUnitCostPoisha < 0n || line.unitPricePoisha < 0n) {
      throw new OrderError('ORDER_LINES_INVALID', 'A line cannot carry a negative amount.');
    }

    const gross = mulQty(line.unitPricePoisha, line.qty);
    const lineNet = sub(gross, line.lineDiscountPoisha ?? ZERO);
    /*
     * The whole line's net when the whole line comes back, and a largest-remainder share
     * otherwise. `allocate` refuses an all-zero weight set, so a free line — a replacement
     * or a gift — is named as zero here rather than throwing a money error three frames
     * down; `orderExchangeDraft` then refuses the exchange itself, which is the right
     * answer: there is no credit to give.
     */
    const returnedNet =
      qty === line.qty
        ? lineNet
        : lineNet === ZERO
          ? ZERO
          : (allocate(lineNet, [qty, line.qty - qty])[0] ?? ZERO);

    costs.push(mulQty(line.dispatchUnitCostPoisha, qty));
    nets.push(returnedNet);
    lines.push({
      skuId,
      qty,
      dispatchUnitCostPoisha: line.dispatchUnitCostPoisha,
      /*
       * Delivered falls as returned rises.
       *
       * `order_lines_fulfilled_within_qty` keeps `delivered + returned <= qty`, so a fully
       * delivered line that gained a returned unit without losing a delivered one is a row
       * the database refuses — and rightly: it would claim more units left the building
       * than were ever ordered.
       */
      deliveredQty: line.deliveredQty - qty,
      returnedQty: line.returnedQty + qty,
    });
  }

  return { lines, costPoisha: sum(costs), netItemsPoisha: sum(nets) };
}
