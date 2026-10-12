import { add, mulQty, poisha, sub, sum, ZERO, type Poisha } from '../money/index.js';

/**
 * The chat's draft order, priced as the agent builds it (M44b, D-773): §9's formula, through the
 * money functions, so the panel's totals move on every key press without a round trip.
 *
 * A **preview**. The order's own transaction prices the lines from the catalog and computes the
 * totals with `computeOrderTotals` (the discount ceiling, the promo code and the zone's charge
 * included); the saved order's figures replace these the moment it exists. The advance is a
 * claim recorded after the order (M17, D-230): it lowers what is collected only once accounts
 * verifies it, so the preview shows it apart, as "to collect once the advance is verified".
 */

export interface DraftLineMoney {
  readonly unitPricePoisha: Poisha;
  readonly qty: number;
}

export interface DraftMoneyInput {
  readonly lines: readonly DraftLineMoney[];
  /** The agent's order discount. */
  readonly discountPoisha: Poisha;
  /** The delivery charge: the zone's, or what the agent typed. */
  readonly deliveryPoisha: Poisha;
  /** What a promo code takes off the goods and off the delivery, from the live check. */
  readonly promo?: {
    readonly discountPoisha: Poisha;
    readonly deliveryDiscountPoisha: Poisha;
  } | null;
  /** An advance the customer says they paid (bKash, Nagad, bank), still to be verified. */
  readonly advancePoisha: Poisha;
}

export type DraftProblem =
  'no_lines' | 'qty_invalid' | 'price_invalid' | 'discount_exceeds_items' | 'advance_exceeds_total';

export interface DraftTotals {
  readonly lineTotals: readonly Poisha[];
  readonly itemsPoisha: Poisha;
  /** The agent's discount and the code's goods discount together. */
  readonly discountPoisha: Poisha;
  /** The charge less the code's delivery discount, never below zero. */
  readonly deliveryPoisha: Poisha;
  /** Items − discount + delivery: the order's total and, before any advance, its COD. */
  readonly totalPoisha: Poisha;
  readonly advancePoisha: Poisha;
  /** Total − advance, never below zero: what the rider collects once the advance is verified. */
  readonly toCollectPoisha: Poisha;
  /** Why the server would refuse it as it stands; empty when it can be placed. */
  readonly problems: readonly DraftProblem[];
}

/** Draft quantities: one to 999 per line, as the order desk takes them. */
export const DRAFT_MAX_QTY = 999;

const max0 = (value: Poisha): Poisha => (value < 0n ? ZERO : value);

export function draftTotals(input: DraftMoneyInput): DraftTotals {
  const problems: DraftProblem[] = [];
  if (input.lines.length === 0) problems.push('no_lines');
  const lineTotals = input.lines.map((line) => {
    if (!Number.isSafeInteger(line.qty) || line.qty < 1 || line.qty > DRAFT_MAX_QTY) {
      if (!problems.includes('qty_invalid')) problems.push('qty_invalid');
      return ZERO;
    }
    if (line.unitPricePoisha < 0n) {
      if (!problems.includes('price_invalid')) problems.push('price_invalid');
      return ZERO;
    }
    return mulQty(line.unitPricePoisha, line.qty);
  });
  const itemsPoisha = sum(lineTotals);
  const promo = input.promo ?? null;
  const discountPoisha = add(
    max0(input.discountPoisha),
    promo === null ? ZERO : promo.discountPoisha,
  );
  const deliveryPoisha = max0(
    sub(max0(input.deliveryPoisha), promo === null ? ZERO : promo.deliveryDiscountPoisha),
  );
  if (discountPoisha > itemsPoisha) problems.push('discount_exceeds_items');
  const totalPoisha = max0(add(sub(itemsPoisha, discountPoisha), deliveryPoisha));
  const advancePoisha = max0(input.advancePoisha);
  if (advancePoisha > totalPoisha && advancePoisha > 0n) problems.push('advance_exceeds_total');
  return {
    lineTotals,
    itemsPoisha,
    discountPoisha,
    deliveryPoisha,
    totalPoisha,
    advancePoisha,
    toCollectPoisha: max0(sub(totalPoisha, advancePoisha)),
    problems,
  };
}

/** The draft as a screen holds it: every amount a decimal string of poisha. */
export interface DraftMoneyText {
  readonly lines: readonly { readonly unitPricePoisha: string; readonly qty: number }[];
  readonly discountPoisha: string;
  readonly deliveryPoisha: string;
  readonly promo?: {
    readonly discountPoisha: string;
    readonly deliveryDiscountPoisha: string;
  } | null;
  readonly advancePoisha: string;
}

/**
 * `draftTotals` from strings, as the console keeps them. Null when an amount is not an integer
 * number of poisha (a half-typed price), so the screen shows "amounts in taka" rather than throw.
 */
export function draftTotalsOf(input: DraftMoneyText): DraftTotals | null {
  try {
    return draftTotals({
      lines: input.lines.map((line) => ({
        unitPricePoisha: poisha(line.unitPricePoisha),
        qty: line.qty,
      })),
      discountPoisha: poisha(input.discountPoisha),
      deliveryPoisha: poisha(input.deliveryPoisha),
      promo:
        input.promo === undefined || input.promo === null
          ? null
          : {
              discountPoisha: poisha(input.promo.discountPoisha),
              deliveryDiscountPoisha: poisha(input.promo.deliveryDiscountPoisha),
            },
      advancePoisha: poisha(input.advancePoisha),
    });
  } catch {
    return null;
  }
}
