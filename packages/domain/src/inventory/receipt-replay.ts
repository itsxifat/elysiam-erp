/**
 * Whether a retried receipt is the same receipt (D-432).
 *
 * A supply entry or draft is keyed by an id the client makes, and a retry with a known
 * id is answered from what is already stored. That is only safe when the retry asks for
 * the same thing: same supplier, same location and the same lines. Answering a request
 * for different goods with the first receipt would report success for stock and a
 * payable that never posted, so a mismatch is refused instead (`IDEMPOTENCY_CONFLICT`).
 *
 * The invoice number, memo and date are not compared: a retry that adds the challan
 * number is still the same delivery. Line order is not compared either.
 */

export interface ReceiptShape {
  readonly supplierId: string;
  readonly locationId: string;
  readonly lines: readonly {
    readonly skuId: string;
    readonly qty: number;
    /** Integer poisha as a decimal string; null on a quantity-only draft. */
    readonly unitCostPoisha: string | null;
  }[];
}

function lineKeys(shape: ReceiptShape): string[] {
  return shape.lines
    .map(
      (line) =>
        `${line.skuId}:${String(line.qty)}:${line.unitCostPoisha === null ? '-' : BigInt(line.unitCostPoisha).toString()}`,
    )
    .sort();
}

export function sameReceipt(stored: ReceiptShape, requested: ReceiptShape): boolean {
  if (stored.supplierId !== requested.supplierId) return false;
  if (stored.locationId !== requested.locationId) return false;
  const a = lineKeys(stored);
  const b = lineKeys(requested);
  return a.length === b.length && a.every((key, index) => key === b[index]);
}
