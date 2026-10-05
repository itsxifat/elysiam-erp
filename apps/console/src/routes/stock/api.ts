import { api, ApiError, CSRF_HEADER, csrfToken } from '../../api.js';
import { env } from '../../env.js';

/**
 * `/v1/inventory/*`, typed to what the controller actually returns.
 *
 * Hand-written against the controller rather than taken from the generated client,
 * for the reason M06's catalog client gives: M04's generator types every operation's
 * result as `unknown`, and an `unknown` at the call site gets cast somewhere — a cast
 * inside a page component is a type nobody maintains.
 *
 * **Every quantity is a number and every amount is a string.** §23: integer poisha
 * crosses the wire as a decimal string, because `JSON.parse` turns a crore-scale
 * value into a double and loses its last digits. `<Money>` takes the string directly.
 * Quantities are genuinely small integers and stay numbers.
 *
 * **The cost fields are optional in these types, and that is the point.**
 * `wacPoisha` and `stockValuePoisha` are removed by `serializeFor` for any caller
 * without `read Cost` (invariant 5), so the server really does return rows without
 * them — typing them as required would make every screen render `undefined` into a
 * `<Money>` for a sales agent. Declared `| undefined` so TypeScript makes each screen
 * decide what to show when they are absent.
 */

async function send<T>(method: 'PUT', path: string, body?: unknown): Promise<T> {
  // The shared client exposes `get` and `post` only. Adding `put` belongs in that
  // file, which is edited concurrently by other milestones in this working tree, so
  // M07's INTEGRATION section hands the integrator that method and this helper
  // disappears with it. The two things it must not get wrong are the two the shared
  // client exists for: cookies cross-origin, and the CSRF token echoed as a header.
  const token = csrfToken();
  const response = await fetch(new URL(path, env.VITE_API_URL), {
    method,
    credentials: 'include',
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token === '' ? {} : { [CSRF_HEADER]: token }),
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

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function query(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text === '' ? '' : `?${text}`;
}

export interface StockLocation {
  readonly id: string;
  readonly branchId: string | null;
  readonly code: string;
  readonly name: string;
  readonly kind: 'warehouse' | 'showroom' | 'damaged' | 'in_transit';
  readonly isActive: boolean;
}

export interface StockRow {
  readonly skuId: string;
  readonly skuCode: string;
  readonly productId: string;
  readonly productName: string;
  /** Size, colour… as a person says it (`M / Red`); empty for a plain SKU. */
  readonly variantLabel: string;
  readonly skuStatus: 'active' | 'archived';
  readonly locationId: string;
  readonly locationCode: string;
  readonly locationName: string;
  readonly branchId: string | null;
  readonly onHand: number;
  readonly reserved: number;
  readonly available: number;
  readonly reorderLevel: number;
  /** Cost roles only. Absent for everyone else (invariant 5). */
  readonly wacPoisha?: string | undefined;
  readonly stockValuePoisha?: string | undefined;
}

export interface AdjustmentRow {
  readonly id: string;
  readonly locationId: string;
  readonly branchId: string | null;
  readonly direction: 'loss' | 'gain';
  readonly status: 'pending_approval' | 'posted' | 'rejected';
  readonly countSessionId: string | null;
  readonly stockValuePoisha?: string | undefined;
  readonly reason: string;
  readonly approvalId: string | null;
  readonly journalId: string | null;
  readonly businessDate: string;
  readonly createdBy: string;
}

export interface TransferRow {
  readonly id: string;
  readonly fromLocationId: string;
  readonly toLocationId: string;
  readonly transitLocationId: string;
  readonly status: 'dispatched' | 'received' | 'cancelled';
  readonly memo: string | null;
  readonly createdBy: string;
  readonly receivedBy: string | null;
  readonly lines: readonly { skuId: string; qty: number }[];
}

export interface CountLine {
  readonly skuId: string;
  readonly skuCode: string;
  readonly snapshotQty: number;
  readonly countedQty: number | null;
  readonly varianceQty: number | null;
}

export interface CountSession {
  readonly id: string;
  readonly locationId: string;
  readonly branchId: string | null;
  readonly status: 'open' | 'submitted' | 'closed' | 'cancelled';
  readonly memo: string | null;
  readonly createdBy: string;
  readonly lines: readonly CountLine[];
}

export interface Reconciliation {
  readonly id: string;
  readonly businessDate: string;
  readonly levelsChecked: number;
  readonly driftCount: number;
  readonly costDriftCount: number;
  readonly ranAt: string;
}

export function listLocations(): Promise<{ items: StockLocation[] }> {
  return api.get('/v1/inventory/locations');
}

export function listStock(input: {
  readonly locationId?: string | undefined;
  readonly q?: string | undefined;
  readonly productId?: string | undefined;
  readonly categoryId?: string | undefined;
  readonly low?: boolean | undefined;
  readonly page: number;
  readonly pageSize: number;
}): Promise<{ items: StockRow[]; page: number; pageSize: number }> {
  return api.get(
    `/v1/inventory/stock${query({
      locationId: input.locationId,
      q: input.q,
      productId: input.productId,
      categoryId: input.categoryId,
      low: input.low === true ? true : undefined,
      page: input.page,
      pageSize: input.pageSize,
    })}`,
  );
}

export function stockValuation(
  locationId?: string,
): Promise<{ units: number; stockValuePoisha: string }> {
  return api.get(`/v1/inventory/valuation${query({ locationId })}`);
}

export function listAdjustments(status?: string): Promise<{ items: AdjustmentRow[] }> {
  return api.get(`/v1/inventory/adjustments${query({ status })}`);
}

export function requestAdjustment(input: {
  readonly locationId: string;
  readonly direction: 'loss' | 'gain';
  readonly reason: string;
  readonly lines: readonly { skuId: string; qty: number }[];
}): Promise<AdjustmentRow> {
  return api.post('/v1/inventory/adjustments', input);
}

export function listTransfers(status?: string): Promise<{ items: TransferRow[] }> {
  return api.get(`/v1/inventory/transfers${query({ status })}`);
}

export function dispatchTransfer(input: {
  readonly fromLocationId: string;
  readonly toLocationId: string;
  readonly memo?: string;
  readonly lines: readonly { skuId: string; qty: number }[];
}): Promise<TransferRow> {
  return api.post('/v1/inventory/transfers', input);
}

export function receiveTransfer(id: string): Promise<TransferRow> {
  return api.post(`/v1/inventory/transfers/${id}/receive`);
}

export function listCounts(): Promise<{ items: CountSession[] }> {
  return api.get('/v1/inventory/counts');
}

export function getCount(id: string): Promise<CountSession> {
  return api.get(`/v1/inventory/counts/${id}`);
}

export function openCount(input: {
  readonly locationId: string;
  readonly memo?: string;
}): Promise<CountSession> {
  return api.post('/v1/inventory/counts', input);
}

export function recordCounts(
  id: string,
  lines: readonly { skuId: string; countedQty: number }[],
  note?: string,
): Promise<CountSession> {
  return send('PUT', `/v1/inventory/counts/${id}/lines`, {
    lines,
    ...(note === undefined || note.trim() === '' ? {} : { note: note.trim() }),
  });
}

/** One scan on an open count (M38a, D-606): one more piece of that SKU. */
export function scanCount(
  id: string,
  input: { readonly scanId: string; readonly code: string },
): Promise<{ skuId: string; skuCode: string; countedQty: number; duplicate: boolean }> {
  return api.post(`/v1/inventory/counts/${id}/scans`, input);
}

export function submitCount(id: string): Promise<CountSession> {
  return api.post(`/v1/inventory/counts/${id}/submit`);
}

export function closeCount(
  id: string,
): Promise<{ session: CountSession; adjustments: AdjustmentRow[] }> {
  return api.post(`/v1/inventory/counts/${id}/close`);
}

export function listReconciliations(): Promise<{ items: Reconciliation[] }> {
  return api.get('/v1/inventory/reconciliations');
}

export interface MovementRow {
  readonly id: string;
  readonly skuId: string;
  readonly skuCode: string;
  readonly locationId: string;
  readonly locationCode: string;
  readonly locationName: string;
  readonly locationKind: 'warehouse' | 'showroom' | 'damaged' | 'in_transit';
  readonly kind: string;
  readonly qtyDelta: number;
  readonly refType: string;
  readonly businessDate: string;
  readonly memo: string | null;
  readonly createdAt: string;
}

/** A product's stock history (D-427), newest first. */
export function listMovements(input: {
  readonly productId?: string | undefined;
  readonly skuId?: string | undefined;
  readonly page?: number;
  readonly pageSize?: number;
}): Promise<{ items: MovementRow[] }> {
  return api.get(
    `/v1/inventory/movements${query({
      productId: input.productId,
      skuId: input.skuId,
      page: input.page ?? 1,
      pageSize: input.pageSize ?? 50,
    })}`,
  );
}

/** A SKU's low-stock level at one location (`PUT /v1/inventory/reorder-levels`). */
export function setReorderLevel(input: {
  readonly skuId: string;
  readonly locationId: string;
  readonly reorderLevel: number;
}): Promise<unknown> {
  return api.put('/v1/inventory/reorder-levels', input);
}

export function listAllLocations(): Promise<{ items: StockLocation[] }> {
  return api.get('/v1/inventory/locations?includeInactive=true');
}

export function createLocation(input: {
  readonly code: string;
  readonly name: string;
  readonly kind: 'warehouse' | 'showroom';
  readonly branchId?: string | undefined;
}): Promise<StockLocation> {
  return api.post('/v1/inventory/locations', input);
}

export function updateLocation(
  id: string,
  patch: { readonly name?: string; readonly isActive?: boolean },
): Promise<unknown> {
  return api.patch(`/v1/inventory/locations/${id}`, patch);
}

/** Branches a showroom can belong to (`GET /v1/hr/branch-options`, D-419). */
export function listBranchOptions(): Promise<{
  items: { id: string; code: string; name: string }[];
}> {
  return api.get('/v1/hr/branch-options');
}

// --- stock in hand and the opening stock window (M38a, D-602) --------------------

export interface OpeningStockWindow {
  readonly open: boolean;
  readonly closedAt: string | null;
  readonly closedBy: string | null;
  readonly reopenedAt: string | null;
  readonly reopenPending: boolean;
}

export interface StockInHandListItem {
  readonly id: string;
  readonly status: 'draft' | 'posted';
  readonly locationId: string;
  readonly locationName: string;
  readonly memo: string | null;
  readonly lineCount: number;
  readonly totalQty: number;
  readonly businessDate: string | null;
  readonly createdAt: string;
  readonly postedAt: string | null;
  /** Cost: absent for a role without `read Cost`. Null while a line is unpriced. */
  readonly stockValuePoisha?: string | null | undefined;
}

export interface StockInHandEntry {
  readonly id: string;
  readonly status: 'draft' | 'posted';
  readonly locationId: string;
  readonly locationName: string;
  readonly memo: string | null;
  readonly businessDate: string | null;
  readonly postedAt: string | null;
  readonly costWithheld: boolean;
  readonly stockValuePoisha?: string | null | undefined;
  readonly lines: readonly {
    readonly skuId: string;
    readonly skuCode: string;
    readonly barcode: string | null;
    readonly productName: string;
    readonly variantLabel: string;
    readonly qty: number;
    readonly unitCostPoisha?: string | null | undefined;
  }[];
}

export function openingStockWindow(): Promise<OpeningStockWindow> {
  return api.get('/v1/inventory/stock-in-hand/window');
}

export function closeOpeningStock(note?: string): Promise<OpeningStockWindow> {
  return api.post('/v1/inventory/stock-in-hand/window/close', note === undefined ? {} : { note });
}

export function requestOpeningStockReopen(
  reason: string,
): Promise<{ approvalId: string; status: string }> {
  return api.post('/v1/inventory/stock-in-hand/window/reopen', { reason });
}

export function listStockInHand(): Promise<{
  items: StockInHandListItem[];
  costWithheld: boolean;
}> {
  return api.get('/v1/inventory/stock-in-hand');
}

export function getStockInHand(id: string): Promise<StockInHandEntry> {
  return api.get(`/v1/inventory/stock-in-hand/${id}`);
}

/** Enter and post, with a cost per piece on every line (`read Cost`). */
export function postStockInHand(input: {
  readonly entryId: string;
  readonly locationId: string;
  readonly memo?: string;
  readonly lines: readonly { skuId: string; qty: number; unitCostPoisha: string }[];
}): Promise<{ id: string; status: 'posted'; journalId: string | null }> {
  return api.post('/v1/inventory/stock-in-hand', input);
}

/** A quantity-only draft, for accounts to price (warehouse). */
export function draftStockInHand(input: {
  readonly entryId: string;
  readonly locationId: string;
  readonly memo?: string;
  readonly lines: readonly { skuId: string; qty: number }[];
}): Promise<{ id: string; status: 'draft' }> {
  return api.post('/v1/inventory/stock-in-hand/drafts', input);
}

export function updateStockInHandDraft(
  id: string,
  patch: {
    readonly locationId?: string;
    readonly memo?: string | null;
    readonly lines?: readonly { skuId: string; qty: number }[];
  },
): Promise<{ id: string; status: 'draft' }> {
  return api.patch(`/v1/inventory/stock-in-hand/drafts/${id}`, patch);
}

export function deleteStockInHandDraft(id: string): Promise<{ id: string }> {
  return api.delete(`/v1/inventory/stock-in-hand/drafts/${id}`);
}

/** Price a draft and post it (`read Cost`). */
export function postStockInHandDraft(
  id: string,
  lines: readonly { skuId: string; unitCostPoisha: string }[],
): Promise<{ id: string; status: 'posted' }> {
  return api.post(`/v1/inventory/stock-in-hand/${id}/post`, { lines });
}
