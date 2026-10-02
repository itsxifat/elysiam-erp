import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  rateBps,
  RETURN_REASON_CODES,
  sharesBps,
  summarizeReturns,
  type ReturnReasonCode,
  type ReturnSummaryRow,
} from './returns.js';

/**
 * Return-reason analytics (M17, D-237): the arithmetic behind the summary screen.
 *
 * The SQL groups and counts. These pin what is done with the counts: shares that add up
 * to exactly 100%, rates rounded once, and unexplained returns shown rather than hidden.
 */

const INSIDE = 'zone-inside';
const OUTSIDE = 'zone-outside';

const row = (
  outcome: 'delivered' | 'returned',
  count: number,
  zoneId: string | null,
  reason: ReturnReasonCode | null = null,
  channel = 'facebook',
): ReturnSummaryRow => ({ outcome, count, zoneId, reason, channel });

describe('summarizeReturns (M17, D-237)', () => {
  /*
   * Hand-computed:
   *
   *   Inside Dhaka:  90 delivered, 10 returned (6 refused, 4 size)   → 10.00%
   *   Outside Dhaka: 60 delivered, 40 returned (25 unreachable,
   *                  10 refused, 5 with no reason)                    → 40.00%
   *   All:           150 delivered, 50 returned                       → 25.00%
   *
   *   Reasons: unreachable 25 (50%), refused 16 (32%), unspecified 5 (10%),
   *            size 4 (8%)
   */
  const rows: ReturnSummaryRow[] = [
    row('delivered', 90, INSIDE),
    row('returned', 6, INSIDE, 'customer_refused'),
    row('returned', 4, INSIDE, 'size_issue', 'whatsapp'),
    row('delivered', 60, OUTSIDE),
    row('returned', 25, OUTSIDE, 'customer_unreachable'),
    row('returned', 10, OUTSIDE, 'customer_refused'),
    row('returned', 5, OUTSIDE, null),
  ];

  it('reproduces the hand-computed summary', () => {
    const summary = summarizeReturns(rows);
    expect(summary).toMatchObject({
      delivered: 150,
      returned: 50,
      returnRateBps: 2_500,
      unspecified: 5,
    });
    expect(summary.reasons).toEqual([
      { reason: 'customer_unreachable', count: 25, shareBps: 5_000 },
      { reason: 'customer_refused', count: 16, shareBps: 3_200 },
      { reason: null, count: 5, shareBps: 1_000 },
      { reason: 'size_issue', count: 4, shareBps: 800 },
    ]);
    expect(summary.zones).toEqual([
      {
        key: OUTSIDE,
        delivered: 60,
        returned: 40,
        returnRateBps: 4_000,
        topReason: 'customer_unreachable',
      },
      {
        key: INSIDE,
        delivered: 90,
        returned: 10,
        returnRateBps: 1_000,
        topReason: 'customer_refused',
      },
    ]);
    expect(summary.channels.map((channel) => [channel.key, channel.returned])).toEqual([
      ['facebook', 46],
      ['whatsapp', 4],
    ]);
  });

  it('is all zeros, not a division by zero, for an empty range', () => {
    expect(summarizeReturns([])).toEqual({
      delivered: 0,
      returned: 0,
      returnRateBps: 0,
      unspecified: 0,
      reasons: [],
      zones: [],
      channels: [],
    });
  });

  it('rounds a rate half up, once', () => {
    expect(rateBps(1, 3)).toBe(3_333);
    expect(rateBps(2, 3)).toBe(6_667);
    expect(rateBps(1, 8)).toBe(1_250);
    expect(rateBps(0, 0)).toBe(0);
    expect(() => rateBps(4, 3)).toThrow(RangeError);
  });

  it('property: reason shares always sum to exactly 10,000 bps', () => {
    fc.assert(
      fc.property(fc.array(fc.nat(10_000), { minLength: 1, maxLength: 13 }), (counts) => {
        const shares = sharesBps(counts);
        const total = counts.reduce((acc, count) => acc + count, 0);
        expect(shares.reduce((acc, share) => acc + share, 0)).toBe(total === 0 ? 0 : 10_000);
        shares.forEach((share, index) => {
          expect(share).toBeGreaterThanOrEqual(0);
          if ((counts[index] ?? 0) === 0) expect(share).toBe(0);
        });
      }),
      { numRuns: 300 },
    );
  });

  it('property: zone and channel totals both add back up to the whole', () => {
    const rowArb = fc.record({
      outcome: fc.constantFrom<'delivered' | 'returned'>('delivered', 'returned'),
      count: fc.nat(500),
      zoneId: fc.constantFrom<string | null>(INSIDE, OUTSIDE, null),
      reason: fc.constantFrom<ReturnReasonCode | null>(...RETURN_REASON_CODES, null),
      channel: fc.constantFrom('facebook', 'phone', 'website'),
    });
    fc.assert(
      fc.property(fc.array(rowArb, { maxLength: 30 }), (generated) => {
        const summary = summarizeReturns(generated);
        const zoneReturned = summary.zones.reduce((acc, zone) => acc + zone.returned, 0);
        const channelDelivered = summary.channels.reduce((acc, c) => acc + c.delivered, 0);
        const reasonCount = summary.reasons.reduce((acc, reason) => acc + reason.count, 0);
        expect(zoneReturned).toBe(summary.returned);
        expect(channelDelivered).toBe(summary.delivered);
        expect(reasonCount).toBe(summary.returned);
      }),
      { numRuns: 300 },
    );
  });
});
