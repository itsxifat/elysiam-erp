import { describe, expect, it } from 'vitest';

import { age, changeBps, percent, signedPercent, times } from './format.js';
import { niceTicks } from './trend-chart.js';

const words = { justNow: 'just now', minutes: 'min ago', hours: 'h ago', days: 'd ago' };

describe('rates and ratios from basis points', () => {
  it('reads basis points as percentages and ROAS as a multiple', () => {
    expect(percent('1040', 'en')).toBe('10.4%');
    expect(percent('5', 'en')).toBe('0.1%');
    expect(percent('0', 'en')).toBe('0.0%');
    expect(percent(null, 'en')).toBe('—');
    expect(times('25000', 'en')).toBe('2.50×');
    expect(times('12345', 'en')).toBe('1.23×');
    expect(signedPercent(1040n, 'en')).toBe('+10.4%');
    expect(signedPercent(-250n, 'en')).toBe('-2.5%');
  });

  it('measures change against a base, and has none without one', () => {
    expect(changeBps(110n, 100n)).toBe(1000n);
    expect(changeBps(90n, 100n)).toBe(-1000n);
    expect(changeBps(5n, 0n)).toBeNull();
  });

  it('says how old a figure is', () => {
    const now = new Date('2026-10-05T10:00:00Z');
    expect(age('2026-10-05T09:59:30Z', now, words, 'en')).toBe('just now');
    expect(age('2026-10-05T09:48:00Z', now, words, 'en')).toBe('12 min ago');
    expect(age('2026-10-05T07:00:00Z', now, words, 'en')).toBe('3 h ago');
    expect(age('2026-10-01T10:00:00Z', now, words, 'en')).toBe('4 d ago');
  });
});

describe('the trend chart’s axis', () => {
  it('ticks on clean numbers that reach the largest value', () => {
    expect(niceTicks(950)).toEqual([0, 250, 500, 750, 1000]);
    expect(niceTicks(7)).toEqual([0, 2, 4, 6, 8]);
    expect(niceTicks(0)).toEqual([0, 1]);
  });
});
