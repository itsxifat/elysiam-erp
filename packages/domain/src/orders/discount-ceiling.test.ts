import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { poisha } from '../money/index.js';
import {
  basisPointsAsPercent,
  discountAllowed,
  onlyShrinks,
  orderDiscountCeilingBps,
  typedDiscount,
  withinDiscountCeiling,
  type DiscountedLine,
  type DiscountedOrder,
} from './discount-ceiling.js';

const line = (overrides: Partial<Record<keyof DiscountedLine, bigint | number | string>>) =>
  ({
    skuId: String(overrides.skuId ?? 'A'),
    qty: Number(overrides.qty ?? 1),
    listPricePoisha: poisha(BigInt(overrides.listPricePoisha ?? 100_000)),
    unitPricePoisha: poisha(BigInt(overrides.unitPricePoisha ?? 100_000)),
    lineDiscountPoisha: poisha(BigInt(overrides.lineDiscountPoisha ?? 0)),
  }) as DiscountedLine;

const order = (lines: DiscountedLine[], orderDiscount = 0): DiscountedOrder => ({
  lines,
  orderDiscountPoisha: poisha(BigInt(orderDiscount)),
});

describe('the order desk discount ceiling (M30, D-364)', () => {
  it('counts a price under the list, a line discount and the order discount together', () => {
    const priced = order(
      [line({ qty: 2, unitPricePoisha: 90_000 }), line({ skuId: 'B', lineDiscountPoisha: 5_000 })],
      5_000,
    );
    expect(typedDiscount(priced)).toEqual({ listPoisha: 300_000n, discountPoisha: 30_000n });
    expect(withinDiscountCeiling(priced, 1_000)).toBe(true);
    expect(withinDiscountCeiling(priced, 999)).toBe(false);
  });

  it('never lets a markup on one line pay for a free one (the ledger audit, C-2)', () => {
    const priced = order([
      line({ unitPricePoisha: 200_000 }),
      line({ skuId: 'B', unitPricePoisha: 0 }),
    ]);
    // Priced together the two net to the list; the buyer would refuse A at the door.
    expect(typedDiscount(priced).discountPoisha).toBe(100_000n);
    expect(withinDiscountCeiling(priced, 2_000)).toBe(false);
  });

  it('holds each line to the ceiling, not only the order', () => {
    // 20% of the order, but 40% of line B: refusing A would leave B at 40% off.
    const priced = order([line({}), line({ skuId: 'B', unitPricePoisha: 60_000 })]);
    const total = typedDiscount(priced);
    expect(total.discountPoisha * 10_000n).toBe(2_000n * total.listPoisha);
    expect(withinDiscountCeiling(priced, 2_000)).toBe(false);
  });

  it('allows exactly the ceiling and refuses one poisha more', () => {
    expect(withinDiscountCeiling(order([line({ unitPricePoisha: 80_000 })]), 2_000)).toBe(true);
    expect(withinDiscountCeiling(order([line({ unitPricePoisha: 79_999 })]), 2_000)).toBe(false);
  });

  it('refuses a sales agent a free line and allows it to an org admin', () => {
    const free = order([line({ unitPricePoisha: 0 })]);
    const sales = orderDiscountCeilingBps({ isSuperAdmin: false, roles: ['sales'] });
    const admin = orderDiscountCeilingBps({ isSuperAdmin: false, roles: ['org_admin'] });
    expect(sales).toBe(2_000);
    expect(withinDiscountCeiling(free, sales)).toBe(false);
    expect(withinDiscountCeiling(free, admin)).toBe(true);
    // A role with no row prices at the list: warehouse edits addresses, not prices.
    expect(orderDiscountCeilingBps({ isSuperAdmin: false, roles: ['warehouse'] })).toBe(0);
    expect(orderDiscountCeilingBps({ isSuperAdmin: true, roles: [] })).toBe(10_000);
  });

  it('lets an edit shrink a deep discount, and refuses one that deepens or reshapes it', () => {
    const before = order([line({ qty: 2, unitPricePoisha: 50_000 })]);
    const fewer = order([line({ qty: 1, unitPricePoisha: 50_000 })]);
    expect(discountAllowed({ after: fewer, before, ceilingBps: 2_000 })).toBe(true);

    const more = order([line({ qty: 3, unitPricePoisha: 50_000 })]);
    expect(discountAllowed({ after: more, before, ceilingBps: 2_000 })).toBe(false);

    // The same total discount on another SKU (the ledger audit, W-3).
    const swapped = order([line({ skuId: 'B', qty: 1, unitPricePoisha: 0 })]);
    expect(onlyShrinks(before, swapped)).toBe(false);
    expect(discountAllowed({ after: swapped, before, ceilingBps: 2_000 })).toBe(false);

    // A new order has nothing to compare with.
    expect(discountAllowed({ after: fewer, ceilingBps: 2_000 })).toBe(false);
  });

  it('formats basis points without dividing money', () => {
    expect(basisPointsAsPercent(2_000)).toBe('20');
    expect(basisPointsAsPercent(2_050)).toBe('20.50');
    expect(basisPointsAsPercent(5)).toBe('0.05');
  });

  it('agrees with exact arithmetic on random orders, and no markup raises the allowance', () => {
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
        fc.integer({ min: 1, max: 5_000_000 }),
        (rows, orderDiscount, ceiling, markup) => {
          const lines = rows.map((row, index) =>
            line({
              skuId: `S${String(index)}`,
              qty: row.qty,
              listPricePoisha: row.list,
              unitPricePoisha: row.unit,
              lineDiscountPoisha: row.lineDiscount,
            }),
          );
          const priced = order(lines, orderDiscount);

          const shorts = rows.map((row) => {
            const short =
              BigInt(row.list * row.qty) - BigInt(row.unit * row.qty - row.lineDiscount);
            return short > 0n ? short : 0n;
          });
          const list = rows.reduce((total, row) => total + BigInt(row.list * row.qty), 0n);
          const discount = shorts.reduce((total, short) => total + short, BigInt(orderDiscount));
          expect(typedDiscount(priced)).toEqual({ listPoisha: list, discountPoisha: discount });

          const linesOk = rows.every(
            (row, index) =>
              (shorts[index] ?? 0n) * 10_000n <= BigInt(ceiling) * BigInt(row.list * row.qty),
          );
          const expected =
            linesOk && (discount === 0n || discount * 10_000n <= BigInt(ceiling) * list);
          expect(withinDiscountCeiling(priced, ceiling)).toBe(expected);

          // Adding a marked-up line never turns a refusal into an allowance.
          if (!expected) {
            const withMarkup = order(
              [
                ...lines,
                line({ skuId: 'MARKUP', listPricePoisha: 1, unitPricePoisha: 1 + markup }),
              ],
              orderDiscount,
            );
            expect(withinDiscountCeiling(withMarkup, ceiling)).toBe(false);
          }
        },
      ),
    );
  });
});
