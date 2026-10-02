import { describe, expect, it } from 'vitest';

import { duration, signedPercent } from './format.js';

describe('the analytics formats', () => {
  it('signs growth, and leaves zero unsigned', () => {
    expect(signedPercent('5000')).toBe('+50.0%');
    expect(signedPercent('-1250')).toBe('−12.5%');
    expect(signedPercent('4')).toBe('0.0%');
    expect(signedPercent(null)).toBe('—');
  });

  it('writes a duration in seconds, then minutes and seconds', () => {
    const templates = { seconds: '{n} s', minutes: '{m} min {s} s' };
    expect(duration(45, templates)).toBe('45 s');
    expect(duration(725, templates)).toBe('12 min 5 s');
    expect(duration(null, templates)).toBe('—');
  });
});
