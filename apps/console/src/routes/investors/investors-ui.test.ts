import { describe, expect, it } from 'vitest';

import { investorsEn, investorsMessages } from './messages.js';
import { bpsFromPercent, lastFinishedMonth, percentOfBps } from './share.js';

/**
 * The investor screens' pure pieces.
 *
 * The rest of these screens is React talking to endpoints the server suite already
 * covers. These are the bits that can be wrong on their own, and each has a failure
 * mode a manual click-through would not show:
 *
 * - a missing Bangla key throws at render time, on whichever screen happens to need
 *   it, for whichever user switched language;
 * - a profit share that survives a round trip through the form as 11.99% instead of
 *   12% pays the wrong amount for as long as nobody re-reads it;
 * - a default month that has not ended yet makes the declare dialog open pre-filled
 *   with a month the server will refuse.
 */

describe('the investor catalogue', () => {
  it('has the same keys in bn as in en', () => {
    expect(Object.keys(investorsMessages.bn).sort()).toEqual(Object.keys(investorsEn).sort());
  });

  it('has a non-empty value for every key in both locales', () => {
    const empty: string[] = [];
    for (const [locale, catalogue] of Object.entries(investorsMessages)) {
      for (const [key, value] of Object.entries(catalogue)) {
        if (value.trim() === '') empty.push(`${locale}:${key}`);
      }
    }
    expect(empty).toEqual([]);
  });
});

describe('the profit share, in basis points', () => {
  it('formats exactly, with no binary rounding', () => {
    expect(percentOfBps(1_250)).toBe('12.50%');
    expect(percentOfBps(700)).toBe('7.00%');
    expect(percentOfBps(10_000)).toBe('100.00%');
    expect(percentOfBps(0)).toBe('0.00%');
    expect(percentOfBps(1)).toBe('0.01%');
  });

  it('parses what it formats, for every share an investor can hold', () => {
    /*
     * Exhaustive rather than sampled, and cheap at 10,001 cases: the round trip is
     * the property that matters — the form shows a percentage and sends basis
     * points, so anything lost in either direction is a share that quietly changed
     * when somebody opened the dialog and saved it again. `fast-check` is not a
     * dependency of this app, and here it would sample a space small enough to
     * enumerate.
     */
    const wrong: string[] = [];
    for (let bps = 0; bps <= 10_000; bps += 1) {
      const shown = percentOfBps(bps).replace('%', '');
      if (bpsFromPercent(shown) !== bps) wrong.push(`${String(bps)} → ${shown}`);
    }
    expect(wrong).toEqual([]);
  });

  it('reads a percentage a person typed, however they typed it', () => {
    expect(bpsFromPercent('12.5')).toBe(1_250);
    expect(bpsFromPercent('12')).toBe(1_200);
    expect(bpsFromPercent('0.07')).toBe(7);
    expect(bpsFromPercent('100')).toBe(10_000);
  });
});

describe('the month the declare dialog opens on', () => {
  it('is always a month that has already ended', () => {
    const month = lastFinishedMonth();
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Dhaka',
      year: 'numeric',
      month: '2-digit',
    }).format(new Date());
    // Strictly before this month: the server refuses a distribution for a month
    // whose profit is not known yet, and a pre-filled form that always fails is
    // worse than an empty one.
    expect(month < today).toBe(true);
    expect(month).toMatch(/^\d{4}-(0[1-9]|1[0-2])$/);
  });
});
