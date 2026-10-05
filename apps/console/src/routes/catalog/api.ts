import { ApiError, CSRF_HEADER, api, csrfToken } from '../../api.js';
import { env } from '../../env.js';

/**
 * `/v1/catalog/*`, typed to what the controller actually returns.
 *
 * Hand-written against the controller rather than taken from the generated client,
 * for the same reason `api/approvals.ts` is: M04's generator types every
 * operation's result as `unknown` because the OpenAPI document carries paths and
 * abilities but not response schemas. An `unknown` at the call site gets cast
 * somewhere, and a cast inside a page component is a type nobody maintains.
 *
 * **Every price is a string and stays a string.** §23: integer poisha crosses the
 * wire as a decimal string, because `JSON.parse` turns a crore-scale value into a
 * double and loses its last digits. Parsing it to a number here would undo that at
 * the last possible moment, which is the worst place for it — every screen
 * downstream would look correct. `<Money>` takes the string directly.
 *
 * **There is no cost field in any type here, and that is the point.** Invariant 5:
 * purchase cost lives in supply, inventory and the ledger. A `costPoisha` added to
 * `CatalogSku` to show a margin badge is the change that makes the invariant
 * unenforceable, because the console would then have somewhere to put one.
 */

function csrfHeader(): Record<string, string> {
  const token = csrfToken();
  return token === '' ? {} : { [CSRF_HEADER]: token };
}

export interface CatalogProductListItem {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly sequence: number;
  readonly status: 'draft' | 'active' | 'archived';
  readonly categoryId: string | null;
  readonly categoryName: string | null;
  readonly skuCount: number;
  /** The cheapest active SKU's **selling** price, as integer poisha. */
  readonly fromPricePoisha: string | null;
  readonly toPricePoisha: string | null;
  readonly imageFileId: string | null;
}

export interface CatalogSku {
  readonly id: string;
  readonly skuCode: string;
  readonly barcode: string | null;
  readonly pricePoisha: string;
  readonly status: 'active' | 'archived';
  readonly attributes: readonly {
    readonly attributeId: string;
    readonly code: string;
    readonly name: string;
    readonly valueId: string;
    readonly valueCode: string;
    readonly valueLabel: string;
  }[];
}

export interface CatalogProduct {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly sequence: number;
  readonly categoryId: string | null;
  readonly description: string | null;
  readonly status: 'draft' | 'active' | 'archived';
  readonly skus: readonly CatalogSku[];
  readonly images: readonly {
    readonly id: string;
    readonly fileId: string;
    readonly position: number;
    readonly altText: string | null;
  }[];
  /** The website's fields (M33, D-500), for the product page's Website card. */
  readonly web: ProductWebFields;
}

export interface ProductWebFields {
  readonly webVisible: boolean;
  readonly featured: boolean;
  readonly newArrival: boolean;
  readonly gender: string | null;
  readonly material: string | null;
  readonly careInstructions: string | null;
  readonly tags: readonly string[];
  readonly sizeChartId: string | null;
  readonly seoTitle: string | null;
  readonly seoDescription: string | null;
  /** Old addresses that still lead here, newest first. */
  readonly previousSlugs: readonly string[];
}

/** A category's website fields (M33, D-501). */
export interface CategoryWebFields {
  readonly webVisible: boolean;
  readonly featured: boolean;
  readonly gender: string | null;
  readonly description: string | null;
  readonly imageFileId: string | null;
}

export interface CatalogCategory {
  readonly id: string;
  readonly parentId: string | null;
  readonly name: string;
  readonly slug: string;
  readonly code: string;
  readonly path: string;
  readonly depth: number;
  readonly position: number;
  readonly isActive: boolean;
  readonly web: CategoryWebFields;
}

export interface CatalogAttribute {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly kind: 'size' | 'colour' | 'custom';
  readonly isVariant: boolean;
  readonly position: number;
  readonly values: readonly {
    readonly id: string;
    readonly code: string;
    readonly label: string;
    readonly position: number;
  }[];
}

export interface ImportProblem {
  readonly line: number;
  readonly column: string | null;
  readonly message: string;
}

export interface ImportReport {
  readonly totalRows: number;
  readonly willChange: number;
  readonly unchanged: number;
  readonly problems: readonly ImportProblem[];
  readonly canCommit: boolean;
  readonly reason: string | null;
  readonly preview: readonly {
    readonly line: number;
    readonly sku: string;
    readonly fromPricePoisha: string | null;
    readonly toPricePoisha: string;
  }[];
}

export interface ProductListQuery {
  readonly q?: string | undefined;
  readonly categoryId?: string | undefined;
  readonly status?: string | undefined;
  readonly limit: number;
  readonly cursor?: string | undefined;
}

