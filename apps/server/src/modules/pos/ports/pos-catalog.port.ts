import type { Tx } from '@elysium/db';

/**
 * The till's offline price list (architecture §14, invariant 12).
 *
 * A showroom scans offline, so the PWA keeps every sellable SKU — code, barcode,
 * name, selling price — in IndexedDB and refreshes it whenever it is online.
 * `CatalogApi` answers "this id" and "this code"; it has no way to page through the
 * catalog, and this module may not read `catalog.*` itself. So the POS declares
 * the one method it needs and the catalog implements it: `CatalogApi.sellableSkus`
 * satisfies this interface structurally, and `PosModule` binds `POS_CATALOG` to
 * `CATALOG_API`.
 *
 * **No cost, by construction.** The row type has no field a cost could travel in,
 * for the same reason `CatalogSku` has none (`catalog.api.ts`).
 */

export interface SellableSku {
  readonly id: string;
  readonly code: string;
  readonly barcode: string | null;
  readonly productName: string;
  /** Integer poisha, as a decimal string on the wire (§23). */
  readonly pricePoisha: bigint;
}

export interface PosCatalogPort {
  /**
   * Active SKUs of active products, ordered by code, after `afterCode` (exclusive).
   * Keyset-paged because a brand's catalog is thousands of rows and an offset
   * page shifts under a concurrent edit.
   */
  sellableSkus(
    tx: Tx,
    orgId: string,
    page: { readonly afterCode: string | null; readonly limit: number },
  ): Promise<SellableSku[]>;
}

export const POS_CATALOG = Symbol('PosCatalogPort');
