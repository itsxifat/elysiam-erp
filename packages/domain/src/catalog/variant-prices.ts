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
  /**
   * The variant's regular ("was") price (M39b, D-640): absent for the product's, null for
   * none. Above `pricePoisha` when set.
   */
  readonly compareAtPoisha?: Poisha | null | undefined;
}

/** A variant's starting price and regular price. */
export interface VariantPriceEntry {
  readonly pricePoisha: Poisha;
  readonly compareAtPoisha: Poisha | null;
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
  const entries = variantPriceEntries(combinations, base, null, overrides);
  return new Map([...entries].map(([key, entry]) => [key, entry.pricePoisha]));
}

/**
 * The price and regular price for every combination (M39b, D-635, D-640), with the same two
 * refusals as `variantPrices`, plus a third: a regular price at or below its variant's price
 * (the database refuses it too, `skus_compare_at_above_price`), so the person is told which
 * variant before anything is created.
 */
export function variantPriceEntries(
  combinations: readonly VariantCombination[],
  base: Poisha,
  baseCompareAt: Poisha | null,
  overrides: readonly VariantPriceOverride[],
): Map<string, VariantPriceEntry> {
  const named = variantOverrides(combinations, overrides);
  const prices = new Map<string, VariantPriceEntry>();
  for (const combination of combinations) {
    const override = named.get(combination.key);
    prices.set(
      combination.key,
      override === undefined
        ? { pricePoisha: base, compareAtPoisha: baseCompareAt }
        : {
            pricePoisha: override.pricePoisha,
            compareAtPoisha:
              override.compareAtPoisha === undefined ? baseCompareAt : override.compareAtPoisha,
          },
    );
  }
  for (const entry of prices.values()) {
    if (entry.compareAtPoisha !== null && entry.compareAtPoisha <= entry.pricePoisha) {
      throw new VariantMatrixError(
        'A regular price must be above the selling price it is shown beside. Raise it or leave it blank.',
      );
    }
  }
  return prices;
}

/**
 * Each override, keyed by the variant key of the combination it names, with D-422's two
 * refusals: a combination the axes do not make, and two overrides for one combination.
 */
export function variantOverrides(
  combinations: readonly VariantCombination[],
  overrides: readonly VariantPriceOverride[],
): Map<string, VariantPriceOverride> {
  const byValues = new Map<string, string>();
  for (const combination of combinations) {
    byValues.set(setKey(combination.pairs.map((pair) => pair.valueId)), combination.key);
  }
  const named = new Map<string, VariantPriceOverride>();
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
    if (named.has(key)) {
      throw new VariantMatrixError('Two prices were given for the same variant.');
    }
    named.set(key, override);
  }
  return named;
}
