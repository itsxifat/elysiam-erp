import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { poisha } from '../money/index.js';
import {
  applyMovement,
  availableQty,
  blendWac,
  foldMovements,
  InventoryError,
  isBelowReorderLevel,
  levelKey,
  MOVEMENT_DIRECTION,
  MOVEMENT_KINDS,
  reduceBasis,
  stockValuePoisha,
  supplierReturnVariance,
  ZERO_COST,
  type LevelMovement,
  type MovementKind,
  type SkuCost,
} from './index.js';

/**
 * Inventory arithmetic (architecture §8, invariant 3; M07 checks 2 and 3).
 *
 * The property test is the reason this file exists. Check 2 asks that *random
 * sequences of movements never leave on_hand negative, and levels always equal Σ
 * movements* — two claims that only a generator can make convincingly, because
 * the failing sequence is never the one a person would write by hand. The
 * generator below builds a random walk of movements, applies them one at a time
 * through the same `applyMovement` the service uses, and then rebuilds the level
 * from scratch with `foldMovements`. Both answers must agree, and neither may go
 * negative.
 *
 * The WAC property is the second half of the same idea, aimed at the two ways a
 * weighted average goes wrong: it drifts negative, or it becomes NaN because
 * somebody divided by a basis of zero. Both are impossible here by construction —
 * the value is integer poisha and the denominator always includes the arriving
 * quantity — and the property is what keeps them impossible after a refactor.
 */

const SKUS = ['sku-a', 'sku-b'] as const;
const LOCATIONS = ['loc-1', 'loc-2'] as const;

/** Only the kinds that add stock, for building a starting position. */
const INBOUND = MOVEMENT_KINDS.filter((kind) => MOVEMENT_DIRECTION[kind] === 'in');
const OUTBOUND = MOVEMENT_KINDS.filter((kind) => MOVEMENT_DIRECTION[kind] === 'out');

interface Step {
  readonly skuId: string;
  readonly locationId: string;
  readonly kind: MovementKind;
  readonly qty: number;
}

const stepArbitrary = fc.record({
  skuId: fc.constantFrom(...SKUS),
  locationId: fc.constantFrom(...LOCATIONS),
  kind: fc.constantFrom(...MOVEMENT_KINDS),
  qty: fc.integer({ min: 1, max: 40 }),
});

/**
 * Turn a step into a movement the way the service does: the sign comes from the
 * kind, never from the caller.
 *
 * `count_correction` is the one kind that may go either way, and the generator
 * sends it down on odd quantities so the walk exercises both.
 */
function toMovement(step: Step): LevelMovement {
  const direction = MOVEMENT_DIRECTION[step.kind];
  const sign = direction === 'in' ? 1 : direction === 'out' ? -1 : step.qty % 2 === 0 ? 1 : -1;
  return {
    skuId: step.skuId,
    locationId: step.locationId,
    kind: step.kind,
    qtyDelta: sign * step.qty,
  };
}

