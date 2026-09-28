import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { poisha, sum, type Poisha } from '../money/index.js';
import { InvestorsError } from './errors.js';
import { splitDistribution, type InvestorShare } from './split.js';

/**
 * The profit split (architecture §15, D-019).
 *
 * The property below is the one this milestone is built around: **the parts sum
 * to exactly the declared total, for any set of shares and any amount.** It is a
 * property rather than a set of examples because the failure is arithmetic and
 * data-dependent — ৳100 across three investors loses a poisha, ৳100 across four
 * does not, and no hand-picked example set is going to contain the combination
 * that breaks. fast-check will find it in a few hundred tries.
 *
 * The consequence of losing one is not cosmetic. The distribution posts one debit
 * for the total and one credit per investor, so a split that is a poisha short
 * posts an unbalanced journal — refused by `validateJournalDraft`, refused again
 * by the database trigger, and surfaced to a person as "the distribution could
 * not be declared" with nothing they can do about it.
 */

const ID = (n: number): string => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;

/** Up to 12 investors with weights spanning zero to a large basis-point figure. */
const sharesArbitrary = fc
  .array(fc.bigInt({ min: 0n, max: 1_000_000n }), { minLength: 1, maxLength: 12 })
  .filter((weights) => weights.some((weight) => weight > 0n))
  .map((weights) => weights.map((weight, index) => ({ investorId: ID(index + 1), weight })));

/** ৳0.01 to ৳9,00,00,00,00,000 — the whole range `Poisha` allows. */
const totalArbitrary = fc.bigInt({ min: 1n, max: 9_000_000_000_000_000n }).map((v) => poisha(v));

describe('splitDistribution: the parts always sum to the whole', () => {
  it('for any total and any set of shares', () => {
    fc.assert(
      fc.property(totalArbitrary, sharesArbitrary, (total, shares) => {
        const parts = splitDistribution(total, shares);
        expect(sum(parts.map((part) => part.amountPoisha))).toBe(total);
      }),
      { numRuns: 2_000 },
    );
  });

  it('and every part is a whole, non-negative number of poisha within the total', () => {
    fc.assert(
      fc.property(totalArbitrary, sharesArbitrary, (total, shares) => {
        for (const part of splitDistribution(total, shares)) {
          expect(typeof part.amountPoisha).toBe('bigint');
          expect(part.amountPoisha >= 0n).toBe(true);
          expect(part.amountPoisha <= total).toBe(true);
        }
      }),
      { numRuns: 1_000 },
    );
  });

  it('gives an investor with a zero share nothing at all', () => {
    fc.assert(
      fc.property(totalArbitrary, sharesArbitrary, (total, shares) => {
        const withIdle = [...shares, { investorId: ID(99), weight: 0n }];
        const parts = splitDistribution(total, withIdle);
        const idle = parts.find((part) => part.investorId === ID(99));
        expect(idle?.amountPoisha).toBe(0n);
        // And the total is still whole: the extra participant changed nothing.
        expect(sum(parts.map((part) => part.amountPoisha))).toBe(total);
      }),
      { numRuns: 500 },
    );
  });

  it('is within one poisha of each investor’s exact share', () => {
    // Largest-remainder's actual guarantee, and the reason it is the right
    // method: nobody is more than a poisha away from their arithmetic share, so
    // the remainder is spread rather than dumped on one person.
    fc.assert(
      fc.property(totalArbitrary, sharesArbitrary, (total, shares) => {
        const weightSum = shares.reduce((acc, share) => acc + share.weight, 0n);
        for (const part of splitDistribution(total, shares)) {
          const floor = (total * part.weight) / weightSum;
          expect(part.amountPoisha === floor || part.amountPoisha === floor + 1n).toBe(true);
        }
      }),
      { numRuns: 1_000 },
    );
  });

  it('answers the same however the shares are ordered', () => {
    // A distribution recomputed from a differently-ordered query must not move a
    // poisha from one named investor to another.
    fc.assert(
      fc.property(totalArbitrary, sharesArbitrary, (total, shares) => {
        const forwards = splitDistribution(total, shares);
        const backwards = splitDistribution(total, [...shares].reverse());
        const byId = (parts: readonly { investorId: string; amountPoisha: Poisha }[]) =>
          new Map(parts.map((part) => [part.investorId, part.amountPoisha]));
        expect(byId(backwards)).toEqual(byId(forwards));
      }),
      { numRuns: 500 },
    );
  });
});

