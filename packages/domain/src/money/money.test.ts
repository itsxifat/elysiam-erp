import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  abs,
  add,
  allocate,
  divideRounded,
  MAX_POISHA,
  MoneyError,
  mulQty,
  negate,
  parsePoisha,
  parseTaka,
  percentOf,
  poisha,
  sub,
  sum,
  takaParts,
  type Poisha,
} from './index.js';

/**
 * Money (architecture §7, M03 check 6).
 *
 * The rounding rule is checked against an independent formula rather than
 * against itself, and at every .5 boundary in both signs, because "round half
 * away from zero" and "round half up" agree on every positive input and
 * disagree on every negative one — which is where a refund lives.
 */

const amount = fc.bigInt({ min: -(10n ** 13n), max: 10n ** 13n }).map((value) => poisha(value));

/** Half away from zero, derived differently: floor((2|q| + d) / 2d), signed. */
function referenceRound(numerator: bigint, denominator: bigint): bigint {
  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const rounded = (2n * n + d) / (2n * d);
  return negative ? -rounded : rounded;
}

describe('poisha()', () => {
  it('accepts integers in every form amounts arrive in', () => {
    expect(poisha(12345678)).toBe(12345678n);
    expect(poisha('12345678')).toBe(12345678n);
    expect(poisha('-5')).toBe(-5n);
    expect(poisha(7n)).toBe(7n);
  });

  it('refuses anything that already lost precision', () => {
    expect(() => poisha(1.5)).toThrow(MoneyError);
    expect(() => poisha(Number.NaN)).toThrow(MoneyError);
    expect(() => poisha(2 ** 53)).toThrow(MoneyError);
    expect(() => poisha('12.5')).toThrow(MoneyError);
    expect(() => poisha('1e5')).toThrow(MoneyError);
    expect(() => poisha('')).toThrow(MoneyError);
    expect(() => poisha(' 1')).toThrow(MoneyError);
  });

  it('refuses amounts past ±9e15, and so do the operations', () => {
    expect(poisha(MAX_POISHA)).toBe(MAX_POISHA);
    expect(() => poisha(MAX_POISHA + 1n)).toThrow(/outside/);
    expect(() => add(poisha(MAX_POISHA), poisha(1n))).toThrow(MoneyError);
    expect(() => mulQty(poisha(MAX_POISHA), 2)).toThrow(MoneyError);
    // An intermediate overflow is not rescued by a later negative.
    expect(() => sum([poisha(MAX_POISHA), poisha(1n), poisha(-5n)])).toThrow(MoneyError);
  });
});

describe('add, sub, sum, negate, mulQty', () => {
  it('are exact integer arithmetic', () => {
    fc.assert(
      fc.property(amount, amount, (a, b) => {
        expect(add(a, b)).toBe(a + b);
        expect(sub(a, b)).toBe(a - b);
        expect(add(a, negate(a))).toBe(0n);
        expect(abs(a) >= 0n).toBe(true);
      }),
    );
  });

  it('sum of a list equals folding add over it', () => {
    fc.assert(
      fc.property(fc.array(amount, { maxLength: 40 }), (values) => {
        expect(sum(values)).toBe(values.reduce<bigint>((acc, value) => acc + value, 0n));
      }),
    );
  });

  it('multiplies by whole quantities only', () => {
    expect(mulQty(poisha(125_050), 3)).toBe(375_150n);
    expect(mulQty(poisha(125_050), 0n)).toBe(0n);
    expect(() => mulQty(poisha(100), 1.5)).toThrow(MoneyError);
  });
});

describe('check 6: rounding is half away from zero, tested at the .5 boundaries', () => {
  it('rounds exact halves away from zero in both signs', () => {
    expect(divideRounded(5n, 2n)).toBe(3n); // 2.5
    expect(divideRounded(-5n, 2n)).toBe(-3n); // -2.5
    expect(divideRounded(5n, -2n)).toBe(-3n);
    expect(divideRounded(15n, 10n)).toBe(2n); // 1.5
    expect(divideRounded(-15n, 10n)).toBe(-2n);
    expect(divideRounded(25n, 10n)).toBe(3n); // 2.5 is not banker's-rounded to 2
    expect(divideRounded(-25n, 10n)).toBe(-3n);
  });

  it('rounds just either side of .5 towards the nearer integer', () => {
    expect(divideRounded(2_4999n, 1_0000n)).toBe(2n);
    expect(divideRounded(2_5001n, 1_0000n)).toBe(3n);
    expect(divideRounded(-2_4999n, 1_0000n)).toBe(-2n);
    expect(divideRounded(-2_5001n, 1_0000n)).toBe(-3n);
  });

  it('percentOf rounds a half poisha away from zero', () => {
    // 1% of 50 poisha is 0.5 poisha.
    expect(percentOf(poisha(50), 100)).toBe(1n);
    expect(percentOf(poisha(-50), 100)).toBe(-1n);
    // 2.5% of 1,01,00 poisha is 252.5 poisha.
    expect(percentOf(poisha(10_100), 250)).toBe(253n);
    expect(percentOf(poisha(-10_100), 250)).toBe(-253n);
    // Just under the boundary: 0.49 poisha.
    expect(percentOf(poisha(49), 100)).toBe(0n);
    expect(percentOf(poisha(-49), 100)).toBe(0n);
  });

  it('percentOf worked examples a person can check', () => {
    // 15% of ৳1,234.56 = ৳185.184 -> ৳185.18
    expect(percentOf(poisha(123_456), 1_500)).toBe(18_518n);
    // 100% is the identity, 0% is zero.
    expect(percentOf(poisha(987_654), 10_000)).toBe(987_654n);
    expect(percentOf(poisha(987_654), 0)).toBe(0n);
  });

  it('percentOf agrees with an independently derived formula', () => {
    fc.assert(
      fc.property(amount, fc.integer({ min: -20_000, max: 20_000 }), (value, bp) => {
        expect(percentOf(value, bp)).toBe(referenceRound(value * BigInt(bp), 10_000n));
      }),
      { numRuns: 2_000 },
    );
  });

  it('divideRounded agrees with the reference for every sign combination', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -(10n ** 15n), max: 10n ** 15n }),
        fc.bigInt({ min: -(10n ** 6n), max: 10n ** 6n }).filter((d) => d !== 0n),
        (n, d) => {
          expect(divideRounded(n, d)).toBe(referenceRound(n, d));
        },
      ),
      { numRuns: 2_000 },
    );
  });
});

