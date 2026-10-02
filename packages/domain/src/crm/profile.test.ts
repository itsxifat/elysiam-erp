import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { poisha } from '../money/index.js';
import { averageOrderValue, favourites } from './index.js';

describe('averageOrderValue', () => {
  it.each([
    { ltv: 300_000, delivered: 3, aov: 100_000 },
    // 1000 / 3 = 333.33… rounds down; 1001 / 2 = 500.5 rounds half away from zero.
    { ltv: 1_000, delivered: 3, aov: 333 },
    { ltv: 1_001, delivered: 2, aov: 501 },
    { ltv: 0, delivered: 4, aov: 0 },
  ])('$ltv over $delivered delivered is $aov', ({ ltv, delivered, aov }) => {
    expect(averageOrderValue(poisha(ltv), delivered)).toBe(poisha(aov));
  });

  it('has no average for a buyer with nothing delivered, rather than a misleading zero', () => {
    expect(averageOrderValue(poisha(0), 0)).toBeNull();
  });

  it('refuses a count that is not a whole number of orders', () => {
    expect(() => averageOrderValue(poisha(100), -1)).toThrow(RangeError);
    expect(() => averageOrderValue(poisha(100), 1.5)).toThrow(RangeError);
  });

  it('is never off by more than half a poisha from the exact average', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 12n }),
        fc.integer({ min: 1, max: 10_000 }),
        (ltv, delivered) => {
          const aov = averageOrderValue(poisha(ltv), delivered);
          if (aov === null) return false;
          // |aov × n − ltv| ≤ n / 2, in integers.
          const error = aov * BigInt(delivered) - ltv;
          return 2n * (error < 0n ? -error : error) <= BigInt(delivered);
        },
      ),
    );
  });
});

describe('favourites', () => {
  it('ranks by units bought, summing a key across lines', () => {
    expect(
      favourites([
        { key: 'Kurta', units: 1 },
        { key: 'Panjabi', units: 2 },
        { key: 'Kurta', units: 2 },
        { key: 'Saree', units: 1 },
      ]),
    ).toEqual([
      { key: 'Kurta', units: 3 },
      { key: 'Panjabi', units: 2 },
      { key: 'Saree', units: 1 },
    ]);
  });

  it('skips lines with no key, and keeps only the top few', () => {
    expect(
      favourites(
        [
          { key: null, units: 9 },
          { key: 'M', units: 3 },
          { key: 'L', units: 2 },
          { key: 'XL', units: 1 },
        ],
        2,
      ),
    ).toEqual([
      { key: 'M', units: 3 },
      { key: 'L', units: 2 },
    ]);
  });

  it('gives the same answer whatever order the lines arrive in', () => {
    const line = fc.record({
      key: fc.option(fc.constantFrom('S', 'M', 'L', 'XL', 'Kurta', 'Saree'), { nil: null }),
      units: fc.integer({ min: 0, max: 20 }),
    });
    fc.assert(
      fc.property(fc.array(line, { maxLength: 30 }), (lines) => {
        const reversed = [...lines].reverse();
        expect(favourites(reversed)).toEqual(favourites(lines));
      }),
    );
  });
});
