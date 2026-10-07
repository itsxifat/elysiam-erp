/**
 * Scan-to-pack (M38b, D-610): what one scan at the packing station means for one order.
 *
 * An order needs so many pieces of each SKU. Each scan of a sticker names a SKU (by its
 * barcode or its code) or names nothing. The station takes the piece when the order still
 * needs one of that SKU, and refuses it otherwise, saying why in the words a packer acts on:
 *
 * - `unknown_code`: the code is no SKU of this brand (a torn sticker, a courier label);
 * - `wrong_item`: a real SKU, but no line of this order is that product;
 * - `wrong_variant`: the order has this product, in another size or colour;
 * - `over`: the right SKU, but every piece the order needs is already in the box.
 *
 * Pure (invariant 11): the server and the browser ask the same function, and the property
 * tests hold the rule that matters: no scan ever puts more of a SKU in the box than the
 * order asked for.
 */

export const PACK_SCAN_REFUSALS = ['unknown_code', 'wrong_item', 'wrong_variant', 'over'] as const;
export type PackScanRefusal = (typeof PACK_SCAN_REFUSALS)[number];

export const PACK_SCAN_OUTCOMES = ['accepted', 'removed', ...PACK_SCAN_REFUSALS] as const;
export type PackScanOutcome = (typeof PACK_SCAN_OUTCOMES)[number];

export function isPackScanRefusal(outcome: string): outcome is PackScanRefusal {
  return (PACK_SCAN_REFUSALS as readonly string[]).includes(outcome);
}

/** One order line as packing needs it. */
export interface PackOrderLine {
  readonly skuId: string;
  /** The product the SKU belongs to, to tell a wrong size from a wrong product. */
  readonly productId: string | null;
  readonly qty: number;
}

/** What the order needs of one SKU: the lines' quantities added together. */
export interface PackNeed {
  readonly skuId: string;
  readonly productId: string | null;
  readonly required: number;
}

/** The order's needs, one per SKU, in the order the SKUs first appear on its lines. */
export function packNeeds(lines: readonly PackOrderLine[]): PackNeed[] {
  const needs = new Map<string, { productId: string | null; required: number }>();
  for (const line of lines) {
    if (!Number.isInteger(line.qty) || line.qty < 0) {
      throw new RangeError('An order line packs a whole number of pieces.');
    }
    const known = needs.get(line.skuId);
    if (known === undefined) {
      needs.set(line.skuId, { productId: line.productId, required: line.qty });
    } else {
      known.required += line.qty;
    }
  }
  return [...needs].map(([skuId, need]) => ({ skuId, ...need }));
}

/** One recorded scan, as the count needs it. */
export interface RecordedPackScan {
  readonly skuId: string | null;
  readonly outcome: PackScanOutcome;
}

/** Pieces of each SKU in the box: accepted scans less pieces taken back out. */
export function packedCounts(scans: readonly RecordedPackScan[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const scan of scans) {
    if (scan.skuId === null) continue;
    if (scan.outcome === 'accepted') counts.set(scan.skuId, (counts.get(scan.skuId) ?? 0) + 1);
    if (scan.outcome === 'removed') counts.set(scan.skuId, (counts.get(scan.skuId) ?? 0) - 1);
  }
  for (const [skuId, count] of counts) {
    if (count === 0) counts.delete(skuId);
  }
  return counts;
}

/** What a scanned code named: a SKU and its product, or nothing at all. */
export type ScannedSku = { readonly skuId: string; readonly productId: string | null } | null;

/** Accept the piece, or refuse it and say why. */
export function judgePackScan(input: {
  readonly needs: readonly PackNeed[];
  readonly packed: ReadonlyMap<string, number>;
  readonly scanned: ScannedSku;
}): 'accepted' | PackScanRefusal {
  const { needs, packed, scanned } = input;
  if (scanned === null) return 'unknown_code';
  const need = needs.find((entry) => entry.skuId === scanned.skuId);
  if (need === undefined) {
    const sameProduct =
      scanned.productId !== null &&
      needs.some((entry) => entry.productId !== null && entry.productId === scanned.productId);
    return sameProduct ? 'wrong_variant' : 'wrong_item';
  }
  return (packed.get(scanned.skuId) ?? 0) < need.required ? 'accepted' : 'over';
}

/** Taking a piece back out: only of a SKU that has a piece in the box. */
export function judgePackRemoval(
  packed: ReadonlyMap<string, number>,
  skuId: string,
): 'removed' | 'nothing_to_remove' {
  return (packed.get(skuId) ?? 0) > 0 ? 'removed' : 'nothing_to_remove';
}

export type PackLineState = 'todo' | 'partial' | 'done' | 'over';

export interface PackLineProgress {
  readonly skuId: string;
  readonly required: number;
  readonly packed: number;
  readonly state: PackLineState;
}

export interface PackProgress {
  readonly lines: readonly PackLineProgress[];
  /** SKUs in the box that the order does not have (only after its lines were edited). */
  readonly extra: readonly { readonly skuId: string; readonly packed: number }[];
  readonly unitsRequired: number;
  readonly unitsPacked: number;
  /** Every SKU at exactly its quantity, and nothing else in the box. */
  readonly complete: boolean;
}

/**
 * Where the box stands against the order. An order whose lines were edited while it was being
 * packed can leave too many of a SKU (`over`) or a SKU it no longer has (`extra`): the packer
 * takes those out before the order can be finished.
 */
export function packProgress(
  needs: readonly PackNeed[],
  packed: ReadonlyMap<string, number>,
): PackProgress {
  const lines = needs.map((need) => {
    const count = packed.get(need.skuId) ?? 0;
    const state: PackLineState =
      count > need.required
        ? 'over'
        : count === need.required
          ? 'done'
          : count === 0
            ? 'todo'
            : 'partial';
    return { skuId: need.skuId, required: need.required, packed: count, state };
  });
  const known = new Set(needs.map((need) => need.skuId));
  const extra = [...packed]
    .filter(([skuId, count]) => !known.has(skuId) && count > 0)
    .map(([skuId, count]) => ({ skuId, packed: count }));
  const unitsRequired = lines.reduce((sum, line) => sum + line.required, 0);
  const unitsPacked =
    lines.reduce((sum, line) => sum + line.packed, 0) +
    extra.reduce((sum, entry) => sum + entry.packed, 0);
  return {
    lines,
    extra,
    unitsRequired,
    unitsPacked,
    complete:
      unitsRequired > 0 && extra.length === 0 && lines.every((line) => line.state === 'done'),
  };
}
