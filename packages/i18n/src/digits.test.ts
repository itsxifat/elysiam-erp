import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { formatCount, groupSouthAsian } from './digits.js';
import { formatMoney } from './money.js';

/**
 * Digits and grouping (§24).
 *
 * `formatMoney` shares this module's helpers rather than carrying its own copy,
 * so the last test here is the one that matters most: money and counts group
 * identically, and neither can drift into Western thousands without the other.
 */

describe('groupSouthAsian', () => {
  it('groups the last three digits, then pairs', () => {
    expect(groupSouthAsian('1')).toBe('1');
    expect(groupSouthAsian('999')).toBe('999');
    expect(groupSouthAsian('1000')).toBe('1,000');
    expect(groupSouthAsian('100000')).toBe('1,00,000');
    expect(groupSouthAsian('10000000')).toBe('1,00,00,000');
    expect(groupSouthAsian('123456789')).toBe('12,34,56,789');
  });

  it('only ever inserts commas', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[1-9][0-9]{0,24}$/), (digits) => {
        const grouped = groupSouthAsian(digits);
        expect(grouped.replace(/,/g, '')).toBe(digits);
        if (digits.length > 3) expect(grouped).toMatch(/^\d{1,2}(,\d{2})*,\d{3}$/);
      }),
      { numRuns: 1_000 },
    );
  });
});

describe('formatCount', () => {
  it('groups whole counts, in Latin digits only', () => {
    expect(formatCount(0)).toBe('0');
    expect(formatCount(1_200)).toBe('1,200');
    expect(formatCount(10_000_000)).toBe('1,00,00,000');
    expect(formatCount(-45)).toBe('-45');
    expect(formatCount(1_200, 'en')).toBe('1,200');
    // Past `Number.MAX_SAFE_INTEGER`, which is why counts take a bigint at all.
    expect(formatCount(9_007_199_254_740_993n)).toBe('9,00,71,99,25,47,40,993');
  });

  /*
   * A fractional count means a division happened upstream that nobody meant —
   * 2.5 pieces, 1.5 orders — and rounding it here would hide the place that
   * produced it. Same reasoning as `formatMoney` refusing fractional poisha.
   */
  it('refuses a fraction rather than rounding it', () => {
    expect(() => formatCount(2.5)).toThrow(RangeError);
  });
});

describe('money and counts group the same way', () => {
  it('for every magnitude, because they share one implementation', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 20n }), (taka) => {
        const money = formatMoney(taka * 100n, { symbol: false });
        expect(money).toBe(`${formatCount(taka)}.00`);
      }),
      { numRuns: 500 },
    );
  });
});
