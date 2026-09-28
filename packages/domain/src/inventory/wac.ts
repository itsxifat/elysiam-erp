import { divideRounded, mulQty, poisha, ZERO, type Poisha } from '../money/index.js';
import { InventoryError } from './movements.js';

/**
 * Weighted average cost, per org and SKU (architecture §8 "WAC").
 *
 * §8's formula, exactly:
 *
 *     new_wac = round((qty_basis × wac + q × unit_cost) / (qty_basis + q))
 *
 * where `qty_basis` is the org-wide on-hand **before** the receipt, negative
 * treated as zero. The three things this function is careful about are the three
 * that make a cost average wrong in practice:
 *
 * 1. **It is per org, not per location.** §8 says so, and the reason is that
 *    moving a carton from the warehouse to a showroom must not change what the
 *    units cost. A per-location average would make COGS depend on which shelf a
 *    unit was picked from.
 * 2. **It rounds once, through `divideRounded`.** Half away from zero, the one
 *    rounding rule in the system. Keeping a fractional average "for accuracy"
 *    is the classic version of this bug: the fraction has to be stored
 *    somewhere, and the only honest place is a float, which invariant 1 forbids
 *    for exactly this reason.
 * 3. **A negative basis is clamped, not trusted.** `stock_levels` can never go
 *    negative (invariant 3), so a negative basis means the caller computed it
 *    from something else and got it wrong; clamping keeps the average
 *    meaningful instead of letting a negative denominator invert it.
 */

export interface SkuCost {
  /** The current weighted average, in poisha. Zero for a SKU never received. */
  readonly wacPoisha: Poisha;
  /** The quantity the average is based on: the org-wide on-hand. */
  readonly qtyBasis: number;
}

export interface BlendInput {
  readonly current: SkuCost;
  /** Units arriving. Positive. */
  readonly receivedQty: number;
  /** What they arrive at: a purchase price, or the cost a return was dispatched at. */
  readonly unitCostPoisha: Poisha;
}

export const ZERO_COST: SkuCost = { wacPoisha: ZERO, qtyBasis: 0 };

export function blendWac(input: BlendInput): SkuCost {
  const { receivedQty, unitCostPoisha } = input;
  if (!Number.isSafeInteger(receivedQty) || receivedQty <= 0) {
    throw new InventoryError(
      'STOCK_MOVEMENT_INVALID',
      'Blending a cost needs a positive whole quantity.',
    );
  }
  if (unitCostPoisha < 0n) {
    throw new InventoryError('STOCK_MOVEMENT_INVALID', 'A unit cost cannot be negative.');
  }

  // Negative would invert the average; §8 says treat it as zero.
  const basis = Math.max(0, input.current.qtyBasis);
  const existingValue = mulQty(input.current.wacPoisha, basis);
  const arrivingValue = mulQty(unitCostPoisha, receivedQty);

  return {
    wacPoisha: poisha(
      divideRounded(existingValue + arrivingValue, BigInt(basis) + BigInt(receivedQty)),
    ),
    qtyBasis: basis + receivedQty,
  };
}

/**
 * The basis after stock left, without touching the average.
 *
 * Taking units out does not change what the remaining ones cost, so only the
 * quantity the average is based on moves. Clamped at zero because the basis is
 * the org-wide on-hand and that can never be negative; if a caller somehow
 * removes more than the basis knows about, the average it leaves behind is still
 * the last real one rather than a division by a negative number on the next
 * receipt.
 */
export function reduceBasis(current: SkuCost, removedQty: number): SkuCost {
  if (!Number.isSafeInteger(removedQty) || removedQty <= 0) {
    throw new InventoryError(
      'STOCK_MOVEMENT_INVALID',
      'Reducing a cost basis needs a positive whole quantity.',
    );
  }
  return { wacPoisha: current.wacPoisha, qtyBasis: Math.max(0, current.qtyBasis - removedQty) };
}

/** Quantity × weighted average cost. The only way stock value is computed. */
export function stockValuePoisha(qty: number, wacPoisha: Poisha): Poisha {
  if (!Number.isSafeInteger(qty)) {
    throw new InventoryError('STOCK_MOVEMENT_INVALID', 'A quantity must be a whole number.');
  }
  return mulQty(wacPoisha, qty);
}

/**
 * The purchase price variance on a supplier return (§7, §8).
 *
 * Stock leaves at the current average and the supplier is credited at what the
 * line originally cost. The difference is not an error to be hidden — it is the
 * price movement between the purchase and the return, and §7 puts it in
 * `purchase_price_variance`.
 *
 * Positive means the supplier is credited more than the stock was carried at, so
 * the variance is a **credit** (a gain); negative means the reverse. The sign is
 * returned rather than an absolute value plus a flag, because a flag is the thing
 * a caller forgets to read.
 */
export function supplierReturnVariance(input: {
  readonly qty: number;
  readonly originalUnitCostPoisha: Poisha;
  readonly currentWacPoisha: Poisha;
}): {
  readonly supplierCreditPoisha: Poisha;
  readonly inventoryReliefPoisha: Poisha;
  readonly variancePoisha: bigint;
} {
  if (!Number.isSafeInteger(input.qty) || input.qty <= 0) {
    throw new InventoryError(
      'STOCK_MOVEMENT_INVALID',
      'A supplier return needs a positive quantity.',
    );
  }
  const supplierCreditPoisha = mulQty(input.originalUnitCostPoisha, input.qty);
  const inventoryReliefPoisha = mulQty(input.currentWacPoisha, input.qty);
  return {
    supplierCreditPoisha,
    inventoryReliefPoisha,
    variancePoisha: supplierCreditPoisha - inventoryReliefPoisha,
  };
}
