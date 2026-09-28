import { allocate, sum, ZERO, type Poisha } from '../money/index.js';
import { InvestorsError } from './errors.js';

/**
 * Splitting a declared profit across investors (architecture §15, D-019).
 *
 * The whole reason this is a function in the domain rather than three lines in
 * the distributions service: **a percentage split is integer division, and
 * integer division has a remainder.** ৳100 across three equal investors is
 * 3,333.33 poisha each, and every naive implementation of that loses one
 * poisha:
 *
 *   - `floor(total * weight / totalWeight)` per investor loses up to n−1 poisha.
 *   - `round(...)` per investor loses or invents poisha, unpredictably.
 *   - giving the last investor `total − Σ others` sums correctly but quietly
 *     makes one named person the dustbin for every rounding error in the
 *     company's history.
 *
 * A lost poisha is not a rounding cosmetic here. The distribution posts **one**
 * debit to Profit distribution for the declared total and **one credit per
 * investor**, so parts that do not sum to the total produce an unbalanced
 * journal — refused by `validateJournalDraft` and again by the database. The
 * screen would then say "could not declare the distribution" for a reason
 * nobody could act on.
 *
 * So the split goes through `allocate`, which is largest-remainder: every part
 * is the floor, and the leftover poisha go one each to the largest remainders.
 * The parts sum to exactly the whole, for every total and every set of weights,
 * and `splitDistribution`'s property test is the assertion of that.
 *
 * **Deterministic, independent of input order.** The shares are sorted by
 * investor id before allocating, so the same declaration computed from a
 * differently-ordered query answers identically — `allocate` breaks a tie
 * between equal remainders by index, and an unsorted input would hand the spare
 * poisha to whoever the planner happened to return first. Two people
 * reconciling the same distribution must not get two answers.
 */

export interface InvestorShare {
  readonly investorId: string;
  /**
   * The investor's relative weight in this distribution.
   *
   * Unitless on purpose: the caller decides whether it is basis points of an
   * agreed profit share or poisha of capital contributed (D-019 leaves the
   * basis to the org). Only the ratios matter.
   */
  readonly weight: bigint;
}

export interface InvestorShareAmount extends InvestorShare {
  readonly amountPoisha: Poisha;
}

export function splitDistribution(
  total: Poisha,
  shares: readonly InvestorShare[],
): InvestorShareAmount[] {
  if (total <= 0n) {
    throw new InvestorsError('INVESTOR_SPLIT_INVALID', 'A distribution amount must be positive.');
  }
  if (shares.length === 0) {
    throw new InvestorsError(
      'INVESTOR_SPLIT_INVALID',
      'A distribution needs at least one participating investor.',
    );
  }

  const seen = new Set<string>();
  for (const share of shares) {
    const key = share.investorId.toLowerCase();
    if (seen.has(key)) {
      throw new InvestorsError(
        'INVESTOR_SPLIT_INVALID',
        'An investor appears twice in this distribution.',
      );
    }
    seen.add(key);
    if (share.weight < 0n) {
      throw new InvestorsError('INVESTOR_SPLIT_INVALID', 'A share cannot be negative.');
    }
  }
  if (shares.every((share) => share.weight === 0n)) {
    throw new InvestorsError(
      'INVESTOR_SPLIT_INVALID',
      'Every share is zero, so there is nothing to split by. Set the investors’ shares first.',
    );
  }

  // Sorted before allocating: this is what makes the remainder land in the same
  // place every time (see the note above).
  const ordered = [...shares].sort((a, b) =>
    a.investorId.toLowerCase() < b.investorId.toLowerCase() ? -1 : 1,
  );
  const parts = allocate(
    total,
    ordered.map((share) => share.weight),
  );

  const result = ordered.map((share, index) => ({
    investorId: share.investorId,
    weight: share.weight,
    amountPoisha: parts[index] ?? ZERO,
  }));

  // The post-condition, checked rather than trusted. `allocate` is tested and
  // property-tested, and this still runs: the one failure this module exists to
  // prevent is a distribution whose parts do not sum to the declared total, and
  // a silent poisha is worth a thrown error at the moment it appears rather than
  // an unbalanced journal three layers later.
  const allocated = sum(result.map((part) => part.amountPoisha));
  if (allocated !== total) {
    throw new InvestorsError(
      'INVESTOR_SPLIT_INVALID',
      `The split came to ${allocated.toString()} poisha, not ${total.toString()}.`,
    );
  }

  return result;
}
