/**
 * The variant matrix (architecture §8, M06 acceptance check 1).
 *
 * A product has axes — colour, size, anything an org invents — and one SKU per
 * combination. Three colours and five sizes is fifteen SKUs. That part is a
 * Cartesian product and would be a one-liner.
 *
 * The part that is not a one-liner, and the reason this module exists, is what
 * happens when a size is added six months later. Check 1 says adding a size
 * **creates only the new SKUs**, and the reason is not tidiness:
 *
 * - every existing SKU has stock levels and movements behind it from M07, and
 *   `inventory.stock_movements` is append-only — a SKU that disappears leaves
 *   movements pointing at nothing;
 * - it is printed on labels already on boxes in a warehouse;
 * - it is in orders, in a courier's consignment and in a customer's invoice.
 *
 * So the matrix is **extended, never regenerated**. `matrixPlan` takes the axes
 * and what already exists and returns only the additions, and it returns the
 * combinations that are no longer in the axes separately — as something for a
 * human to archive, never something to delete.
 */

/** One axis of the matrix: an attribute and the values selected for this product. */
export interface VariantAxis {
  readonly attributeId: string;
  /** Sort order within the product's matrix. Part of the SKU code's shape. */
  readonly position: number;
  readonly values: readonly VariantValue[];
}

export interface VariantValue {
  readonly valueId: string;
  /** The segment this value contributes to a SKU code, e.g. `RED`. */
  readonly code: string;
}

/** One cell of the matrix: one value per axis, in axis order. */
export interface VariantCombination {
  readonly key: string;
  /** `[attributeId, valueId]` pairs, in axis order. */
  readonly pairs: readonly { readonly attributeId: string; readonly valueId: string }[];
  /** The SKU code segments this combination contributes, in axis order. */
  readonly codes: readonly string[];
}

export class VariantMatrixError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VariantMatrixError';
  }
}

/** The number of SKUs a product may hold. A guard against a mis-typed import. */
export const MAX_VARIANTS_PER_PRODUCT = 500;

/**
 * The canonical identity of a combination, independent of how it was listed.
 *
 * Sorted by attribute id, not by axis position, and that is deliberate: the key
 * is a database uniqueness constraint's value, and it has to keep meaning the
 * same combination after somebody reorders the axes on the product page.
 * Reordering changes the *code* — which is why `codes` is separate and stays in
 * axis order — but it must not be able to create a duplicate SKU for a variant
 * that already exists.
 */
export function variantKey(
  pairs: readonly { readonly attributeId: string; readonly valueId: string }[],
): string {
  return [...pairs]
    .sort((a, b) => (a.attributeId < b.attributeId ? -1 : a.attributeId > b.attributeId ? 1 : 0))
    .map((pair) => `${pair.attributeId}=${pair.valueId}`)
    .join('&');
}

function assertAxes(axes: readonly VariantAxis[]): void {
  const seen = new Set<string>();
  for (const axis of axes) {
    if (seen.has(axis.attributeId)) {
      throw new VariantMatrixError('An attribute may only be one axis of the matrix.');
    }
    seen.add(axis.attributeId);
    if (axis.values.length === 0) {
      throw new VariantMatrixError('Every axis needs at least one value.');
    }
    const values = new Set(axis.values.map((value) => value.valueId));
    if (values.size !== axis.values.length) {
      throw new VariantMatrixError('An axis lists the same value twice.');
    }
  }
}

/**
 * Every combination the axes imply, in a stable order.
 *
 * The order is odometer order with the **last** axis turning fastest, so a
 * 3-colour × 5-size matrix reads as all five sizes of red, then of blue: the
 * order a person expects on a product page and the order a label sheet prints
 * in. A different axis turning fastest is not wrong in any formal sense and is
 * wrong for every human who looks at the result.
 */
export function variantCombinations(axes: readonly VariantAxis[]): VariantCombination[] {
  assertAxes(axes);

  const ordered = [...axes].sort((a, b) => a.position - b.position);
  if (ordered.length === 0) return [];

  const total = ordered.reduce((count, axis) => count * axis.values.length, 1);
  if (total > MAX_VARIANTS_PER_PRODUCT) {
    throw new VariantMatrixError(
      `That matrix is ${String(total)} variants; one product holds at most ${String(MAX_VARIANTS_PER_PRODUCT)}.`,
    );
  }

  let rows: { attributeId: string; valueId: string; code: string }[][] = [[]];
  for (const axis of ordered) {
    const next: { attributeId: string; valueId: string; code: string }[][] = [];
    for (const row of rows) {
      for (const value of axis.values) {
        next.push([
          ...row,
          { attributeId: axis.attributeId, valueId: value.valueId, code: value.code },
        ]);
      }
    }
    rows = next;
  }

  return rows.map((row) => ({
    key: variantKey(row),
    pairs: row.map((cell) => ({ attributeId: cell.attributeId, valueId: cell.valueId })),
    codes: row.map((cell) => cell.code),
  }));
}

export interface MatrixPlan {
  /** Combinations that do not exist yet. The only thing a caller inserts. */
  readonly additions: readonly VariantCombination[];
  /** Keys that exist and are still in the axes. Left exactly as they are. */
  readonly unchanged: readonly string[];
  /**
   * Keys that exist but are no longer in the axes.
   *
   * Reported, never removed. A caller may offer to archive them; deleting one
   * would orphan the stock movements and orders that reference it.
   */
  readonly orphaned: readonly string[];
}

/**
 * What to do to bring a product's SKUs in line with its axes.
 *
 * The signature is the point: it takes the keys that already exist, so there is
 * no code path that can produce "the full matrix" and hand it to an insert. A
 * function that returned every combination and left de-duplication to the
 * caller would pass its own tests and fail check 1 the first time somebody
 * called it from a second place.
 */
export function matrixPlan(
  axes: readonly VariantAxis[],
  existingKeys: readonly string[],
): MatrixPlan {
  const existing = new Set(existingKeys);
  const wanted = variantCombinations(axes);
  const wantedKeys = new Set(wanted.map((combination) => combination.key));

  return {
    additions: wanted.filter((combination) => !existing.has(combination.key)),
    unchanged: wanted.filter((combination) => existing.has(combination.key)).map((c) => c.key),
    orphaned: existingKeys.filter((key) => !wantedKeys.has(key)),
  };
}
