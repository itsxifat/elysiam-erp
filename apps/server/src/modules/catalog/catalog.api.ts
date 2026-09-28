import type { RequestContext, Tx } from '@elysium/db';

import * as repo from './catalog.repository.js';

/**
 * What other modules may ask the catalog (invariant 12).
 *
 * Modules talk through `*.api.ts` interfaces or events, never through each other's
 * tables. M07 needs to know a SKU exists before it moves stock; M10 needs the
 * selling price when it prices an order line; M23's POS needs to resolve a scanned
 * barcode. Each of those is a question, and each one is answered here rather than
 * by a join into `catalog.skus` from somebody else's repository.
 *
 * **The interface has no cost in it and cannot grow one.** Invariant 5: a caller
 * that wants a unit cost is asking inventory or supply, not the catalog. That is
 * the boundary this file is drawn to protect — a `CatalogApi.costOf(sku)` would be
 * the single change that made invariant 5 unenforceable, because every module
 * would then have a legitimate-looking way to read cost through the catalog.
 */

/** One SKU, as another module sees it. */
export interface CatalogSku {
  readonly id: string;
  readonly productId: string;
  readonly code: string;
  readonly productName: string;
  /** The **selling** price, in integer poisha. */
  readonly pricePoisha: bigint;
  readonly status: 'active' | 'archived';
}

export interface CatalogApi {
  /**
   * Resolve SKU ids inside an existing transaction.
   *
   * Takes the `tx` rather than opening its own, so a caller posting a journal and
   * pricing its lines does both in one transaction — and so a SKU cannot be
   * archived between the price this returns and the row that used it.
   */
  skusByIds(tx: Tx, orgId: string, ids: readonly string[]): Promise<CatalogSku[]>;

  /** Resolve a scanned code or barcode to one SKU, or nothing (M23's POS). */
  skuByCode(tx: Tx, orgId: string, code: string): Promise<CatalogSku | undefined>;
}

export const CATALOG_API = Symbol('CatalogApi');

/** The implementation. Registered under `CATALOG_API` by `CatalogModule`. */
export class CatalogApiService implements CatalogApi {
  async skusByIds(tx: Tx, orgId: string, ids: readonly string[]): Promise<CatalogSku[]> {
    const rows = await repo.skusByIds(tx, orgId, ids);
    return rows.map(toSku);
  }

  async skuByCode(tx: Tx, orgId: string, code: string): Promise<CatalogSku | undefined> {
    const rows = await repo.searchSkus(tx, orgId, { code, limit: 2 });
    // Two rows means a barcode collides with a code. The unique indexes make that
    // impossible within either column, so returning nothing rather than guessing
    // is the honest answer if it ever happens.
    return rows.length === 1 && rows[0] !== undefined ? toSku(rows[0]) : undefined;
  }
}

function toSku(row: repo.SkuRow & { product_name: string }): CatalogSku {
  return {
    id: row.id,
    productId: row.product_id,
    code: row.code,
    productName: row.product_name,
    // The driver hands `bigint` back as a decimal string; callers inside the server
    // want a bigint, and §23's string is the *wire* format, not the internal one.
    pricePoisha: BigInt(row.price_poisha),
    status: row.status === 'archived' ? 'archived' : 'active',
  };
}

/** For the rare caller that has a `RequestContext` but no transaction. */
export type CatalogContext = RequestContext;
