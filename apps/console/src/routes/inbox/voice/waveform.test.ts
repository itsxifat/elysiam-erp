import { describe, expect, it } from 'vitest';

import { clock, MIN_BAR, nextSpeed, peaks, seekFraction } from './waveform.js';

describe('a voice message’s waveform and clock (D-780)', () => {
  it('draws one bar per bucket, the loudest at full height', () => {
    const samples = new Float32Array(1000);
    samples[100] = 0.25;
    samples[900] = -0.5;
    const bars = peaks(samples, 10);
    expect(bars).toHaveLength(10);
    expect(bars[9]).toBe(1);
    expect(bars[1]).toBe(0.5);
    expect(bars[5]).toBe(MIN_BAR);
  });

  it('draws a flat low line for silence or nothing', () => {
    expect(peaks(new Float32Array(500), 4)).toEqual([MIN_BAR, MIN_BAR, MIN_BAR, MIN_BAR]);
    expect(peaks(new Float32Array(0), 3)).toEqual([MIN_BAR, MIN_BAR, MIN_BAR]);
  });

  it('formats lengths and cycles the speeds', () => {
    expect(clock(0)).toBe('0:00');
    expect(clock(65.9)).toBe('1:05');
    expect(clock(Number.NaN)).toBe('0:00');
    expect(nextSpeed(1)).toBe(1.5);
    expect(nextSpeed(1.5)).toBe(2);
    expect(nextSpeed(2)).toBe(1);
  });

  it('seeks within the clip, never outside it', () => {
    expect(seekFraction(50, 200)).toBe(0.25);
    expect(seekFraction(-5, 200)).toBe(0);
    expect(seekFraction(500, 200)).toBe(1);
    expect(seekFraction(10, 0)).toBe(0);
  });
});