describe('check 6: allocate parts always sum exactly to the total', () => {
  const weights = fc.array(fc.integer({ min: 0, max: 1_000_000 }), { minLength: 1, maxLength: 12 });

  it('sums exactly, for any total and any weights', () => {
    fc.assert(
      fc.property(
        amount,
        weights.filter((list) => list.some((w) => w > 0)),
        (total, list) => {
          const parts = allocate(total, list);
          expect(parts).toHaveLength(list.length);
          expect(sum(parts)).toBe(total);
        },
      ),
      { numRuns: 2_000 },
    );
  });

  it('gives every part its floor share plus at most one poisha', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 12n }).map((value) => poisha(value)),
        weights.filter((list) => list.some((w) => w > 0)),
        (total, list) => {
          const weightSum = list.reduce((acc, w) => acc + BigInt(w), 0n);
          const parts = allocate(total, list);
          parts.forEach((part, index) => {
            const floor = (total * BigInt(list[index] ?? 0)) / weightSum;
            expect(part - floor === 0n || part - floor === 1n).toBe(true);
          });
        },
      ),
      { numRuns: 1_000 },
    );
  });

  it('gives a zero weight nothing, and splits a negative total like a positive one', () => {
    expect(allocate(poisha(100), [1, 0, 1])).toEqual([50n, 0n, 50n]);
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 10n ** 12n }).map((value) => poisha(value)),
        weights.filter((list) => list.some((w) => w > 0)),
        (total, list) => {
          expect(allocate(negate(total), list)).toEqual(allocate(total, list).map((p) => 0n - p));
        },
      ),
    );
  });

  it('hands the leftover poisha to the largest remainders, ties to the earlier part', () => {
    // 100 / 3 = 33.33 each: one leftover poisha, to the first part.
    expect(allocate(poisha(100), [1, 1, 1])).toEqual([34n, 33n, 33n]);
    // 1000 split 1:2:3 = 166.67, 333.33, 500: the leftover goes to part 0.
    expect(allocate(poisha(1000), [1, 2, 3])).toEqual([167n, 333n, 500n]);
    // ৳10.00 across 7 parts: 142.857… each, six leftovers? 7*142 = 994, so six.
    expect(allocate(poisha(1000), [1, 1, 1, 1, 1, 1, 1])).toEqual([
      143n,
      143n,
      143n,
      143n,
      143n,
      143n,
      142n,
    ]);
  });

  it('refuses weights it cannot split by', () => {
    expect(() => allocate(poisha(100), [])).toThrow(MoneyError);
    expect(() => allocate(poisha(100), [0, 0])).toThrow(MoneyError);
    expect(() => allocate(poisha(100), [1, -1])).toThrow(MoneyError);
    expect(() => allocate(poisha(100), [0.5, 1])).toThrow(MoneyError);
  });
});

describe('parse helpers', () => {
  it('reads taka the ways people write it', () => {
    const cases: [string, bigint][] = [
      ['1234.5', 123_450n],
      ['1,23,456.78', 12_345_678n],
      ['123,456.78', 12_345_678n],
      ['৳500', 50_000n],
      ['৳ 500.05', 50_005n],
      ['Tk 20', 2_000n],
      ['BDT 1,00,000', 10_000_000n],
      ['-৳3.25', -325n],
      ['0.01', 1n],
      ['৳১,২৩,৪৫৬.৭৮', 12_345_678n],
      ['  42  ', 4_200n],
    ];
    for (const [input, expected] of cases) expect(parseTaka(input), input).toBe(expected);
  });

  it('refuses what it would have to guess at', () => {
    for (const input of ['12.345', '1,2345', '12,34', 'abc', '', '1.2.3', '৳', '--5', '1e3']) {
      expect(() => parseTaka(input), input).toThrow(MoneyError);
    }
  });

  it('round-trips every amount through its taka rendering', () => {
    fc.assert(
      fc.property(amount, (value) => {
        const { negative, taka, poisha: paisa } = takaParts(value);
        const text = `${negative ? '-' : ''}${taka.toString()}.${paisa.toString().padStart(2, '0')}`;
        expect(parseTaka(text)).toBe(value);
      }),
    );
  });

  it('reads integer poisha strings from the API', () => {
    expect(parsePoisha('12345678')).toBe(12_345_678n);
    expect(() => parsePoisha('123.4')).toThrow(MoneyError);
  });

  it('keeps Poisha a distinct type from a bare bigint', () => {
    // Compile-time property: a bare bigint is not assignable to Poisha.
    // @ts-expect-error — must go through poisha().
    const bare: Poisha = 5n;
    expect(bare).toBe(5n);
  });
});
