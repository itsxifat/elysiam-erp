import { describe, expect, it } from 'vitest';

import {
  asOfFrom,
  isIsoDate,
  monthRange,
  presetRange,
  previousMonth,
  rangeFrom,
} from './report-dates.js';

describe('business-date helpers for the money screens', () => {
  it('knows a real calendar date from a plausible-looking one', () => {
    expect(isIsoDate('2026-09-30')).toBe(true);
    expect(isIsoDate('2026-02-29')).toBe(false);
    expect(isIsoDate('2028-02-29')).toBe(true);
    expect(isIsoDate('2026-13-01')).toBe(false);
    expect(isIsoDate('30/09/2026')).toBe(false);
    expect(isIsoDate(undefined)).toBe(false);
  });

  it('gives a month its first and last day, February and December included', () => {
    expect(monthRange('2026-02')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(monthRange('2028-02')).toEqual({ from: '2028-02-01', to: '2028-02-29' });
    expect(monthRange('2026-12')).toEqual({ from: '2026-12-01', to: '2026-12-31' });
    expect(() => monthRange('2026-13')).toThrow(RangeError);
  });

  it('steps back across a year boundary', () => {
    expect(previousMonth('2026-01')).toBe('2025-12');
    expect(previousMonth('2026-10')).toBe('2026-09');
  });

  it('names the ranges a report offers, never past today', () => {
    const today = '2026-10-01';
    expect(presetRange('today', today)).toEqual({ from: today, to: today });
    expect(presetRange('thisMonth', today)).toEqual({ from: '2026-10-01', to: today });
    expect(presetRange('lastMonth', today)).toEqual({ from: '2026-09-01', to: '2026-09-30' });
    expect(presetRange('thisYear', today)).toEqual({ from: '2026-01-01', to: today });
  });

  it('opens a hand-edited link on a sensible range rather than an error', () => {
    const today = '2026-10-01';
    expect(rangeFrom({ from: '2026-08-01', to: '2026-08-31' }, today)).toEqual({
      from: '2026-08-01',
      to: '2026-08-31',
    });
    // Reversed, malformed or missing: this month.
    expect(rangeFrom({ from: '2026-08-31', to: '2026-08-01' }, today).from).toBe('2026-10-01');
    expect(rangeFrom({ from: 'yesterday', to: '2026-08-01' }, today).from).toBe('2026-10-01');
    expect(rangeFrom({}, today)).toEqual({ from: '2026-10-01', to: today });
    expect(asOfFrom({ asOf: '2026-02-30' }, today)).toBe(today);
    expect(asOfFrom({ asOf: '2026-06-30' }, today)).toBe('2026-06-30');
  });
});