export function listProducts(query: ProductListQuery): Promise<{
  items: CatalogProductListItem[];
  nextCursor: string | null;
}> {
  const params = new URLSearchParams({ limit: String(query.limit) });
  // Only three characters or more: the server refuses a shorter fragment because
  // pg_trgm cannot index it, and sending one anyway would turn a keystroke into a
  // 400 the user reads as a broken search box.
  if (query.q !== undefined && query.q.length >= 3) params.set('q', query.q);
  if (query.categoryId !== undefined) params.set('categoryId', query.categoryId);
  if (query.status !== undefined) params.set('status', query.status);
  if (query.cursor !== undefined) params.set('cursor', query.cursor);
  return api.get(`/v1/catalog/products?${params.toString()}`);
}

export function getProduct(id: string): Promise<CatalogProduct> {
  return api.get(`/v1/catalog/products/${id}`);
}

export function listCategories(): Promise<{ items: CatalogCategory[] }> {
  return api.get('/v1/catalog/categories');
}

export function listAttributes(): Promise<{ items: CatalogAttribute[] }> {
  return api.get('/v1/catalog/attributes');
}

export function createProduct(input: {
  readonly name: string;
  readonly slug: string;
  readonly categoryId?: string | undefined;
  readonly description?: string | undefined;
  readonly pricePoisha: string;
  readonly status: 'draft' | 'active';
  /** The sizes and colours chosen; empty makes one plain SKU. */
  readonly axes?: readonly { readonly attributeId: string; readonly valueIds: readonly string[] }[];
  /** Prices that differ from `pricePoisha`, named by their value ids (D-422). */
  readonly variantPrices?: readonly {
    readonly valueIds: readonly string[];
    readonly pricePoisha: string;
  }[];
}): Promise<CatalogProduct> {
  const { axes, variantPrices, ...rest } = input;
  return api.post('/v1/catalog/products', {
    ...rest,
    axes: axes ?? [],
    generateSkus: true,
    ...(variantPrices === undefined || variantPrices.length === 0 ? {} : { variantPrices }),
  });
}

export function updateProduct(
  id: string,
  patch: {
    readonly name?: string;
    readonly categoryId?: string | null;
    readonly description?: string | null;
    readonly status?: 'draft' | 'active' | 'archived';
  },
): Promise<CatalogProduct> {
  return api.patch(`/v1/catalog/products/${id}`, patch);
}

/** Archive a SKU or bring it back (D-423). */
export function updateSku(
  id: string,
  status: 'active' | 'archived',
): Promise<{ id: string; skuCode: string; status: string }> {
  return api.patch(`/v1/catalog/skus/${id}`, { status });
}

export function updateCategory(
  id: string,
  patch: {
    readonly name?: string;
    readonly parentId?: string | null;
    readonly isActive?: boolean;
  },
): Promise<CatalogCategory> {
  return api.patch(`/v1/catalog/categories/${id}`, patch);
}

export function updateAttribute(id: string, patch: { readonly name: string }): Promise<unknown> {
  return api.patch(`/v1/catalog/attributes/${id}`, patch);
}

export function updateAttributeValue(
  attributeId: string,
  valueId: string,
  patch: { readonly label: string },
): Promise<unknown> {
  return api.patch(`/v1/catalog/attributes/${attributeId}/values/${valueId}`, patch);
}

export interface ProductImportReport {
  readonly totalRows: number;
  readonly willCreate: number;
  readonly skuCount: number;
  readonly problems: readonly ImportProblem[];
  readonly canCommit: boolean;
  readonly reason: string | null;
  readonly preview: readonly {
    readonly line: number;
    readonly name: string;
    readonly categoryName: string | null;
    readonly pricePoisha: string;
    readonly status: 'draft' | 'active';
    readonly sizes: readonly string[];
    readonly colours: readonly string[];
    readonly variantCount: number;
  }[];
}

export function dryRunProductImport(csv: string): Promise<ProductImportReport> {
  return api.post('/v1/catalog/imports/products/dry-run', { csv });
}

export function commitProductImport(
  csv: string,
): Promise<{ created: number; skuCount: number; products: { id: string; name: string }[] }> {
  return api.post('/v1/catalog/imports/products', { csv });
}

/** A short-lived address for a product photo (`GET /v1/files/:id/download`). */
export function imageUrl(fileId: string): Promise<{ url: string }> {
  return api.get(`/v1/files/${fileId}/download`);
}

export interface SkuSearchRow {
  readonly id: string;
  readonly productId: string;
  readonly name: string;
  readonly skuCode: string;
  readonly status: 'active' | 'archived';
}

/** SKUs across the whole catalog, for pickers. Under three characters it lists by code. */
export function searchSkus(q: string, limit = 50): Promise<{ items: SkuSearchRow[] }> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (q.trim().length >= 3) params.set('q', q.trim());
  return api.get(`/v1/catalog/skus?${params.toString()}`);
}

export function createCategory(input: {
  readonly name: string;
  readonly slug: string;
  readonly code: string;
  readonly parentId?: string | undefined;
}): Promise<{ id: string; path: string; depth: number }> {
  return api.post('/v1/catalog/categories', input);
}