describe('stock levels never go negative, and always equal Σ movements', () => {
  it('holds for random movement sequences', () => {
    fc.assert(
      fc.property(fc.array(stepArbitrary, { maxLength: 60 }), (steps) => {
        const levels = new Map<string, { onHand: number; reserved: number }>();
        const accepted: LevelMovement[] = [];

        for (const step of steps) {
          const movement = toMovement(step);
          const key = levelKey(movement);
          const level = levels.get(key) ?? { onHand: 0, reserved: 0 };
          let next;
          try {
            next = applyMovement(level, movement.qtyDelta);
          } catch (error) {
            // A refusal is the correct outcome for a movement that would drive the
            // level negative. What must never happen is the level changing anyway,
            // so the movement is dropped and the walk continues from the same
            // state — exactly as a rolled-back transaction leaves it.
            expect(error).toBeInstanceOf(InventoryError);
            expect((error as InventoryError).code).toBe('STOCK_INSUFFICIENT');
            continue;
          }
          expect(next.onHand).toBeGreaterThanOrEqual(0);
          levels.set(key, next);
          accepted.push(movement);
        }

        // Σ movements, computed independently of the running total above.
        const rebuilt = foldMovements(accepted);
        for (const [key, level] of levels) {
          expect(level.onHand).toBe(rebuilt.get(key) ?? 0);
          expect(level.onHand).toBeGreaterThanOrEqual(0);
        }
        // And nothing appears in the rebuild that the walk never touched.
        for (const [key, total] of rebuilt) {
          expect(levels.get(key)?.onHand ?? 0).toBe(total);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('refuses to ship stock that is reserved', () => {
    expect(() => applyMovement({ onHand: 5, reserved: 5 }, -1)).toThrow(InventoryError);
    expect(availableQty({ onHand: 5, reserved: 5 })).toBe(0);
  });

  it('refuses a movement whose sign contradicts its kind', () => {
    expect(() =>
      foldMovements([{ skuId: 's', locationId: 'l', kind: 'dispatch', qtyDelta: 3 }]),
    ).toThrow(/positive quantity/);
    expect(() =>
      foldMovements([{ skuId: 's', locationId: 'l', kind: 'supply_receipt', qtyDelta: -3 }]),
    ).toThrow(/negative quantity/);
  });
});

describe('weighted average cost never goes negative or NaN', () => {
  it('holds for random receipt sequences', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            qty: fc.integer({ min: 1, max: 500 }),
            unitCost: fc.bigInt({ min: 0n, max: 5_000_000n }),
            /** Some steps take stock out, which must not move the average. */
            out: fc.boolean(),
          }),
          { minLength: 1, maxLength: 40 },
        ),
        (steps) => {
          let cost: SkuCost = ZERO_COST;
          for (const step of steps) {
            if (step.out && cost.qtyBasis > 0) {
              const before = cost.wacPoisha;
              cost = reduceBasis(cost, Math.min(step.qty, cost.qtyBasis));
              expect(cost.wacPoisha).toBe(before);
            } else {
              cost = blendWac({
                current: cost,
                receivedQty: step.qty,
                unitCostPoisha: poisha(step.unitCost),
              });
            }
            expect(typeof cost.wacPoisha).toBe('bigint');
            expect(cost.wacPoisha >= 0n).toBe(true);
            expect(Number.isNaN(cost.qtyBasis)).toBe(false);
            expect(cost.qtyBasis).toBeGreaterThanOrEqual(0);
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it('never exceeds the highest unit cost blended in', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            qty: fc.integer({ min: 1, max: 100 }),
            unitCost: fc.bigInt({ min: 0n, max: 10_000_000n }),
          }),
          { minLength: 1, maxLength: 20 },
        ),
        (steps) => {
          let cost: SkuCost = ZERO_COST;
          let highest = 0n;
          for (const step of steps) {
            cost = blendWac({
              current: cost,
              receivedQty: step.qty,
              unitCostPoisha: poisha(step.unitCost),
            });
            if (step.unitCost > highest) highest = step.unitCost;
            // An average that can exceed its own inputs is the shape of a
            // multiplication that lost its denominator. Rounding can add at most
            // one poisha, so the bound is inclusive of that.
            expect(cost.wacPoisha <= highest + 1n).toBe(true);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('clamps a negative basis rather than inverting the average', () => {
    const blended = blendWac({
      current: { wacPoisha: poisha(50_000), qtyBasis: -7 },
      receivedQty: 10,
      unitCostPoisha: poisha(60_000),
    });
    expect(blended).toEqual({ wacPoisha: 60_000n, qtyBasis: 10 });
  });
});

describe('§8 worked example, to the poisha', () => {
  it('reproduces 10 @ ৳500 + 30 @ ৳540 → ৳530, and the return variance', () => {
    // Starting position: on-hand 10 @ ৳500.00.
    const opening = blendWac({
      current: ZERO_COST,
      receivedQty: 10,
      unitCostPoisha: poisha(50_000),
    });
    expect(opening).toEqual({ wacPoisha: 50_000n, qtyBasis: 10 });

    // Receive 30 @ ৳540.00 → (10×50000 + 30×54000) / 40 = 53,000 poisha.
    const afterReceipt = blendWac({
      current: opening,
      receivedQty: 30,
      unitCostPoisha: poisha(54_000),
    });
    expect(afterReceipt).toEqual({ wacPoisha: 53_000n, qtyBasis: 40 });

    // Dispatch 5 at 53,000. The average does not move; the basis does.
    const afterDispatch = reduceBasis(afterReceipt, 5);
    expect(afterDispatch).toEqual({ wacPoisha: 53_000n, qtyBasis: 35 });
    expect(stockValuePoisha(5, afterDispatch.wacPoisha)).toBe(265_000n);

    // A supplier return of 3 from the second lot: credit 3×54,000 = 162,000,
    // relieve inventory 3×53,000 = 159,000, and the 3,000 difference is a credit
    // to purchase price variance.
    expect(
      supplierReturnVariance({
        qty: 3,
        originalUnitCostPoisha: poisha(54_000),
        currentWacPoisha: afterDispatch.wacPoisha,
      }),
    ).toEqual({
      supplierCreditPoisha: 162_000n,
      inventoryReliefPoisha: 159_000n,
      variancePoisha: 3_000n,
    });

    // And the return leaves the average alone, at 32 units.
    expect(reduceBasis(afterDispatch, 3)).toEqual({ wacPoisha: 53_000n, qtyBasis: 32 });
  });
});

describe('reorder level', () => {
  it('fires only when a level is configured and availability reaches it', () => {
    expect(isBelowReorderLevel({ onHand: 4, reserved: 0 }, 5)).toBe(true);
    expect(isBelowReorderLevel({ onHand: 5, reserved: 0 }, 5)).toBe(true);
    expect(isBelowReorderLevel({ onHand: 6, reserved: 0 }, 5)).toBe(false);
    // Reserved units are not available, so a full shelf held for orders is low.
    expect(isBelowReorderLevel({ onHand: 20, reserved: 18 }, 5)).toBe(true);
    // No reorder level configured means no alert, rather than an alert on zero.
    expect(isBelowReorderLevel({ onHand: 0, reserved: 0 }, 0)).toBe(false);
  });
});

describe('the movement enum', () => {
  it('has §8’s twelve kinds and a direction for each', () => {
    expect(MOVEMENT_KINDS).toHaveLength(12);
    expect(INBOUND.length + OUTBOUND.length).toBe(11);
    expect(MOVEMENT_DIRECTION.count_correction).toBe('either');
  });
});
