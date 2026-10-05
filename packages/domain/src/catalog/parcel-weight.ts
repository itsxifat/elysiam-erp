/**
 * What a parcel weighs, for the courier (M39b, D-645).
 *
 * Σ qty × grams over the order's lines, each line's grams being its variant's own weight or
 * its product's. Null when any line has no weight, or there are no lines: a partial sum would
 * under-declare the parcel, and the courier's configured default (500 g for Pathao) is the
 * honest answer when the brand has not weighed everything in it.
 */
export function parcelWeightGrams(
  lines: readonly { readonly qty: number; readonly grams: number | null }[],
): number | null {
  if (lines.length === 0) return null;
  let total = 0;
  for (const line of lines) {
    if (line.grams === null || !Number.isInteger(line.grams) || line.grams <= 0) return null;
    if (!Number.isInteger(line.qty) || line.qty <= 0) return null;
    total += line.qty * line.grams;
  }
  return Number.isSafeInteger(total) ? total : null;
}
