import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { addDays, businessDate, isIsoDate, periodForMonth, periodOf, toIsoDate } from './index.js';

/** Business dates (architecture §7, invariant 8, M03 check 7). */

describe('check 7: the business date is the Asia/Dhaka calendar date', () => {
  it('puts an event at 23:30 UTC on the 1st on the 2nd', () => {
    expect(businessDate(new Date('2026-09-01T23:30:00Z'))).toBe('2026-09-02');
  });

  it('turns over at 18:00 UTC, which is Dhaka midnight', () => {
    expect(businessDate(new Date('2026-09-01T17:59:59.999Z'))).toBe('2026-09-01');
    expect(businessDate(new Date('2026-09-01T18:00:00Z'))).toBe('2026-09-02');
  });

  it('moves the last evening of a month into the next month, and of a year into the next year', () => {
    expect(businessDate(new Date('2026-08-31T20:00:00Z'))).toBe('2026-09-01');
    expect(periodOf(businessDate(new Date('2026-08-31T20:00:00Z'))).month).toBe('2026-09');
    expect(businessDate(new Date('2026-12-31T18:30:00Z'))).toBe('2027-01-01');
  });

  it('is always the UTC date shifted by six hours (Bangladesh has no DST today)', () => {
    fc.assert(
      fc.property(
        fc.date({
          min: new Date('2010-01-01T00:00:00Z'),
          max: new Date('2040-01-01T00:00:00Z'),
          noInvalidDate: true,
        }),
        (instant) => {
          fc.pre(!Number.isNaN(instant.getTime()));
          const shifted = new Date(instant.getTime() + 6 * 60 * 60 * 1000);
          expect(businessDate(instant)).toBe(shifted.toISOString().slice(0, 10));
        },
      ),
      { numRuns: 2_000 },
    );
  });

  it('refuses an invalid instant', () => {
    expect(() => businessDate(new Date('nope'))).toThrow(RangeError);
  });
});

describe('calendar helpers', () => {
  it('knows real dates from impossible ones', () => {
    expect(isIsoDate('2026-02-28')).toBe(true);
    expect(isIsoDate('2028-02-29')).toBe(true);
    expect(isIsoDate('2026-02-29')).toBe(false);
    expect(isIsoDate('2026-13-01')).toBe(false);
    expect(isIsoDate('2026-9-1')).toBe(false);
    // Date.UTC maps years 0-99 into the 1900s; those are typos, not dates.
    expect(isIsoDate('0026-05-01')).toBe(false);
    expect(() => periodForMonth('0026-05')).toThrow(RangeError);
    expect(() => toIsoDate('2026-02-30')).toThrow(RangeError);
  });

  it('computes monthly periods, including February and December', () => {
    expect(periodForMonth('2026-02')).toEqual({
      month: '2026-02',
      startsOn: '2026-02-01',
      endsOn: '2026-02-28',
    });
    expect(periodForMonth('2028-02').endsOn).toBe('2028-02-29');
    expect(periodForMonth('2026-12').endsOn).toBe('2026-12-31');
    expect(periodOf(toIsoDate('2026-09-17')).startsOn).toBe('2026-09-01');
    expect(() => periodForMonth('2026-13')).toThrow(RangeError);
  });

  it('adds days across month and year ends', () => {
    expect(addDays(toIsoDate('2026-08-31'), 1)).toBe('2026-09-01');
    expect(addDays(toIsoDate('2026-01-01'), -1)).toBe('2025-12-31');
  });
});
