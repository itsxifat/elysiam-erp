import { api, ApiError } from '../../api.js';
import { env } from '../../env.js';

/**
 * `/v1/courier/*`, typed to what the controller returns (M12, M15).
 *
 * Hand-written against the controller, for the reason every other section gives: M04's
 * generated client types each response as `unknown`, and an `unknown` gets cast somewhere —
 * a cast in a page component is a type nobody maintains.
 *
 * **Every amount is a string and stays one.** §23 sends integer poisha as a decimal string,
 * because `JSON.parse` turns a crore-scale total into a double and silently drops its last
 * digits; `<Money>` takes the string. Counts and basis points are small integers and are
 * numbers.
 *
 * **No recipient data in any of these types.** The courier screens show order numbers,
 * consignment numbers and amounts; the recipient's phone and address are the order desk's
 * and the label's business, and a list that carried them would be one more place a phone
 * number sits in a browser's memory for no reason (invariant 10).
 */

export type ParcelStatus =
  | 'booked'
  | 'pickup_pending'
  | 'picked_up'
  | 'in_transit'
  | 'out_for_delivery'
  | 'hold'
  | 'delivered'
  | 'partial_delivered'
  | 'return_in_transit'
  | 'returned_to_merchant'
  | 'cancelled'
  | 'unknown';

export type BookingState = 'pending' | 'booked' | 'failed' | 'cancelled';

export interface ParcelRow {
  readonly id: string;
  readonly orderId: string;
  readonly orderNo: string;
  readonly courierId: string;
  readonly courierName: string;
  readonly branchId: string | null;
  readonly consignmentNo: string | null;
  readonly trackingCode: string | null;
  readonly bookingState: BookingState;
  readonly status: ParcelStatus;
  readonly rawStatus: string | null;
  readonly codAmountPoisha: string;
  readonly collectedPoisha: string | null;
  readonly bookedAt: string | null;
  readonly statusChangedAt: string | null;
  readonly hasReturnReceipt: boolean;
}

export type StuckReason = 'no_status_change' | 'unknown_status' | 'booking_failed';

export interface StuckParcel {
  readonly consignmentId: string;
  readonly orderId: string;
  readonly orderNo: string;
  readonly courierId: string;
  readonly courierName: string;
  readonly consignmentNo: string | null;
  readonly trackingCode: string | null;
  readonly status: ParcelStatus;
  readonly rawStatus: string | null;
  readonly lastEventRawStatus: string | null;
  readonly bookingState: BookingState;
  readonly bookingFailureCode: string | null;
  readonly codAmountPoisha: string;
  readonly statusSince: string;
  readonly daysStuck: number;
  readonly reasons: readonly StuckReason[];
  readonly escalationCount: number;
  readonly lastEscalationNote: string | null;
}

export interface PerformanceRow {
  readonly courierId: string;
  readonly courierName: string;
  readonly deliveryZoneId: string | null;
  readonly booked: number;
  readonly delivered: number;
  readonly partial: number;
  readonly returned: number;
  readonly cancelled: number;
  readonly inFlight: number;
  readonly resolved: number;
  readonly deliveryRateBps: number | null;
  readonly returnRateBps: number | null;
  readonly averageDeliveryDays: string | null;
}

export type SettlementStatus = 'imported' | 'pending_approval' | 'posted' | 'rejected';
export type SettlementMatch =
  | 'matched'
  | 'unmatched'
  | 'amount_mismatch'
  | 'duplicate'
  | 'already_settled';

export interface SettlementRow {
  readonly id: string;
  readonly courierId: string;
  readonly reference: string | null;
  readonly settlementDate: string;
  readonly postingBusinessDate: string | null;
  readonly deferredFromClosedPeriod: boolean;
  readonly status: SettlementStatus;
  readonly source: 'upload' | 'api';
  readonly fileRowCount: number;
  readonly matchedGrossPoisha: string;
  readonly matchedChargesPoisha: string;
  readonly matchedNetPoisha: string;
  readonly matchedRowCount: number;
  readonly exceptionCount: number;
  readonly approvalRequestId: string | null;
  readonly rejectedReason: string | null;
}

export interface SettlementLine {
  readonly id: string;
  readonly rowNo: number;
  readonly consignmentNo: string;
  readonly reference: string | null;
  readonly match: SettlementMatch;
  readonly codCollectedPoisha: string;
  readonly netPoisha: string;
  readonly expectedPoisha: string | null;
  readonly note: string | null;
}

export interface FetchRun {
  readonly id: string;
  readonly courierAccountId: string;
  readonly startedAt: string;
  readonly seen: number;
  readonly created: number;
  readonly duplicate: number;
  readonly refused: number;
  readonly error: string | null;
}

export interface CourierAccount {
  readonly id: string;
  readonly courierId: string;
  readonly label: string;
  readonly providerCode: string;
  readonly isActive: boolean;
  readonly verified: boolean;
}

export interface ParcelTimeline {
  readonly consignment: {
    readonly id: string;
    readonly orderId: string;
    readonly orderNo: string;
    readonly courierId: string;
    readonly consignmentNo: string | null;
    readonly trackingCode: string | null;
    readonly bookingState: BookingState;
    readonly bookingFailureCode: string | null;
    readonly status: ParcelStatus;
    readonly rawStatus: string | null;
    readonly codAmountPoisha: string;
    readonly collectedPoisha: string | null;
    readonly bookedAt: string | null;
    readonly deliveredAt: string | null;
    readonly returnedAt: string | null;
    readonly settlementId: string | null;
    readonly statusChangedAt: string | null;
    readonly isFinal: boolean;
  };
  readonly events: readonly {
    readonly id: string;
    readonly source: 'webhook' | 'poll' | 'manual';
    readonly status: ParcelStatus;
    readonly rawStatus: string;
    readonly occurredAt: string;
    readonly orderToStatus: string | null;
  }[];
  readonly escalations: readonly {
    readonly id: string;
    readonly note: string;
    readonly createdAt: string;
  }[];
}

