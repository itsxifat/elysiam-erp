import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { toIsoDate } from '../dates/index.js';
import { poisha, type Poisha } from '../money/index.js';
import { InvestorsError } from './errors.js';
import {
  assertWithdrawable,
  investorPosition,
  withdrawableFor,
  type CapitalLot,
  type PositionInput,
} from './position.js';

/**
 * An investor's position, and what it allows (architecture §15).
 *
 * The properties here guard the two ways this arithmetic goes wrong with real
 * money: a withdrawal that drains more than was ever put in, and a lock-in that
 * either freezes capital forever or releases it early.
 */

const TODAY = toIsoDate('2026-09-25');
const taka = (amount: number): Poisha => poisha(amount * 100);

function position(overrides: Partial<PositionInput> = {}) {
  return investorPosition({
    lots: [{ amountPoisha: taka(5_000_00), lockInUntil: null }],
    capitalPaidPoisha: [],
    declaredPoisha: [],
    profitPaidPoisha: [],
    onDate: TODAY,
    ...overrides,
  });
}

describe('investorPosition: capital and payable are separate balances', () => {
  it('keeps contributions apart from declared profit', () => {
    // §7 gives an investor an equity account and a liability account. Adding them
    // together would authorize a capital withdrawal out of undistributed profit.
    const result = position({
      lots: [{ amountPoisha: taka(10_00_000), lockInUntil: null }],
      declaredPoisha: [taka(50_000), taka(25_000)],
      profitPaidPoisha: [taka(20_000)],
    });
    expect(result.capitalPoisha).toBe(taka(10_00_000));
    expect(result.payablePoisha).toBe(taka(55_000));
    expect(withdrawableFor(result, 'capital')).toBe(taka(10_00_000));
    expect(withdrawableFor(result, 'profit')).toBe(taka(55_000));
  });

  it('reduces capital by what has been withdrawn from it', () => {
    const result = position({
      lots: [{ amountPoisha: taka(10_00_000), lockInUntil: null }],
      capitalPaidPoisha: [taka(2_00_000), taka(1_00_000)],
    });
    expect(result.capitalPoisha).toBe(taka(7_00_000));
    expect(result.contributedPoisha).toBe(taka(10_00_000));
  });
});

describe('investorPosition: lock-in is per contribution', () => {
  const lots: CapitalLot[] = [
    { amountPoisha: taka(5_00_000), lockInUntil: toIsoDate('2025-06-30') },
    { amountPoisha: taka(10_00_000), lockInUntil: toIsoDate('2027-08-31') },
  ];

  it('frees the matured lot and holds the one still inside its term', () => {
    // The failure a single `locked_until` on the investor row produces: either
    // the old money is frozen with the new, or the new money is released with
    // the old. Neither is what was agreed.
    const result = position({ lots });
    expect(result.capitalPoisha).toBe(taka(15_00_000));
    expect(result.lockedPoisha).toBe(taka(10_00_000));
    expect(result.withdrawableCapitalPoisha).toBe(taka(5_00_000));
  });

  it('treats the last day of a lock-in as over', () => {
    const onLastDay = investorPosition({
      lots: [{ amountPoisha: taka(1_000), lockInUntil: TODAY }],
      capitalPaidPoisha: [],
      declaredPoisha: [],
      profitPaidPoisha: [],
      onDate: TODAY,
    });
    expect(onLastDay.lockedPoisha).toBe(0n);
  });

  it('never reports more locked than is left after withdrawals', () => {
    // Withdraw the matured lot, and the locked figure must stay at the locked
    // lot rather than exceeding the capital that remains.
    const result = position({ lots, capitalPaidPoisha: [taka(5_00_000)] });
    expect(result.capitalPoisha).toBe(taka(10_00_000));
    expect(result.lockedPoisha).toBe(taka(10_00_000));
    expect(result.withdrawableCapitalPoisha).toBe(0n);
  });
});

describe('assertWithdrawable', () => {
  it('allows exactly the available amount and refuses one poisha more', () => {
    const result = position({ lots: [{ amountPoisha: taka(1_000), lockInUntil: null }] });
    expect(() => assertWithdrawable(result, 'capital', taka(1_000))).not.toThrow();
    expect(() => assertWithdrawable(result, 'capital', poisha(taka(1_000) + 1n))).toThrow(
      InvestorsError,
    );
  });

  it('says "locked" rather than "insufficient" when the money exists but is held', () => {
    const result = position({
      lots: [{ amountPoisha: taka(10_00_000), lockInUntil: toIsoDate('2027-08-31') }],
    });
    expect(() => assertWithdrawable(result, 'capital', taka(1_00_000))).toThrow(
      /inside its lock-in/,
    );
  });

  it('refuses profit that has not been declared', () => {
    expect(() => assertWithdrawable(position(), 'profit', taka(1))).toThrow(/declared profit/);
  });

  it('refuses a zero or negative amount', () => {
    expect(() => assertWithdrawable(position(), 'capital', poisha(0))).toThrow(/positive/);
  });

  it('never allows a withdrawal larger than what went in, for any history', () => {
    fc.assert(
      fc.property(
        fc.array(fc.bigInt({ min: 1n, max: 10_000_000n }), { minLength: 1, maxLength: 8 }),
        fc.array(fc.bigInt({ min: 1n, max: 10_000_000n }), { maxLength: 8 }),
        fc.bigInt({ min: 1n, max: 100_000_000n }),
        (contributions, declared, asked) => {
          const result = investorPosition({
            lots: contributions.map((amount) => ({
              amountPoisha: poisha(amount),
              lockInUntil: null,
            })),
            capitalPaidPoisha: [],
            declaredPoisha: declared.map((amount) => poisha(amount)),
            profitPaidPoisha: [],
            onDate: TODAY,
          });
          const contributed = contributions.reduce((a, b) => a + b, 0n);
          const declaredTotal = declared.reduce((a, b) => a + b, 0n);

          let allowed = true;
          try {
            assertWithdrawable(result, 'capital', poisha(asked));
          } catch {
            allowed = false;
          }
          expect(allowed).toBe(asked <= contributed);

          let profitAllowed = true;
          try {
            assertWithdrawable(result, 'profit', poisha(asked));
          } catch {
            profitAllowed = false;
          }
          expect(profitAllowed).toBe(asked <= declaredTotal);
        },
      ),
      { numRuns: 1_000 },
    );
  });
});
