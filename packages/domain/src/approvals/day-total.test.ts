import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { requiresApproval, requiresApprovalForDay, type Threshold } from './index.js';

/**
 * The day's running total against a threshold (M30's C7, D-415).
 *
 * The property that matters is the attack's: however a sum at or above the threshold is cut
 * into pieces and paid one after another on the same day, at least one piece is held.
 */

const TYPE = 'supplier_payment';
const at = (thresholdPoisha: bigint): Threshold[] => [{ type: TYPE, thresholdPoisha }];

describe('requiresApprovalForDay', () => {
  it('holds the payment that takes the day across the threshold, and says why', () => {
    const thresholds = at(10_000n);
    expect(
      requiresApprovalForDay({
        type: TYPE,
        amountPoisha: 4_000n,
        thresholds,
        earlierTodayPoisha: 5_000n,
      }),
    ).toEqual({ required: false, heldByDayTotal: false });
    expect(
      requiresApprovalForDay({
        type: TYPE,
        amountPoisha: 4_000n,
        thresholds,
        earlierTodayPoisha: 6_000n,
      }),
    ).toEqual({ required: true, heldByDayTotal: true });
    // On its own it would already need a checker: held, but not because of the day.
    expect(
      requiresApprovalForDay({
        type: TYPE,
        amountPoisha: 12_000n,
        thresholds,
        earlierTodayPoisha: 0n,
      }),
    ).toEqual({ required: true, heldByDayTotal: false });
  });

  it('fails closed exactly as requiresApproval does', () => {
    // No threshold configured, an amount-less type, a type no threshold may exempt.
    expect(
      requiresApprovalForDay({
        type: TYPE,
        amountPoisha: 1n,
        thresholds: [],
        earlierTodayPoisha: 0n,
      }).required,
    ).toBe(true);
    expect(
      requiresApprovalForDay({
        type: TYPE,
        amountPoisha: null,
        thresholds: at(10_000n),
        earlierTodayPoisha: 0n,
      }).required,
    ).toBe(true);
    expect(
      requiresApprovalForDay({
        type: TYPE,
        amountPoisha: 1n,
        thresholds: at(10_000n),
        alwaysRequired: true,
        earlierTodayPoisha: 0n,
      }),
    ).toEqual({ required: true, heldByDayTotal: false });
  });

  it('with nothing earlier today, agrees with requiresApproval', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 10n ** 12n }),
        fc.bigInt({ min: 1n, max: 10n ** 12n }),
        (amount, threshold) => {
          const input = { type: TYPE, amountPoisha: amount, thresholds: at(threshold) };
          expect(requiresApprovalForDay({ ...input, earlierTodayPoisha: 0n }).required).toBe(
            requiresApproval(input),
          );
        },
      ),
    );
  });

  it('never waves through what the payment alone would hold (monotone in the day)', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 10n ** 12n }),
        fc.bigInt({ min: 0n, max: 10n ** 12n }),
        fc.bigInt({ min: 1n, max: 10n ** 12n }),
        (amount, earlier, threshold) => {
          const input = { type: TYPE, amountPoisha: amount, thresholds: at(threshold) };
          if (requiresApproval(input)) {
            expect(requiresApprovalForDay({ ...input, earlierTodayPoisha: earlier }).required).toBe(
              true,
            );
          }
        },
      ),
    );
  });

  it('holds at least one piece of any split of a sum at or above the threshold', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 2n, max: 10n ** 9n }),
        fc.array(fc.bigInt({ min: 1n, max: 10n ** 9n }), { minLength: 1, maxLength: 30 }),
        (threshold, pieces) => {
          const total = pieces.reduce((sum, piece) => sum + piece, 0n);
          fc.pre(total >= threshold);

          // Paid one after another; a held piece does not count towards the day (a checker
          // looks at it), so the running total is what was posted unheld.
          let postedUnheld = 0n;
          let held = 0;
          for (const piece of pieces) {
            const decision = requiresApprovalForDay({
              type: TYPE,
              amountPoisha: piece,
              thresholds: at(threshold),
              earlierTodayPoisha: postedUnheld,
            });
            if (decision.required) held += 1;
            else postedUnheld += piece;
          }
          expect(held).toBeGreaterThan(0);
          // And what went through without a checker stays under the threshold.
          expect(postedUnheld < threshold).toBe(true);
        },
      ),
    );
  });
});
