import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { addDays, toIsoDate, type IsoDate } from '../dates/index.js';
import { poisha, ZERO } from '../money/index.js';
import {
  ageOpenItems,
  LEDGER_AGING_BUCKETS,
  ledgerAgingBucketOf,
  type PartyMovement,
} from './aging.js';

const AS_OF = toIsoDate('2026-10-01');

function daysAgo(days: number): IsoDate {
  return addDays(AS_OF, -days);
}

function bill(days: number, amount: number): PartyMovement {
  return { businessDate: daysAgo(days), increasePoisha: poisha(amount), decreasePoisha: ZERO };
}

function payment(days: number, amount: number): PartyMovement {
  return { businessDate: daysAgo(days), increasePoisha: ZERO, decreasePoisha: poisha(amount) };
}

describe('ageOpenItems', () => {
  it('ages what is still open, not every line: a part-paid old bill stays old', () => {
    const aged = ageOpenItems([bill(40, 1000), payment(3, 400)], AS_OF);

    expect(aged.buckets).toEqual({ '0-7': 0n, '8-30': 0n, '31-60': 600n, '60+': 0n });
    expect(aged.unappliedPoisha).toBe(0n);
    expect(aged.balancePoisha).toBe(600n);
  });

  it('settles the oldest bill first', () => {
    const aged = ageOpenItems(
      [bill(70, 100), bill(40, 200), bill(10, 300), payment(1, 250)],
      AS_OF,
    );

    // 250 clears the 100 from 70 days ago and 150 of the 200 from 40.
    expect(aged.buckets).toEqual({ '0-7': 0n, '8-30': 300n, '31-60': 50n, '60+': 0n });
    expect(aged.balancePoisha).toBe(350n);
  });

  it('lets an advance be taken up by the next bill, and ages only what is left', () => {
    const aged = ageOpenItems([payment(20, 500), bill(10, 800)], AS_OF);

    expect(aged.buckets).toEqual({ '0-7': 0n, '8-30': 300n, '31-60': 0n, '60+': 0n });
    expect(aged.unappliedPoisha).toBe(0n);
  });

  it('carries an overpayment as unapplied, never as a negative bucket', () => {
    const aged = ageOpenItems([bill(5, 100), payment(2, 150)], AS_OF);

    expect(aged.buckets).toEqual({ '0-7': 0n, '8-30': 0n, '31-60': 0n, '60+': 0n });
    expect(aged.unappliedPoisha).toBe(50n);
    expect(aged.balancePoisha).toBe(-50n);
  });

  it('matches a bill and its payment on the same day to each other', () => {
    const aged = ageOpenItems(
      [bill(90, 100), { ...bill(4, 70), decreasePoisha: poisha(70) }],
      AS_OF,
    );

    expect(aged.buckets['60+']).toBe(100n);
    expect(aged.buckets['0-7']).toBe(0n);
  });

  it('leaves out anything after the as-of date', () => {
    const aged = ageOpenItems([bill(10, 100), bill(-3, 999), payment(-1, 100)], AS_OF);

    expect(aged.balancePoisha).toBe(100n);
    expect(aged.buckets['8-30']).toBe(100n);
  });

  it('puts the edges where §7 does', () => {
    expect([0, 7, 8, 30, 31, 60, 61].map(ledgerAgingBucketOf)).toEqual([
      '0-7',
      '0-7',
      '8-30',
      '8-30',
      '31-60',
      '31-60',
      '60+',
    ]);
  });

  it('refuses a negative movement, which would mean the caller mixed up the sides', () => {
    expect(() =>
      ageOpenItems(
        [{ businessDate: AS_OF, increasePoisha: -1n as never, decreasePoisha: ZERO }],
        AS_OF,
      ),
    ).toThrow(RangeError);
  });
});

const movementArb = fc.record({
  days: fc.integer({ min: 0, max: 120 }),
  increase: fc.bigInt({ min: 0n, max: 5_000_000n }),
  decrease: fc.bigInt({ min: 0n, max: 5_000_000n }),
});

function toMovements(
  rows: readonly { days: number; increase: bigint; decrease: bigint }[],
): PartyMovement[] {
  return rows.map((row) => ({
    businessDate: daysAgo(row.days),
    increasePoisha: poisha(row.increase),
    decreasePoisha: poisha(row.decrease),
  }));
}

