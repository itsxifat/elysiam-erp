import type { Tx } from '@elysium/db';
import { internalEan13, isInternalEan13 } from '@elysium/domain';

import { CatalogError } from './catalog.errors.js';
import * as repo from './catalog.repository.js';

/**
 * Internal EAN-13s for new SKUs (M38a, D-603).
 *
 * Every SKU created without a supplier's barcode gets the brand's next number in the range
 * GS1 reserves for in-store use: `2`, an eleven-digit per-brand sequence, the check digit.
 * The sequences come from `catalog.sku_settings` in one statement (`takeBarcodeSequences`),
 * never read then written, so two people creating products at once get different numbers.
 *
 * The one way a fresh number could already exist is a barcode set by hand or imported that
 * happens to sit in the same range. Such a number is skipped and another taken, so the
 * unique index never refuses a product create for something nobody did wrong; typing a
 * number in the range is refused at the edge anyway (`assertNotInternal`).
 */
export async function nextInternalBarcodes(
  tx: Tx,
  orgId: string,
  count: number,
): Promise<string[]> {
  const found: string[] = [];
  let wanted = count;
  // Ten rounds is far beyond what a collision rate of "someone typed a 2-prefixed code"
  // can need; running out means something is writing into the range on purpose.
  for (let round = 0; round < 10 && wanted > 0; round += 1) {
    const last = await repo.takeBarcodeSequences(tx, orgId, wanted);
    const candidates = Array.from({ length: wanted }, (_, index) =>
      internalEan13(last - wanted + 1 + index),
    );
    const taken = await repo.barcodesInUse(tx, orgId, candidates);
    for (const code of candidates) if (!taken.has(code)) found.push(code);
    wanted = count - found.length;
  }
  if (found.length < count) {
    throw new CatalogError(
      'CATALOG_BARCODE_INVALID',
      'The brand’s barcode numbers are crowded by hand-entered codes; ask an admin to look.',
    );
  }
  return found;
}

/**
 * Refuse a typed barcode in the ERP's own range (D-603).
 *
 * The range is `2` and twelve digits, valid check digit or not: one typed by hand could equal
 * a number the counter hands out later, and the second SKU would then fail to save. A SKU
 * keeps the internal number it already has.
 */
export function assertNotInternal(barcode: string | null, current: string | null): void {
  if (barcode === null || barcode === current) return;
  if (/^2\d{12}$/.test(barcode)) {
    throw new CatalogError(
      'CATALOG_BARCODE_INVALID',
      isInternalEan13(barcode)
        ? 'Barcodes starting with 2 are the ones the ERP gives its own products; scan the supplier’s barcode instead.'
        : 'Thirteen digits starting with 2 are kept for the ERP’s own barcodes.',
    );
  }
}
