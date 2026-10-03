import type { Poisha } from '../money/index.js';
import { VariantMatrixError, type VariantCombination } from './variant-matrix.js';

/**
 * Which price each new variant starts at (D-422).
 *
 * The new-product form lets somebody price one size above the rest — XXL at ৳1,590 when
 * the shirt is ৳1,490 — before any SKU exists. The form cannot name a SKU id yet, so an
 * override names its combination by **value ids**: `[red, XXL]`. Value ids are unique
 * across a brand, so the set of them is the combination whatever order the axes are in.
 *
 * Two refusals, both of which would otherwise be silent:
 *
 * - an override that matches no combination the matrix produces (a value that is not on
 *   any axis, or one axis left out), because the price somebody typed would simply not
 *   be applied and the SKU would quietly start at the base price;
 * - two overrides for the same combination, because one of the two prices would win and
 *   nobody chose which.
 */

export interface VariantPriceOverride {
  readonly valueIds: readonly string[];
  readonly pricePoisha: Poisha;
}

function setKey(valueIds: readonly string[]): string {
  return [...valueIds].sort().join('|');
}

/** The price for every combination, keyed by its variant key. */
export function variantPrices(
  combinations: readonly VariantCombination[],
  base: Poisha,
  overrides: readonly VariantPriceOverride[],
): Map<string, Poisha> {
  const byValues = new Map<string, string>();
  for (const combination of combinations) {
    byValues.set(setKey(combination.pairs.map((pair) => pair.valueId)), combination.key);
  }

  const prices = new Map<string, Poisha>(combinations.map((c) => [c.key, base]));
  const seen = new Set<string>();
  for (const override of overrides) {
    const valueSet = new Set(override.valueIds);
    if (valueSet.size !== override.valueIds.length) {
      throw new VariantMatrixError('A variant price names the same value twice.');
    }
    const key = byValues.get(setKey(override.valueIds));
    if (key === undefined) {
      throw new VariantMatrixError(
        'A variant price names a combination this product does not have. Choose one value from every size and colour list.',
      );
    }
    if (seen.has(key)) {
      throw new VariantMatrixError('Two prices were given for the same variant.');
    }
    seen.add(key);
    prices.set(key, override.pricePoisha);
  }
  return prices;
}