describe('ageOpenItems properties', () => {
  it('keeps the balance: open amounts less unapplied is everything owed less everything settled', () => {
    fc.assert(
      fc.property(fc.array(movementArb, { maxLength: 40 }), (rows) => {
        const aged = ageOpenItems(toMovements(rows), AS_OF);
        const owed = rows.reduce((total, row) => total + row.increase - row.decrease, 0n);
        const open = LEDGER_AGING_BUCKETS.reduce(
          (total, bucket) => total + aged.buckets[bucket],
          0n,
        );

        expect(aged.balancePoisha).toBe(owed);
        expect(open - aged.unappliedPoisha).toBe(owed);
      }),
    );
  });

  it('never shows a negative bucket, and never an open amount beside an unapplied one', () => {
    fc.assert(
      fc.property(fc.array(movementArb, { maxLength: 40 }), (rows) => {
        const aged = ageOpenItems(toMovements(rows), AS_OF);
        const open = LEDGER_AGING_BUCKETS.reduce(
          (total, bucket) => total + aged.buckets[bucket],
          0n,
        );

        for (const bucket of LEDGER_AGING_BUCKETS) expect(aged.buckets[bucket] >= 0n).toBe(true);
        expect(aged.unappliedPoisha >= 0n).toBe(true);
        expect(open === 0n || aged.unappliedPoisha === 0n).toBe(true);
      }),
    );
  });

  it('gives the same answer whatever order or grouping the rows arrive in', () => {
    fc.assert(
      fc.property(
        fc
          .array(
            movementArb.map((row) => ({ ...row, days: row.days % 15 })),
            { maxLength: 30 },
          )
          .chain((rows) =>
            fc.tuple(fc.constant(rows), fc.shuffledSubarray(rows, { minLength: rows.length })),
          ),
        ([rows, shuffled]) => {
          // Several rows on one date included: a party with two accounts sends
          // one row per account per day.
          expect(ageOpenItems(toMovements(shuffled), AS_OF)).toEqual(
            ageOpenItems(toMovements(rows), AS_OF),
          );
        },
      ),
    );
  });

  it('with nothing settled, ages each amount by its own date', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            days: fc.integer({ min: 0, max: 120 }),
            increase: fc.bigInt({ min: 0n, max: 5_000_000n }),
          }),
          { maxLength: 30 },
        ),
        (rows) => {
          const aged = ageOpenItems(
            toMovements(rows.map((row) => ({ ...row, decrease: 0n }))),
            AS_OF,
          );
          for (const bucket of LEDGER_AGING_BUCKETS) {
            const expected = rows
              .filter((row) => ledgerAgingBucketOf(row.days) === bucket)
              .reduce((total, row) => total + row.increase, 0n);
            expect(aged.buckets[bucket]).toBe(expected);
          }
        },
      ),
    );
  });

  it('settles oldest first: what stays open is the newest part of what was owed', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            days: fc.integer({ min: 1, max: 120 }),
            increase: fc.bigInt({ min: 1n, max: 5_000_000n }),
          }),
          { minLength: 1, maxLength: 20 },
        ),
        fc.bigInt({ min: 0n, max: 50_000_000n }),
        (bills, paid) => {
          const movements = toMovements(bills.map((row) => ({ ...row, decrease: 0n })));
          movements.push({
            businessDate: AS_OF,
            increasePoisha: ZERO,
            decreasePoisha: poisha(paid),
          });
          const aged = ageOpenItems(movements, AS_OF);

          // Reference: walk the bills newest first, keeping amounts until the open
          // total is reached. Every kept amount must sit in its own date's bucket.
          const owed = bills.reduce((total, row) => total + row.increase, 0n);
          let remaining = owed > paid ? owed - paid : 0n;
          const expected = { '0-7': 0n, '8-30': 0n, '31-60': 0n, '60+': 0n };
          const newestFirst = bills
            .map((row, index) => ({ ...row, index }))
            .sort((left, right) => left.days - right.days || right.index - left.index);
          for (const row of newestFirst) {
            if (remaining === 0n) break;
            const kept = row.increase < remaining ? row.increase : remaining;
            expected[ledgerAgingBucketOf(row.days)] += kept;
            remaining -= kept;
          }

          expect(aged.buckets).toEqual(expected);
        },
      ),
    );
  });
});