describe('splitDistribution: worked examples', () => {
  it('splits ৳100 three equal ways as 3334 / 3333 / 3333 poisha', () => {
    // 10,000 poisha / 3 = 3,333 each with 1 left over. Largest-remainder gives
    // it to the first by id — deterministically, not by luck of ordering.
    const shares: InvestorShare[] = [
      { investorId: ID(1), weight: 1n },
      { investorId: ID(2), weight: 1n },
      { investorId: ID(3), weight: 1n },
    ];
    expect(splitDistribution(poisha(10_000), shares).map((p) => p.amountPoisha)).toEqual([
      3_334n,
      3_333n,
      3_333n,
    ]);
  });

  it('splits ৳1,00,000 as 45% / 35% / 20% in basis points', () => {
    const shares: InvestorShare[] = [
      { investorId: ID(1), weight: 4_500n },
      { investorId: ID(2), weight: 3_500n },
      { investorId: ID(3), weight: 2_000n },
    ];
    expect(splitDistribution(poisha(10_000_000), shares).map((p) => p.amountPoisha)).toEqual([
      4_500_000n,
      3_500_000n,
      2_000_000n,
    ]);
  });

  it('splits by capital contributed when that is the basis', () => {
    // ৳7,00,000 and ৳3,00,000 of capital sharing a ৳1,000 profit: 700 / 300.
    const shares: InvestorShare[] = [
      { investorId: ID(1), weight: 70_000_000n },
      { investorId: ID(2), weight: 30_000_000n },
    ];
    expect(splitDistribution(poisha(100_000), shares).map((p) => p.amountPoisha)).toEqual([
      70_000n,
      30_000n,
    ]);
  });

  it('gives the single participant everything', () => {
    expect(
      splitDistribution(poisha(12_345), [{ investorId: ID(1), weight: 17n }]).map(
        (p) => p.amountPoisha,
      ),
    ).toEqual([12_345n]);
  });
});

describe('splitDistribution: refusals', () => {
  const one: InvestorShare[] = [{ investorId: ID(1), weight: 1n }];

  it('refuses a zero or negative total', () => {
    expect(() => splitDistribution(poisha(0), one)).toThrow(InvestorsError);
    expect(() => splitDistribution(poisha(-1), one)).toThrow(/positive/);
  });

  it('refuses a distribution with no participants', () => {
    expect(() => splitDistribution(poisha(100), [])).toThrow(/at least one/);
  });

  it('refuses shares that are all zero rather than inventing a basis', () => {
    // The tempting fallback is "split it equally", and it would be wrong: an org
    // that has not set its shares has not decided who gets what, and guessing
    // posts real money to real people on the strength of a default.
    expect(() =>
      splitDistribution(poisha(100), [
        { investorId: ID(1), weight: 0n },
        { investorId: ID(2), weight: 0n },
      ]),
    ).toThrow(/Every share is zero/);
  });

  it('refuses a negative share', () => {
    expect(() =>
      splitDistribution(poisha(100), [
        { investorId: ID(1), weight: 1n },
        { investorId: ID(2), weight: -1n },
      ]),
    ).toThrow(/cannot be negative/);
  });

  it('refuses the same investor twice, however it is spelled', () => {
    // Two lines for one investor would post two credits to one party and make
    // the distribution's own list disagree with the number of participants a
    // person approved.
    expect(() =>
      splitDistribution(poisha(100), [
        { investorId: ID(1), weight: 1n },
        { investorId: ID(1).toUpperCase(), weight: 1n },
      ]),
    ).toThrow(/twice/);
  });
});
