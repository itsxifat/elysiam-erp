import { add, allocate, mulQty, sub, sum, ZERO, type Poisha } from '../money/index.js';
import { OrderError } from './state.js';
import { applicableAdvance, computePartialDelivery, type OrderLineTotalsInput } from './totals.js';

/**
 * What the rider collects when the buyer keeps part of a parcel, re-priced (M50, D-924).
 *
 * The buyer takes some units at the door and gives the rest back. The offers the order had may
 * no longer apply to what they kept (a "10% over Tk 1,500" gone below Tk 1,500), others may now
 * apply, and the delivery charge may be changed. The person chooses in the return screen; this
 * says what that comes to.
 *
 * Two figures, because §7's partial delivery journal already knows how to book a difference:
 *
 * - `expectedPoisha` is what the journal expects for the kept units at the order's own terms
 *   (`computePartialDelivery`, the advance applied as the journal applies it).
 * - `collectPoisha` is what the kept units come to with the chosen offers and charge, less the
 *   same advance. It is what the rider collects and what the partial delivery records.
 *
 * Their difference goes to Sales discounts with its reason, by the existing rule: a smaller
 * discount than the order's share is a credit there, a bigger one a debit. Nothing new posts.
 *
 * Each kept line's own discount follows its units (`allocate`, as the journal does), so a line
 * price negotiated on the phone stays with the units the buyer kept.
 */
export interface ReturnRepriceLine extends OrderLineTotalsInput {
  /** Units the buyer keeps, from zero to the line's quantity. */
  readonly keptQty: number;
}

export interface ReturnRepriceInput {
  readonly lines: readonly ReturnRepriceLine[];
  /** The order-level discount the order carries now (its total less the lines' own). */
  readonly orderDiscountPoisha: Poisha;
  /** The order's delivery charge now. */
  readonly deliveryChargePoisha: Poisha;
  readonly advancePaidPoisha: Poisha;
  /** What the chosen offers take off the kept goods. */
  readonly offerDiscountPoisha: Poisha;
  /**
   * The person's own order-level discount on the whole order (the order-level discount less
   * what its offers gave). The kept pieces keep their share of it, split as §7 splits it.
   */
  readonly typedOrderDiscountPoisha: Poisha;
  /** The delivery charge the buyer pays now, after any offer on it. */
  readonly newDeliveryChargePoisha: Poisha;
}

export interface ReturnReprice {
  /** Each line's kept units at the order's price, less their share of the line's discount. */
  readonly keptLineNetPoisha: readonly Poisha[];
  readonly keptNetPoisha: Poisha;
  readonly keptUnits: number;
  /** The kept pieces' share of the person's own order discount. */
  readonly keptTypedDiscountPoisha: Poisha;
  readonly advanceAppliedPoisha: Poisha;
  /** §7's expectation for the kept units at the order's own terms. */
  readonly expectedPoisha: Poisha;
  /** What the rider collects with the chosen offers and charge. Never below zero. */
  readonly collectPoisha: Poisha;
}

export function repriceReturn(input: ReturnRepriceInput): ReturnReprice {
  const keptLineNetPoisha = input.lines.map((line) => {
    if (!Number.isSafeInteger(line.keptQty) || line.keptQty < 0 || line.keptQty > line.qty) {
      throw new OrderError(
        'ORDER_LINES_INVALID',
        'A kept quantity must be between zero and the quantity sent.',
      );
    }
    const [share = ZERO] = allocate(line.lineDiscountPoisha ?? ZERO, [
      line.keptQty,
      line.qty - line.keptQty,
    ]);
    return sub(mulQty(line.unitPricePoisha, line.keptQty), share);
  });
  const keptUnits = input.lines.reduce((total, line) => total + line.keptQty, 0);
  const keptNetPoisha = sum(keptLineNetPoisha);
  if (keptUnits === 0) {
    // Nothing kept is a return, not a partial delivery: nothing is collected.
    return {
      keptLineNetPoisha,
      keptNetPoisha,
      keptUnits,
      keptTypedDiscountPoisha: ZERO,
      advanceAppliedPoisha: ZERO,
      expectedPoisha: ZERO,
      collectPoisha: ZERO,
    };
  }
  const lineInputs = input.lines.map((line) => ({
    qty: line.qty,
    unitPricePoisha: line.unitPricePoisha,
    lineDiscountPoisha: line.lineDiscountPoisha ?? ZERO,
    deliveredQty: line.keptQty,
  }));
  // The kept pieces' share of the person's own discount, split exactly as §7 splits it: what
  // the kept pieces are worth without it, less what they are worth with it.
  const keptTypedDiscountPoisha = sub(
    computePartialDelivery({ lines: lineInputs, orderDiscountPoisha: ZERO })
      .deliveredNetItemsPoisha,
    computePartialDelivery({
      lines: lineInputs,
      orderDiscountPoisha: input.typedOrderDiscountPoisha,
    }).deliveredNetItemsPoisha,
  );
  const discounts = add(input.offerDiscountPoisha, keptTypedDiscountPoisha);
  if (discounts > keptNetPoisha) {
    throw new OrderError(
      'ORDER_TOTAL_INVALID',
      'The discounts are more than the kept items are worth.',
    );
  }

  const split = computePartialDelivery({
    lines: lineInputs,
    orderDiscountPoisha: input.orderDiscountPoisha,
    deliveryChargePoisha: input.deliveryChargePoisha,
  });
  // The advance as the delivery journal applies it, so `collect + advance` is what it holds.
  const { appliedPoisha: advanceAppliedPoisha } = applicableAdvance({
    netItemsPoisha: split.deliveredNetItemsPoisha,
    deliveryChargePoisha: input.deliveryChargePoisha,
    creditPoisha: input.advancePaidPoisha,
  });
  const expected = sub(split.expectedCollectionPoisha, advanceAppliedPoisha);
  const value = add(sub(keptNetPoisha, discounts), input.newDeliveryChargePoisha);
  const owed = sub(value, advanceAppliedPoisha);
  if (owed < 0n) {
    /*
     * The kept pieces with these offers and charge come to less than the advance the delivery
     * journal applies. Collecting nothing would book the buyer's own money as goods they did
     * not get; refusing keeps the choice with the person (fewer offers, or accounts' refund).
     */
    throw new OrderError(
      'ORDER_TOTAL_INVALID',
      'With these offers and this delivery charge the kept items come to less than the advance already paid. Take an offer off or change the charge, or ask accounts to refund the difference.',
    );
  }
  return {
    keptLineNetPoisha,
    keptNetPoisha,
    keptUnits,
    keptTypedDiscountPoisha,
    advanceAppliedPoisha,
    expectedPoisha: expected < 0n ? ZERO : expected,
    collectPoisha: owed,
  };
}