export function createAttribute(input: {
  readonly code: string;
  readonly name: string;
  readonly kind: 'size' | 'colour' | 'custom';
  readonly isVariant: boolean;
  readonly position?: number;
}): Promise<{ id: string; code: string }> {
  return api.post('/v1/catalog/attributes', input);
}

export function createAttributeValue(
  attributeId: string,
  input: { readonly code: string; readonly label: string; readonly position?: number },
): Promise<{ id: string; code: string }> {
  return api.post(`/v1/catalog/attributes/${attributeId}/values`, input);
}

/**
 * Extend the matrix.
 *
 * The endpoint is `POST .../variants` and it **adds**. There is deliberately no
 * client function that replaces a product's matrix, because there is no such
 * endpoint: the SKUs it would drop have stock movements, order lines and printed
 * labels behind them (M06 check 1).
 */
export function addVariants(
  productId: string,
  input: {
    readonly axes: readonly {
      readonly attributeId: string;
      readonly valueIds: readonly string[];
    }[];
    readonly pricePoisha?: string | undefined;
  },
): Promise<{
  created: string[];
  unchanged: number;
  orphaned: string[];
  product: CatalogProduct;
}> {
  return api.post(`/v1/catalog/products/${productId}/variants`, input);
}

export function setPrices(input: {
  readonly prices: readonly { readonly skuId: string; readonly pricePoisha: string }[];
  readonly reason?: string | undefined;
}): Promise<{ repriced: number }> {
  return api.put('/v1/catalog/prices', input);
}

export function priceHistory(skuId: string): Promise<{
  items: {
    fromPricePoisha: string | null;
    toPricePoisha: string;
    changedBy: string | null;
    reason: string | null;
    changedAt: string;
  }[];
}> {
  return api.get(`/v1/catalog/skus/${skuId}/price-history`);
}

export function attachImage(
  productId: string,
  input: { readonly fileId: string; readonly altText?: string | undefined },
): Promise<{ id: string; fileId: string; position: number }> {
  return api.post(`/v1/catalog/products/${productId}/images`, input);
}

export function reorderImages(
  productId: string,
  imageIds: readonly string[],
): Promise<{ ordered: number }> {
  return api.put(`/v1/catalog/products/${productId}/images/order`, { imageIds });
}

export function detachImage(productId: string, imageId: string): Promise<{ id: string }> {
  return api.delete(`/v1/catalog/products/${productId}/images/${imageId}`);
}

export function dryRunPriceImport(csv: string): Promise<ImportReport> {
  return api.post('/v1/catalog/imports/prices/dry-run', { csv });
}

export function commitPriceImport(
  csv: string,
  reason?: string,
): Promise<{ applied: number; unchanged: number }> {
  return api.post('/v1/catalog/imports/prices', {
    csv,
    ...(reason === undefined ? {} : { reason }),
  });
}

/** Where stickers are printed (M38a, D-604): a thermal roll, or an A4 sheet. */
export type StickerMediumId =
  'thermal-38x25' | 'thermal-40x30' | 'thermal-50x25' | 'a4-3x8' | 'a4-4x10';

/**
 * Barcode stickers, as a PDF blob (M06's label sheet, M38a's media).
 *
 * Not through `api.post`, which parses JSON: this response is a PDF. A refusal still comes
 * back as problem+json, and its message is kept so the dialog can say what was wrong.
 */
export async function stickersPdf(input: {
  readonly items: readonly { readonly skuId: string; readonly copies: number }[];
  readonly showPrice: boolean;
  readonly medium: StickerMediumId;
  readonly startAt: number;
}): Promise<Blob> {
  const response = await fetch(new URL('/v1/catalog/labels', env.VITE_API_URL), {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json', ...csrfHeader() },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    const problem = (await response.json().catch(() => null)) as {
      code?: string;
      detail?: string;
      message?: string;
    } | null;
    throw new ApiError(
      response.status,
      problem?.code ?? null,
      problem?.detail ?? problem?.message ?? 'The stickers could not be produced.',
    );
  }
  return response.blob();
}

/** What a scanned code is (M38a, D-605). No cost unless the caller may read it. */
export interface CodeLookup {
  readonly code: string;
  readonly product: { readonly id: string; readonly name: string; readonly status: string };
  readonly sku: {
    readonly id: string;
    readonly code: string;
    readonly barcode: string | null;
    readonly status: 'active' | 'archived';
    readonly variantLabel: string;
    readonly pricePoisha: string;
  };
  readonly stock: {
    readonly onHand: number;
    readonly available: number;
    readonly locations: readonly {
      readonly locationId: string;
      readonly locationName: string;
      readonly onHand: number;
      readonly available: number;
    }[];
  } | null;
}

export function lookupCode(code: string): Promise<CodeLookup> {
  return api.get(`/v1/catalog/lookup?code=${encodeURIComponent(code)}`);
}
