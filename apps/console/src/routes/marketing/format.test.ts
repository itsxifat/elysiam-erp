import { describe, expect, it } from 'vitest';

import { daysInclusive, dhakaToday, monthStart, percent, roas } from './format.js';

describe('marketing ratios as shown', () => {
  it('places the decimal point in ROAS without rounding twice', () => {
    expect(roas('6625')).toBe('0.66×');
    expect(roas('10400')).toBe('1.04×');
    expect(roas('0')).toBe('0.00×');
    expect(roas(null)).toBe('—');
  });

  it('shows a rate to one decimal', () => {
    expect(percent('2500')).toBe('25.0%');
    expect(percent('1429')).toBe('14.3%');
    expect(percent('3333')).toBe('33.3%');
    expect(percent('10000')).toBe('100.0%');
    expect(percent(null)).toBe('—');
  });

  it('reads today in Dhaka, not in the browser’s zone', () => {
    // 20:00 UTC on 30 September is 02:00 on 1 October in Dhaka.
    expect(dhakaToday(new Date('2026-09-30T20:00:00Z'))).toBe('2026-10-01');
    expect(monthStart('2026-10-17')).toBe('2026-10-01');
    expect(daysInclusive('2026-09-01', '2026-09-30')).toBe(30);
  });
});