export interface Returnable {
  readonly consignmentId: string;
  readonly orderNo: string;
  readonly alreadyReceivedId: string | null;
  readonly lines: readonly { skuId: string; skuCode: string; outstandingQty: number }[];
}

export interface Location {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly kind: string;
  readonly isActive: boolean;
}

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text === '' ? '' : `?${text}`;
}

export function listParcels(filter: {
  q?: string | undefined;
  status?: string | undefined;
  courierId?: string | undefined;
  awaitingReturn?: boolean;
  page: number;
  pageSize: number;
}): Promise<{ items: readonly ParcelRow[] }> {
  return api.get(
    `/v1/courier/parcels${query({
      q: filter.q,
      status: filter.status,
      courierId: filter.courierId,
      awaitingReturn: filter.awaitingReturn === undefined ? undefined : String(filter.awaitingReturn),
      page: filter.page,
      pageSize: filter.pageSize,
    })}`,
  );
}

export function parcelTimeline(consignmentId: string): Promise<ParcelTimeline> {
  return api.get(`/v1/courier/parcels/${consignmentId}`);
}

export function listAccounts(): Promise<{ items: readonly CourierAccount[] }> {
  return api.get('/v1/courier/accounts');
}

export function stuckParcels(input: {
  thresholdDays: number;
  courierId?: string | undefined;
}): Promise<{ thresholdDays: number; cutoffDate: string; items: readonly StuckParcel[] }> {
  return api.get(`/v1/courier/stuck${query(input)}`);
}

export function repoll(consignmentIds: readonly string[]): Promise<{ queued: number; skipped: number }> {
  return api.post('/v1/courier/stuck/repoll', { consignmentIds });
}

export function escalate(consignmentId: string, note: string): Promise<{ id: string }> {
  return api.post(`/v1/courier/parcels/${consignmentId}/escalations`, { note });
}

export function performance(input: {
  from?: string | undefined;
  to?: string | undefined;
  courierId?: string | undefined;
}): Promise<{
  from: string;
  to: string;
  rows: readonly PerformanceRow[];
  couriers: readonly PerformanceRow[];
}> {
  return api.get(`/v1/courier/reports/performance${query(input)}`);
}

export function listSettlements(): Promise<{ items: readonly SettlementRow[] }> {
  return api.get('/v1/courier/settlements');
}

export function getSettlement(
  settlementId: string,
): Promise<SettlementRow & { lines: readonly SettlementLine[] }> {
  return api.get(`/v1/courier/settlements/${settlementId}`);
}

export function requestSettlementApproval(
  settlementId: string,
): Promise<{ approvalRequestId: string; status: string }> {
  return api.post(`/v1/courier/settlements/${settlementId}/approval`, {});
}

export function rejectSettlement(settlementId: string, reason: string): Promise<unknown> {
  return api.post(`/v1/courier/settlements/${settlementId}/reject`, { reason });
}

export function fetchSettlements(courierId: string): Promise<{ queued: boolean }> {
  return api.post('/v1/courier/settlements/fetch', { courierId });
}

export function fetchRuns(): Promise<{ items: readonly FetchRun[] }> {
  return api.get('/v1/courier/settlements/fetch-runs');
}

export function returnable(consignmentId: string): Promise<Returnable> {
  return api.get(`/v1/courier/parcels/${consignmentId}/returnable`);
}

export function receiveReturn(
  consignmentId: string,
  input: {
    reason: string;
    inspectionNote?: string;
    damagedLocationId?: string;
    lines: readonly { skuId: string; sellableQty: number; damagedQty: number }[];
  },
): Promise<unknown> {
  return api.post(`/v1/courier/parcels/${consignmentId}/receive-return`, input);
}

export function listLocations(): Promise<{ items: readonly Location[] }> {
  return api.get('/v1/inventory/locations');
}

/** Zones and courier names, from the orders module's own list (M10). */
export function deliveryZones(): Promise<{
  zones: readonly { id: string; code: string; nameEn: string; nameBn: string }[];
  couriers: readonly { id: string; code: string; name: string }[];
}> {
  return api.get('/v1/delivery-zones');
}

/**
 * A file from the API — the label PDF or the stuck-parcel CSV — as a blob URL to open.
 *
 * The shared client parses JSON, so bytes are fetched here, with the session cookie. A `GET`,
 * so no CSRF header is needed. The caller revokes the URL when it is done with it.
 */
export async function fileUrl(path: string): Promise<string> {
  const response = await fetch(new URL(path, env.VITE_API_URL), { credentials: 'include' });
  if (!response.ok) {
    let code: string | null = null;
    let message = response.statusText;
    try {
      const problem = (await response.json()) as { code?: unknown; detail?: unknown };
      if (typeof problem.code === 'string') code = problem.code;
      if (typeof problem.detail === 'string') message = problem.detail;
    } catch {
      // Not a problem document; the status text stands.
    }
    throw new ApiError(response.status, code, message);
  }
  return URL.createObjectURL(await response.blob());
}

export function labelsPath(consignmentIds: readonly string[]): string {
  return `/v1/courier/labels?ids=${consignmentIds.join(',')}`;
}

export function stuckExportPath(thresholdDays: number, courierId?: string): string {
  return `/v1/courier/stuck/export${query({ thresholdDays, courierId })}`;
}
