import { businessDate } from '@elysium/domain';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { formatDate, formatDateTime, formatMonth, formatTime, today } from './dates.js';

/**
 * Date presentation (invariant 8, §22, §24).
 *
 * The cases that earn their place here are the ones that have bitten this kind
 * of code before: a zoneless date shifted by a formatter, midnight rendered as
 * `24:00`, and Latin digits leaking into Bangla output.
 */

describe('formatDate', () => {
  it('writes day, month name, year in both locales', () => {
    expect(formatDate('2026-09-17')).toBe('17 Sep 2026');
    expect(formatDate('2026-09-17', { style: 'long' })).toBe('17 September 2026');
    expect(formatDate('2026-09-17', { locale: 'bn' })).toBe('১৭ সেপ্টে ২০২৬');
    expect(formatDate('2026-09-17', { locale: 'bn', style: 'long' })).toBe('১৭ সেপ্টেম্বর ২০২৬');
  });

  it('drops the day’s leading zero in prose but keeps it in the numeric form', () => {
    expect(formatDate('2026-09-07')).toBe('7 Sep 2026');
    expect(formatDate('2026-09-07', { style: 'numeric' })).toBe('07/09/2026');
    expect(formatDate('2026-09-07', { locale: 'bn', style: 'numeric' })).toBe('০৭/০৯/২০২৬');
  });

  /*
   * The bug this is here for: `new Date('2026-09-17')` is UTC midnight, so any
   * formatter given a zone west of Greenwich prints the 16th. A calendar date
   * has no zone, so this code path never builds a `Date` — and this test is
   * what notices if somebody "simplifies" it into one.
   */
  it('never shifts a calendar date, whatever the process time zone is', () => {
    expect(formatDate('2026-01-01', { style: 'numeric' })).toBe('01/01/2026');
    expect(formatDate('2026-12-31', { style: 'numeric' })).toBe('31/12/2026');
  });

  it('refuses a date that is not a real YYYY-MM-DD', () => {
    expect(() => formatDate('2026-02-30')).toThrow(RangeError);
    expect(() => formatDate('2026-9-1')).toThrow(RangeError);
    expect(() => formatDate('17/09/2026')).toThrow(RangeError);
  });

  it('puts no Latin digit in Bangla output, for any date', () => {
    fc.assert(
      fc.property(
        fc.date({ min: new Date('2020-01-01T00:00:00Z'), max: new Date('2039-12-31T00:00:00Z') }),
        fc.constantFrom('short' as const, 'long' as const, 'numeric' as const),
        (instant, style) => {
          fc.pre(!Number.isNaN(instant.getTime()));
          const text = formatDate(businessDate(instant), { locale: 'bn', style });
          expect(text).not.toMatch(/\d/);
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe('formatMonth', () => {
  it('formats the YYYY-MM a Period carries', () => {
    expect(formatMonth('2026-09')).toBe('Sep 2026');
    expect(formatMonth('2026-09', { style: 'long' })).toBe('September 2026');
    expect(formatMonth('2026-09', { style: 'numeric' })).toBe('09/2026');
    expect(formatMonth('2026-09', { locale: 'bn', style: 'long' })).toBe('সেপ্টেম্বর ২০২৬');
  });

  it('refuses a month that does not exist', () => {
    expect(() => formatMonth('2026-13')).toThrow(RangeError);
    expect(() => formatMonth('2026-9')).toThrow(RangeError);
  });
});

describe('formatTime and formatDateTime work in Dhaka wall clock', () => {
  it('shifts an instant by six hours', () => {
    expect(formatTime(new Date('2026-09-17T11:30:00Z'))).toBe('17:30');
    expect(formatTime(new Date('2026-09-17T11:30:00Z'), 'bn')).toBe('১৭:৩০');
  });

  /*
   * `hour12: false` renders midnight as `24:00` on several ICU versions, which
   * makes a 00:10 order look like it closed the previous day. `hourCycle: 'h23'`
   * is what keeps this `00:10`.
   */
  it('renders Dhaka midnight as 00, not 24', () => {
    expect(formatTime(new Date('2026-09-16T18:10:00Z'))).toBe('00:10');
  });

  it('uses the business date, so a late-evening UTC instant is already tomorrow', () => {
    const instant = new Date('2026-09-01T23:30:00Z');
    expect(businessDate(instant)).toBe('2026-09-02');
    expect(formatDateTime(instant)).toBe('2 Sep 2026, 05:30');
    expect(formatDateTime(instant, { locale: 'bn', style: 'long' })).toBe(
      '২ সেপ্টেম্বর ২০২৬, ০৫:৩০',
    );
  });

  it('refuses an invalid instant rather than printing Invalid Date', () => {
    expect(() => formatTime(new Date('nope'))).toThrow(RangeError);
    expect(() => formatDateTime(new Date('nope'))).toThrow(RangeError);
  });
});

describe('today()', () => {
  it('is the domain business date, not a second implementation of it', () => {
    const now = new Date('2026-08-31T20:00:00Z');
    expect(today(now)).toBe(businessDate(now));
    expect(today(now)).toBe('2026-09-01');
  });
});
