import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { poisha } from '../money/index.js';
import {
  discountAllowed,
  discountBasisPoints,
  orderDiscountCeilingBps,
  typedDiscount,
  withinDiscountCeiling,
  type DiscountedLine,
} from './discount-ceiling.js';

const line = (overrides: Partial<Record<keyof DiscountedLine, bigint | number>>) =>
  ({
    qty: Number(overrides.qty ?? 1),
    listPricePoisha: poisha(BigInt(overrides.listPricePoisha ?? 100_000)),
    unitPricePoisha: poisha(BigInt(overrides.unitPricePoisha ?? 100_000)),
    lineDiscountPoisha: poisha(BigInt(overrides.lineDiscountPoisha ?? 0)),
  }) as DiscountedLine;

describe('the order desk discount ceiling (M30, D-364)', () => {
  it('counts a price under the list, a line discount and the order discount together', () => {
    const discount = typedDiscount(
      [line({ qty: 2, unitPricePoisha: 90_000 }), line({ lineDiscountPoisha: 5_000 })],
      poisha(5_000n),
    );
    expect(discount).toEqual({ listPoisha: 300_000n, discountPoisha: 30_000n });
    expect(discountBasisPoints(discount)).toBe(1_000);
  });

  it('lets a markup on one line pay for a discount on another', () => {
    const discount = typedDiscount(
      [line({ unitPricePoisha: 130_000 }), line({ unitPricePoisha: 70_000 })],
      poisha(0n),
    );
    expect(discount.discountPoisha).toBe(0n);
    expect(withinDiscountCeiling(discount, 0)).toBe(true);
  });

  it('allows exactly the ceiling and refuses one poisha more', () => {
    const at = typedDiscount([line({ unitPricePoisha: 80_000 })], poisha(0n));
    expect(withinDiscountCeiling(at, 2_000)).toBe(true);
    const over = typedDiscount([line({ unitPricePoisha: 79_999 })], poisha(0n));
    expect(withinDiscountCeiling(over, 2_000)).toBe(false);
  });

  it('refuses a free line to a sales agent and allows it to an org admin', () => {
    const free = typedDiscount([line({ unitPricePoisha: 0 })], poisha(0n));
    const sales = orderDiscountCeilingBps({ isSuperAdmin: false, roles: ['sales'] });
    const admin = orderDiscountCeilingBps({ isSuperAdmin: false, roles: ['org_admin'] });
    expect(sales).toBe(2_000);
    expect(withinDiscountCeiling(free, sales)).toBe(false);
    expect(withinDiscountCeiling(free, admin)).toBe(true);
    // A role with no row prices at the list: warehouse edits addresses, not prices.
    expect(orderDiscountCeilingBps({ isSuperAdmin: false, roles: ['warehouse'] })).toBe(0);
    expect(orderDiscountCeilingBps({ isSuperAdmin: true, roles: [] })).toBe(10_000);
  });

  it('lets an edit keep a deep discount it did not add to, and refuses one that deepens it', () => {
    const before = typedDiscount([line({ qty: 2, unitPricePoisha: 50_000 })], poisha(0n));
    // One unit dropped: less given away than before.
    const fewer = typedDiscount([line({ qty: 1, unitPricePoisha: 50_000 })], poisha(0n));
    expect(discountAllowed({ after: fewer, before, ceilingBps: 2_000 })).toBe(true);
    // One more unit at the same half price: more given away.
    const more = typedDiscount([line({ qty: 3, unitPricePoisha: 50_000 })], poisha(0n));
    expect(discountAllowed({ after: more, before, ceilingBps: 2_000 })).toBe(false);
    // A new order has nothing to compare with.
    expect(discountAllowed({ after: fewer, ceilingBps: 2_000 })).toBe(false);
  });

  it('agrees with exact rational arithmetic on random orders', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            qty: fc.integer({ min: 1, max: 20 }),
            list: fc.integer({ min: 1, max: 5_000_000 }),
            unit: fc.integer({ min: 0, max: 6_000_000 }),
            lineDiscount: fc.integer({ min: 0, max: 100_000 }),
          }),
          { minLength: 1, maxLength: 8 },
        ),
        fc.integer({ min: 0, max: 500_000 }),
        fc.integer({ min: 0, max: 10_000 }),
        (rows, orderDiscount, ceiling) => {
          const lines = rows.map((row) =>
            line({
              qty: row.qty,
              listPricePoisha: row.list,
              unitPricePoisha: row.unit,
              lineDiscountPoisha: row.lineDiscount,
            }),
          );
          const discount = typedDiscount(lines, poisha(BigInt(orderDiscount)));
          const list = rows.reduce((total, row) => total + BigInt(row.list * row.qty), 0n);
          const charged =
            rows.reduce(
              (total, row) => total + BigInt(row.unit * row.qty) - BigInt(row.lineDiscount),
              0n,
            ) - BigInt(orderDiscount);
          expect(discount.discountPoisha).toBe(list - charged);
          const expected =
            list - charged <= 0n || (list - charged) * 10_000n <= BigInt(ceiling) * list;
          expect(withinDiscountCeiling(discount, ceiling)).toBe(expected);
          // Whole basis points, rounded up, never understate a discount under 100%.
          const bps = BigInt(discountBasisPoints(discount));
          if (discount.discountPoisha > 0n && bps < 10_000n) {
            expect(bps * list).toBeGreaterThanOrEqual(discount.discountPoisha * 10_000n);
          }
        },
      ),
    );
  });
});
