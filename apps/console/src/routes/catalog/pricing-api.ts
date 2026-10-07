import { api } from '../../api.js';
import type { CatalogProduct } from './api.js';

/**
 * M39b's routes (D-635 to D-646), typed to what the server returns.
 *
 * Two families, kept apart on purpose:
 *
 * - **selling-side** (`/v1/catalog/*`, `/v1/storefront/products`, `/v1/inventory/stock/products`):
 *   prices, regular prices, duplicates, weights, photo colours, bulk changes, stock counts.
 *   No cost anywhere, like `api.ts`.
 * - **purchase cost** (`/v1/supply/sku-costs*`): the standard, last and average buying price of
 *   each variant. Every one of these answers `read:cost` roles only (invariant 5); screens call
 *   them behind `ability.can('read', 'Cost')` and render nothing of them otherwise. A margin is
 *   computed on the screen from these figures and never fetched (D-636).
 *
 * Money is integer poisha as decimal strings throughout (§23).
 */

// --- prices and regular prices --------------------------------------------------------

export interface PriceChange {
  readonly skuId: string;
  /** The price the change was made against; a price changed since is refused. */
  readonly expectedPricePoisha?: string | undefined;
  readonly pricePoisha?: string | undefined;
  /** Absent leaves the regular price; null clears it. */
  readonly compareAtPoisha?: string | null | undefined;
}

/** Many variants' prices and regular prices in one request, with one reason (D-636). */
export function saveVariantPrices(input: {
  readonly prices: readonly PriceChange[];
  readonly reason?: string | undefined;
}): Promise<{ repriced: number }> {
  return api.put('/v1/catalog/prices', input);
}

export interface PriceHistoryRow {
  readonly skuId: string;
  readonly skuCode: string;
  readonly variantLabel: string;
  readonly fromPricePoisha: string | null;
  readonly toPricePoisha: string;
  readonly compareAtFromPoisha: string | null;
  readonly compareAtToPoisha: string | null;
  readonly changedBy: string | null;
  readonly reason: string | null;
  readonly changedAt: string;
}

/** Every price change of every variant of a product, newest first (D-636). */
export function productPriceHistory(productId: string): Promise<{ items: PriceHistoryRow[] }> {
  return api.get(`/v1/catalog/products/${productId}/price-history`);
}

// --- sizes and colours later (D-639) --------------------------------------------------

export function extendVariants(
  productId: string,
  input: {
    readonly axes: readonly {
      readonly attributeId: string;
      readonly valueIds: readonly string[];
    }[];
    readonly pricePoisha?: string | undefined;
    readonly variantPrices?: readonly {
      readonly valueIds: readonly string[];
      readonly pricePoisha: string;
      readonly compareAtPoisha?: string | null;
    }[];
  },
): Promise<{
  created: string[];
  unchanged: number;
  orphaned: string[];
  orphanedSkus: { id: string; skuCode: string; status: string }[];
  product: CatalogProduct;
}> {
  return api.post(`/v1/catalog/products/${productId}/variants`, input);
}

/** Archive or restore many variants together (D-639); refused when orders hold pieces. */
export function setSkuStatuses(
  skuIds: readonly string[],
  status: 'active' | 'archived',
): Promise<{ status: string; changed: { id: string; skuCode: string }[]; unchanged: number }> {
  return api.patch('/v1/catalog/skus', { skuIds, status });
}

// --- one variant (D-644, D-645) -------------------------------------------------------

/** A supplier's barcode on a variant, or null for the SKU code (D-603's guard applies). */
export function setSkuBarcode(
  skuId: string,
  barcode: string | null,
): Promise<{ id: string; barcode: string | null }> {
  return api.put(`/v1/catalog/skus/${skuId}/barcode`, { barcode });
}

export function setSkuWeight(
  skuId: string,
  weightGrams: number | null,
): Promise<{ id: string; weightGrams: number | null }> {
  return api.put(`/v1/catalog/skus/${skuId}/weight`, { weightGrams });
}

// --- products (D-641, D-642, D-643) ---------------------------------------------------

/** One product a duplicate made (D-662, D-663). */
export interface ProductCopy {
  readonly id: string;
  readonly sourceId: string;
  readonly name: string;
  /** `ELY-HAWA-0021`: the source's parent SKU with the next number (D-661). */
  readonly parentSku: string;
  readonly slug: string;
}

/**
 * `copies` copies of a product (1 to 50), numbered one after another (D-662), each named
 * `name` or the source's name. The first copy comes back whole, all of them in `copies`.
 */
