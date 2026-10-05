import { api } from '../../api.js';
import { env } from '../../env.js';
import type { ReturnReason } from './returns-logic.js';

/**
 * `/v1/orders`, `/v1/customers`, `/v1/delivery-zones`, `/v1/catalog/skus` and
 * `/v1/buyers`, typed to what the controllers actually return (M10, M11).
 *
 * Hand-written for the reason M06's catalog client gives: the generated client types every
 * result as `unknown`, and an `unknown` gets cast inside a page component, where nobody
 * maintains it. These types are the controllers' view objects, field for field.
 *
 * **Every amount is a decimal string of poisha** (§23). `<Money>` takes it as it is; the one
 * place that adds amounts up — the desk's preview — does it in `bigint` in `desk-logic.ts`.
 *
 * **There is no cost field in any of these types**, and that is the point: the desk's
 * responses carry selling prices only, and a field for a cost would be an invitation for
 * the server to start sending one (invariant 5).
 */

export const ORDER_STATUSES = [
  'pending',
  'confirmed',
  'on_hold',
  'packed',
  'shipped',
  'delivered',
  'partially_delivered',
  'return_in_transit',
  'returned',
  'cancelled',
  'exchange',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const ORDER_CHANNELS = [
  'facebook',
  'whatsapp',
  'instagram',
  'tiktok',
  'landing_page',
  'website',
  'phone',
  'walk_in',
  'reseller',
] as const;
export type OrderChannel = (typeof ORDER_CHANNELS)[number];

/** The channels an agent enters by hand. The rest arrive through their own paths. */
export const DESK_CHANNELS: readonly OrderChannel[] = [
  'facebook',
  'whatsapp',
  'instagram',
  'tiktok',
  'phone',
  'website',
];

export interface OrderRow {
  readonly id: string;
  readonly orderNo: string;
  readonly status: OrderStatus;
  readonly channel: OrderChannel;
  readonly source: Record<string, unknown> | null;
  readonly branchId: string | null;
  readonly customer: { readonly id: string; readonly name: string; readonly phone: string };
  readonly shipTo: {
    readonly name: string;
    readonly phone: string;
    readonly districtId: number;
    readonly thanaId: number;
    readonly area: string | null;
    readonly addressLine: string;
  };
  readonly deliveryZoneId: string | null;
  readonly amounts: {
    readonly itemsPoisha: string;
    readonly discountPoisha: string;
    readonly deliveryChargePoisha: string;
    readonly advancePaidPoisha: string;
    readonly codAmountPoisha: string;
  };
  readonly holdReason: string | null;
  readonly cancelReason: string | null;
  readonly assignedTo: string | null;
  readonly createdBy: string;
  readonly notes: string | null;
  readonly timestamps: { readonly createdAt: string; readonly confirmedAt: string | null };
}

export interface OrderLine {
  readonly id: string;
  readonly skuId: string;
  readonly skuCode: string;
  readonly productName: string;
  readonly qty: number;
  readonly unitPricePoisha: string;
  readonly discountPoisha: string;
}

export type TimelineEntry =
  | {
      readonly kind: 'status';
      readonly id: string;
      readonly at: string;
      readonly from: OrderStatus | null;
      readonly to: OrderStatus;
      readonly trigger: string;
      readonly reason: string | null;
      readonly actorUserId: string | null;
    }
  | {
      readonly kind: 'activity';
      readonly id: string;
      readonly at: string;
      readonly action: string;
      readonly actorUserId: string | null;
    };

/** A move §9's machine allows from the order's status (D-392). */
export interface AvailableTransition {
  readonly trigger: OrderTrigger;
  readonly to: OrderStatus;
  readonly requiresReason: boolean;
  readonly requiresReturnReason: boolean;
}

export type OrderTrigger =
  | 'confirm'
  | 'hold'
  | 'release_hold'
  | 'cancel'
  | 'pack'
  | 'ship'
  | 'deliver'
  | 'deliver_partially'
  | 'start_return'
  | 'receive_return'
  | 'exchange';

export interface OrderDetail extends OrderRow {
  readonly courierId: string | null;
  readonly locationId: string | null;
  readonly lines: readonly (OrderLine & {
    readonly deliveredQty: number;
    readonly returnedQty: number;
  })[];
  readonly timeline: readonly TimelineEntry[];
  /**
   * The owners among the people on this order (M31, D-473). An owner holds no role, so the
   * staff list cannot name them; `name` is null unless the viewer is an owner too.
   */
  readonly owners?: readonly { readonly userId: string; readonly name: string | null }[];
  /** What the server will accept next, from the domain's own table. */
  readonly transitions: readonly AvailableTransition[];
}

export interface OrderListQuery {
  readonly status?: OrderStatus | undefined;
  readonly channel?: OrderChannel | undefined;
  readonly queue?: 'unassigned' | 'mine' | undefined;
  readonly assignedTo?: string | undefined;
  readonly zoneId?: string | undefined;
  readonly q?: string | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly limit: number;
  readonly offset: number;
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

export const listOrders = (params: OrderListQuery) =>
  api.get<{ items: OrderRow[]; hasNext: boolean }>(`/v1/orders${query({ ...params })}`);

export const getOrder = (id: string) => api.get<OrderDetail>(`/v1/orders/${id}`);

export interface CreateOrderBody {
  readonly channel: OrderChannel;
  readonly customer: {
    readonly phone: string;
    readonly name: string;
  };
  readonly shipTo: {
    readonly name: string;
    readonly districtId: number;
    readonly thanaId: number;
    readonly area?: string;
    readonly addressLine: string;
  };
  readonly lines: readonly { readonly skuId: string; readonly qty: number }[];
  readonly deliveryChargePoisha?: string;
  readonly discountPoisha?: string;
  /** The word the buyer gave. Never an id or an amount: the server prices it (D-204). */
  readonly promoCode?: string;
  readonly notes?: string;
  readonly assignedTo?: string;
}

export interface CreatedOrder {
  readonly id: string;
  readonly orderNo: string;
  readonly status: OrderStatus;
  readonly codAmountPoisha: string;
}

export const createOrder = (body: CreateOrderBody) => api.post<CreatedOrder>('/v1/orders', body);

/** What the live check says about a code, for this basket. Claims no use. */
export type PromoCheck =
  | {
      readonly ok: true;
      readonly codeId: string;
      readonly discountPoisha: string;
      readonly deliveryDiscountPoisha: string;
    }
  | { readonly ok: false; readonly reason: string };

/**
 * `POST /v1/promo/check`: would this code work on this basket, and for how much.
 *
 * A preview only. The order's own transaction prices the code again from the lines the
 * server priced itself and redeems it there, so what is saved can differ from this if the
 * code ran out in between — which the save then reports.
 */
export const checkPromo = (body: {
  readonly code: string;
  readonly lines: readonly { readonly skuId: string; readonly netPoisha: string }[];
  readonly orderDiscountPoisha?: string;
  readonly deliveryChargePoisha: string;
  readonly channel: string;
  readonly customerId?: string;
}) => api.post<PromoCheck>('/v1/promo/check', body);
export const confirmOrder = (id: string) => api.post<OrderRow>(`/v1/orders/${id}/confirm`, {});
export const claimOrder = (id: string) => api.post<OrderRow>(`/v1/orders/${id}/claim`);
export const cancelOrder = (id: string, reason: string) =>
  api.post<OrderRow>(`/v1/orders/${id}/cancel`, { reason });

export const holdOrder = (id: string, reason: string) =>
  api.post<OrderRow>(`/v1/orders/${id}/hold`, { reason });
export const releaseHold = (id: string) => api.post<OrderRow>(`/v1/orders/${id}/release-hold`, {});
export const packOrder = (id: string) => api.post<OrderRow>(`/v1/orders/${id}/pack`, {});
/** The handover to the courier (§9 `ship`): the dispatch movement and its journal. */
export const shipOrder = (id: string, input: { readonly consignmentNo?: string } = {}) =>
  api.post<OrderRow>(`/v1/orders/${id}/ship`, input);

/** §9's manual fallback for a delivery the courier sync has not reported. */
export const deliverOrder = (
  id: string,
  input: { readonly collectedPoisha?: string; readonly differenceReason?: string },
) => api.post<OrderRow>(`/v1/orders/${id}/deliver`, input);

export const deliverPartially = (
  id: string,
  input: {
    readonly collectedPoisha: string;
    readonly differenceReason?: string;
    readonly lines: readonly { readonly skuId: string; readonly deliveredQty: number }[];
  },
) => api.post<OrderRow>(`/v1/orders/${id}/partial-delivery`, input);

export const startReturn = (id: string, reason?: string) =>
  api.post<OrderRow>(`/v1/orders/${id}/start-return`, reason === undefined ? {} : { reason });

export const receiveReturn = (
  id: string,
  input: {
    readonly reason: string;
    readonly returnReason: ReturnReason;
    readonly damaged?: boolean;
  },
) => api.post<OrderRow>(`/v1/orders/${id}/receive-return`, input);

export interface BulkTransitionResult {
  readonly moved: number;
  readonly results: BulkConfirmResult['results'];
}

/** Pack or ship many orders, each on its own (D-393). */
export const bulkTransition = (ids: readonly string[], trigger: 'pack' | 'ship') =>
  api.post<BulkTransitionResult>('/v1/orders/bulk-transition', { ids, trigger });

export interface BulkConfirmResult {
  readonly confirmed: number;
  readonly results: readonly (
    | { readonly id: string; readonly ok: true; readonly orderNo: string }
    | { readonly id: string; readonly ok: false; readonly code: string; readonly message: string }
  )[];
}

export const bulkConfirm = (ids: readonly string[]) =>
  api.post<BulkConfirmResult>('/v1/orders/bulk-confirm', { ids });

export interface Agent {
  readonly userId: string;
  readonly name: string;
  readonly roles: readonly string[];
}
export const listAgents = () => api.get<{ items: Agent[] }>('/v1/orders/agents');

export interface Duplicate {
  readonly id: string | null;
  readonly orderNo: string;
  readonly status: OrderStatus;
  readonly createdAt: string;
  readonly visible: boolean;
}
export const findDuplicates = (phone: string, skuIds: readonly string[]) =>
  api.get<{ items: Duplicate[] }>(
    `/v1/orders/duplicates${query({ phone, skuIds: skuIds.join(',') })}`,
  );

export interface LookedUpCustomer {
  readonly id: string;
  readonly name: string;
  readonly phone: string;
  readonly stats: {
    readonly orders: number;
    readonly delivered: number;
    readonly returned: number;
    readonly cancelled: number;
  };
  readonly addresses: readonly {
    readonly id: string;
    readonly districtId: number;
    readonly thanaId: number;
    readonly area: string | null;
    readonly addressLine: string;
    readonly isDefault: boolean;
  }[];
  readonly recentOrders: readonly {
    readonly id: string;
    readonly orderNo: string;
    readonly status: OrderStatus;
    readonly channel: OrderChannel;
    readonly codAmountPoisha: string;
    readonly createdAt: string;
  }[];
}
export const lookupCustomer = (phone: string) =>
  api.get<{ phone: string; customer: LookedUpCustomer | null }>(
    `/v1/customers/lookup${query({ phone })}`,
  );

export interface Area {
  readonly thanaId: number;
  readonly thanaEn: string;
  readonly thanaBn: string;
  readonly districtId: number;
  readonly districtEn: string;
  readonly districtBn: string;
  readonly zoneId: string | null;
}
export interface Zone {
  readonly id: string;
  readonly code: string;
  readonly nameEn: string;
  readonly nameBn: string;
  readonly chargePoisha: string;
}
export const listAreas = () =>
  api.get<{ areas: Area[]; zones: Zone[] }>('/v1/delivery-zones/areas');

/** The catalog's SKU search: codes only, three characters or more (M06). */
export interface SkuHit {
  readonly skuId: string;
  readonly skuCode: string;
  readonly name: string;
  readonly pricePoisha: string;
  readonly status: string;
}
export const searchSkus = (q: string) =>
  api.get<{ items: SkuHit[] }>(`/v1/catalog/skus${query({ q, limit: 12 })}`);

export interface Availability {
  readonly skuId: string;
  readonly availableQty: number;
  readonly pricePoisha: string | null;
}
export const availability = (skuIds: readonly string[]) =>
  api.get<{ locationId: string; items: Availability[] }>(
    `/v1/orders/availability${query({ skuIds: skuIds.join(',') })}`,
  );

export interface Buyer {
  readonly customerId: string;
  readonly name: string;
  readonly phone: string;
  readonly district: string | null;
  readonly thana: string | null;
  readonly orders: number;
  readonly units: number;
  readonly lastOrderAt: string;
}
export interface BuyerFilters {
  readonly product?: string | undefined;
  readonly sku?: string | undefined;
  readonly size?: string | undefined;
  readonly channel?: OrderChannel | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
}
export const listBuyers = (filters: BuyerFilters, limit: number, offset: number) =>
  api.get<{ items: Buyer[]; total: number }>(`/v1/buyers${query({ ...filters, limit, offset })}`);

/**
 * Absolute URLs for the files, opened by the browser rather than fetched by script.
 *
 * A PDF for the print dialog and a spreadsheet for the downloads folder are both things
 * the browser handles better than a blob URL does — the session cookie travels with a
 * top-level navigation to the API's origin exactly as it does with `fetch`.
 */
export const documentsUrl = (ids: readonly string[], kind: 'invoice' | 'label' | 'packing_slip') =>
  new URL(
    `/v1/orders/documents${query({ ids: ids.join(','), kind })}`,
    env.VITE_API_URL,
  ).toString();

export const documentUrl = (id: string, kind: 'invoice' | 'label' | 'packing_slip') =>
  new URL(`/v1/orders/${id}/document${query({ kind })}`, env.VITE_API_URL).toString();

export const buyersExportUrl = (filters: BuyerFilters, format: 'csv' | 'xlsx') =>
  new URL(`/v1/buyers/export${query({ ...filters, format })}`, env.VITE_API_URL).toString();
