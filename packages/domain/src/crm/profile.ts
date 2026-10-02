import { divideRounded, poisha, type Poisha } from '../money/index.js';

/**
 * What a buyer profile says about one buyer (architecture §10 "Buyer stats"; M16).
 *
 * The arithmetic the profile shows, kept here so the rounding and the ranking are one rule
 * each (invariant 11). The server reads the counters and the lines; these decide what they
 * mean.
 */

/**
 * Average order value: lifetime value over delivered orders, rounded once.
 *
 * Over *delivered* orders because that is what LTV is the sum of — dividing it by every
 * order taken would let a buyer's cancellations and returns lower an average of what they
 * actually kept. `null` for a buyer with nothing delivered yet: there is no average of
 * nothing, and a 0 would read as "spends nothing".
 */
export function averageOrderValue(ltvPoisha: Poisha, delivered: number): Poisha | null {
  if (!Number.isSafeInteger(delivered) || delivered < 0) {
    throw new RangeError('A delivered count is a whole number, zero or more.');
  }
  if (delivered === 0) return null;
  return poisha(divideRounded(ltvPoisha, BigInt(delivered)));
}

export interface Bought {
  /** The category name or size label the units were bought under; null when it has none. */
  readonly key: string | null;
  readonly units: number;
}

export interface Favourite {
  readonly key: string;
  readonly units: number;
}

/**
 * A buyer's favourite categories, or sizes: the keys they bought the most units of.
 *
 * Units, not orders, because "she buys mediums" is about what is in the parcels. Keys with
 * no value (a SKU with no size) are skipped rather than counted as a favourite called
 * nothing. Ties break by name so the same history always gives the same answer, whatever
 * order the rows arrived in.
 */
export function favourites(bought: readonly Bought[], top = 3): Favourite[] {
  if (!Number.isSafeInteger(top) || top < 1) throw new RangeError('At least one favourite.');
  const totals = new Map<string, number>();
  for (const { key, units } of bought) {
    if (key === null || units <= 0) continue;
    totals.set(key, (totals.get(key) ?? 0) + units);
  }
  return [...totals]
    .map(([key, units]) => ({ key, units }))
    .sort((a, b) => b.units - a.units || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .slice(0, top);
}
