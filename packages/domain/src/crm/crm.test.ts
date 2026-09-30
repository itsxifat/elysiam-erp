import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { toIsoDate } from '../dates/index.js';
import { poisha } from '../money/index.js';
import {
  dueOccasions,
  fallsOn,
  lapsedSince,
  rfm,
  RFM_SEGMENTS,
  segmentFor,
  type BuyerActivity,
} from './index.js';

const today = toIsoDate('2026-10-01');

function buyer(
  id: string,
  lastOrderOn: string | null,
  orders: number,
  spent: number,
): BuyerActivity {
  return {
    customerId: id,
    lastOrderOn: lastOrderOn === null ? null : toIsoDate(lastOrderOn),
    orders,
    spentPoisha: poisha(spent),
  };
}

describe('RFM segments (M16 check 1)', () => {
  it('names each score combination', () => {
    const table: readonly [number, number, number, string][] = [
      [5, 5, 5, 'champions'],
      [4, 4, 4, 'champions'],
      [3, 5, 2, 'loyal'],
      [5, 1, 1, 'new'],
      [4, 2, 3, 'promising'],
      [2, 4, 5, 'at_risk'],
      [1, 5, 5, 'at_risk'],
      [1, 1, 1, 'hibernating'],
      [2, 2, 3, 'hibernating'],
      [3, 3, 3, 'needs_attention'],
    ];
    for (const [r, f, m, segment] of table) {
      expect(segmentFor(r, f, m), `${String(r)}${String(f)}${String(m)}`).toBe(segment);
    }
  });

  it('ranks a brand’s buyers against each other', () => {
    const scores = rfm(
      [
        buyer('regular', '2026-09-28', 12, 2_400_000),
        buyer('first-timer', '2026-09-30', 1, 150_000),
        buyer('gone-quiet', '2026-03-02', 9, 1_900_000),
        buyer('one-off-long-ago', '2025-11-11', 1, 90_000),
        buyer('middling', '2026-07-15', 4, 600_000),
        buyer('never-delivered', null, 0, 0),
      ],
      today,
    );
    expect(scores.get('regular')?.segment).toBe('champions');
    expect(scores.get('first-timer')?.segment).toBe('new');
    expect(scores.get('gone-quiet')?.segment).toBe('at_risk');
    expect(scores.get('one-off-long-ago')?.segment).toBe('hibernating');
    expect(scores.get('never-delivered')).toEqual({
      recency: 0,
      frequency: 0,
      monetary: 0,
      segment: 'prospect',
    });
  });

  it('gives equal histories equal scores, whatever the order they arrive in', () => {
    const a = buyer('a', '2026-09-01', 3, 500_000);
    const b = buyer('b', '2026-09-01', 3, 500_000);
    const others = [buyer('c', '2026-01-01', 1, 1), buyer('d', '2026-09-30', 9, 9_000_000)];
    const forward = rfm([a, b, ...others], today);
    const backward = rfm([...others, b, a], today);
    expect(forward.get('a')).toEqual(forward.get('b'));
    expect(backward.get('a')).toEqual(forward.get('a'));
  });

  it('gives every buyer exactly one segment and scores within 1–5', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            daysAgo: fc.option(fc.integer({ min: 0, max: 900 }), { nil: null }),
            orders: fc.integer({ min: 0, max: 40 }),
            spent: fc.integer({ min: 0, max: 50_000_000 }),
          }),
          { minLength: 1, maxLength: 40 },
        ),
        (rows) => {
          const buyers = rows.map((row, index) =>
            buyer(
              `b${String(index)}`,
              row.daysAgo === null || row.orders === 0
                ? null
                : new Date(Date.parse(`${today}T00:00:00Z`) - row.daysAgo * 86_400_000)
                    .toISOString()
                    .slice(0, 10),
              row.daysAgo === null ? 0 : row.orders,
              row.spent,
            ),
          );
          const scores = rfm(buyers, today);
          expect(scores.size).toBe(buyers.length);
          for (const score of scores.values()) {
            expect(RFM_SEGMENTS).toContain(score.segment);
            if (score.segment !== 'prospect') {
              for (const value of [score.recency, score.frequency, score.monetary]) {
                expect(value >= 1 && value <= 5).toBe(true);
              }
            }
          }
        },
      ),
    );
  });

  it('computes the re-engagement cut-off on the calendar', () => {
    expect(lapsedSince(today, 90)).toBe('2026-07-03');
    expect(() => lapsedSince(today, 0)).toThrow(RangeError);
  });
});

describe('occasions', () => {
  it('matches month and day, ignoring the year', () => {
    expect(fallsOn('1994-10-01', today)).toBe(true);
    expect(fallsOn('1994-10-02', today)).toBe(false);
  });

  it('greets a leap-day birthday on 28 February in a year without a 29th', () => {
    expect(fallsOn('1996-02-29', toIsoDate('2027-02-28'))).toBe(true);
    expect(fallsOn('1996-02-29', toIsoDate('2028-02-28'))).toBe(false);
    expect(fallsOn('1996-02-29', toIsoDate('2028-02-29'))).toBe(true);
  });

  it('lists each buyer’s birthday and anniversary that fall today, with the year', () => {
    expect(
      dueOccasions(
        [
          {
            customerId: 'x',
            birthday: '1990-10-01',
            anniversary: '2015-10-01',
          },
          { customerId: 'y', birthday: '1990-05-01', anniversary: null },
          { customerId: 'z', birthday: null, anniversary: '2020-10-01' },
        ],
        today,
      ),
    ).toEqual([
      { customerId: 'x', occasion: 'birthday', year: 2026 },
      { customerId: 'x', occasion: 'anniversary', year: 2026 },
      { customerId: 'z', occasion: 'anniversary', year: 2026 },
    ]);
  });
});
