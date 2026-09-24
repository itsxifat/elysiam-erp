import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { formatMoney } from './money.js';

/** M03 check 8, and the grouping rules around it. */

describe('check 8: formatMoney', () => {
  it('formats 12345678 poisha as ৳1,23,456.78', () => {
    expect(formatMoney(12345678)).toBe('৳1,23,456.78');
    expect(formatMoney(12345678n)).toBe('৳1,23,456.78');
    expect(formatMoney('12345678')).toBe('৳1,23,456.78');
  });

  it('groups by thousand, then lakh, then crore', () => {
    const cases: [bigint, string][] = [
      [0n, '৳0.00'],
      [5n, '৳0.05'],
      [99n, '৳0.99'],
      [100n, '৳1.00'],
      [99_999n, '৳999.99'],
      [100_000n, '৳1,000.00'],
      [9_999_999n, '৳99,999.99'],
      [10_000_000n, '৳1,00,000.00'],
      [1_000_000_000n, '৳1,00,00,000.00'],
      [123_456_789_012n, '৳1,23,45,67,890.12'],
      [900_000_000_000_000_0n, '৳9,00,00,00,00,00,000.00'],
    ];
    for (const [value, expected] of cases) expect(formatMoney(value), String(value)).toBe(expected);
  });

  it('puts the minus sign before the currency', () => {
    expect(formatMoney(-12345678)).toBe('-৳1,23,456.78');
    expect(formatMoney(-5)).toBe('-৳0.05');
  });

  it('renders Bangla digits for bn, and can omit the symbol', () => {
    expect(formatMoney(12345678, { locale: 'bn' })).toBe('৳১,২৩,৪৫৬.৭৮');
    expect(formatMoney(12345678, { symbol: false })).toBe('1,23,456.78');
  });

  it('refuses fractions of a poisha rather than rounding them', () => {
    expect(() => formatMoney(12.5)).toThrow(RangeError);
    expect(() => formatMoney('12.5')).toThrow(RangeError);
    expect(() => formatMoney(2 ** 53)).toThrow(RangeError);
  });

  it('keeps every digit: stripping the grouping gives back the amount', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: -(10n ** 16n), max: 10n ** 16n }), (value) => {
        const text = formatMoney(value).replace('৳', '').replace(/,/g, '').replace('.', '');
        expect(BigInt(text)).toBe(value);
      }),
      { numRuns: 1_000 },
    );
  });
});
