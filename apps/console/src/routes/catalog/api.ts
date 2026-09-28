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

/**
 * PUT and DELETE, and one blob response.
 *
 * The shared client exposes `get` and `post` only, and adding `put`/`delete` to it
 * belongs in that file rather than here — it is edited concurrently by other
 * milestones in this working tree, so M06's INTEGRATION section hands the
 * integrator those two methods and this helper disappears with them.
 *
 * Until then the two things it must not get wrong are the two the shared client
 * exists for: cookies cross-origin (`credentials: 'include'`, or the session
 * cookie is never sent and every request looks anonymous) and the CSRF token
 * echoed back as a header.
 */
async function send<T>(method: 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const response = await fetch(new URL(path, env.VITE_API_URL), {
    method,
    credentials: 'include',
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...csrfHeader(),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  const text = await response.text();
  const payload: unknown = text === '' ? null : safeParse(text);
  if (!response.ok) {
    const problem = (payload ?? {}) as { code?: unknown; detail?: unknown; message?: unknown };
    throw new ApiError(
      response.status,
      typeof problem.code === 'string' ? problem.code : null,
      typeof problem.detail === 'string'
        ? problem.detail
        : typeof problem.message === 'string'
          ? problem.message
          : response.statusText,
    );
  }
  return payload as T;
}

function csrfHeader(): Record<string, string> {
  const token = csrfToken();
  return token === '' ? {} : { [CSRF_HEADER]: token };
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
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
  readonly pricePoisha: string;
  readonly status: 'draft' | 'active';
}): Promise<CatalogProduct> {
  return api.post('/v1/catalog/products', { ...input, axes: [], generateSkus: false });
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
}): Promise<{ id: string; code: string }> {
  return api.post('/v1/catalog/attributes', input);
}

export function createAttributeValue(
  attributeId: string,
  input: { readonly code: string; readonly label: string },
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
  return send('PUT', '/v1/catalog/prices', input);
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
  return send('PUT', `/v1/catalog/products/${productId}/images/order`, { imageIds });
}

export function detachImage(productId: string, imageId: string): Promise<{ id: string }> {
  return send('DELETE', `/v1/catalog/products/${productId}/images/${imageId}`);
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

/**
 * The label sheet, as a blob.
 *
 * Not through `api.post`, which parses JSON: this response is a PDF. Written out
 * here rather than adding a method to the shared client, which is one of the files
 * other milestones are editing in this working tree — M06's INTEGRATION section
 * hands the integrator the shared `api.blob()` it should become.
 */
export async function labelSheetPdf(
  items: readonly { readonly skuId: string; readonly copies: number }[],
  showPrice: boolean,
): Promise<Blob> {
  const response = await fetch(new URL('/v1/catalog/labels', env.VITE_API_URL), {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json', ...csrfHeader() },
    body: JSON.stringify({ items, showPrice }),
  });
  if (!response.ok) throw new Error('The label sheet could not be produced.');
  return response.blob();
}