export function duplicateProduct(
  productId: string,
  input: { readonly name?: string | undefined; readonly copies: number },
): Promise<CatalogProduct & { readonly copies: readonly ProductCopy[] }> {
  return api.post(`/v1/catalog/products/${productId}/duplicate`, input);
}

/** `copies` copies of each of many products, made in the order given (D-663). */
export function duplicateProducts(input: {
  readonly productIds: readonly string[];
  readonly copies: number;
}): Promise<{ readonly products: readonly ProductCopy[] }> {
  return api.post('/v1/catalog/products/duplicate', input);
}

export function bulkProducts(input: {
  readonly productIds: readonly string[];
  readonly status?: 'draft' | 'active' | 'archived' | undefined;
  readonly categoryId?: string | null | undefined;
}): Promise<{ updated: number }> {
  return api.patch('/v1/catalog/products', input);
}

/** Show or hide many products on the website, or give them one size chart (D-642). */
export function bulkProductsWeb(input: {
  readonly productIds: readonly string[];
  readonly webVisible?: boolean | undefined;
  readonly sizeChartId?: string | null | undefined;
}): Promise<{ updated: number }> {
  return api.put('/v1/storefront/products', input);
}

export function setImageColour(
  productId: string,
  imageId: string,
  colourValueId: string | null,
): Promise<{ id: string; colourValueId: string | null }> {
  return api.put(`/v1/catalog/products/${productId}/images/${imageId}/colour`, { colourValueId });
}

/** Pieces on hand and free to sell per product, for the product list (`read Stock`). */
export function productStockTotals(
  productIds: readonly string[],
): Promise<{ items: { productId: string; onHand: number; available: number }[] }> {
  return api.get(`/v1/inventory/stock/products?productIds=${productIds.join(',')}`);
}

// --- purchase cost: `read:cost` only (invariant 5) ------------------------------------

export type PrefillSource = 'supplier-standard' | 'standard' | 'last';

export interface SkuCost {
  readonly skuId: string;
  readonly standardUnitCostPoisha: string | null;
  readonly standards: readonly {
    readonly supplierId: string | null;
    readonly supplierCode: string | null;
    readonly supplierName: string | null;
    readonly standardUnitCostPoisha: string;
  }[];
  readonly lastUnitCostPoisha: string | null;
  readonly lastReceivedOn: string | null;
  readonly lastSupplierName: string | null;
  readonly wacPoisha: string | null;
  readonly prefillUnitCostPoisha: string | null;
  readonly prefillSource: PrefillSource | null;
}

/** Standard, last and average buying price per variant, and a receipt's prefill (D-637). */
export async function skuCosts(
  skuIds: readonly string[],
  supplierId?: string,
): Promise<{ items: SkuCost[] }> {
  const items: SkuCost[] = [];
  // At most 200 per request (the route's bound); a product rarely has more.
  for (let start = 0; start < skuIds.length; start += 200) {
    const batch = skuIds.slice(start, start + 200);
    const params = new URLSearchParams({ skuIds: batch.join(',') });
    if (supplierId !== undefined && supplierId !== '') params.set('supplierId', supplierId);
    const page = await api.get<{ items: SkuCost[] }>(`/v1/supply/sku-costs?${params.toString()}`);
    items.push(...page.items);
  }
  return { items };
}

/** Set, replace or remove standard buying prices (D-638). */
export function setStandardCosts(
  entries: readonly {
    readonly skuId: string;
    readonly supplierId: string | null;
    readonly standardUnitCostPoisha: string | null;
  }[],
): Promise<{ set: number; removed: number }> {
  return api.put('/v1/supply/sku-costs', { entries });
}

export function exportStandardCosts(
  productId?: string,
): Promise<{ filename: string; csv: string }> {
  return api.get(
    `/v1/supply/sku-costs/export${productId === undefined ? '' : `?productId=${productId}`}`,
  );
}

export interface StandardCostReport {
  readonly willSet: number;
  readonly skipped: number;
  readonly problems: readonly { line: number; column: string | null; message: string }[];
  readonly canCommit: boolean;
}

export function dryRunStandardCosts(csv: string): Promise<StandardCostReport> {
  return api.post('/v1/supply/sku-costs/import/dry-run', { csv });
}

export function importStandardCosts(csv: string): Promise<{ set: number; skipped: number }> {
  return api.post('/v1/supply/sku-costs/import', { csv });
}
