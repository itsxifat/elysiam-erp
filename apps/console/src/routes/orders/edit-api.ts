import { api } from '../../api.js';
import { ackHeaders } from './owner-ack.js';

/**
 * The order editor's calls (M50, D-921 to D-924): the product picker, the offers panel, an
 * edit that names its offers, and a packed order's replacement. Typed to what
 * `orders.controller.ts` returns.
 */

export interface PickerVariant {
  readonly skuId: string;
  readonly code: string;
  readonly size: string | null;
  readonly colour: string | null;
  /** Every option's label, joined: "M / Navy". */
  readonly label: string;
  readonly pricePoisha: string;
  readonly compareAtPoisha: string | null;
  /** Units in hand where the order ships from (or the desk sells from). */
  readonly available: number;
}

export interface PickerProduct {
  readonly id: string;
  readonly name: string;
  readonly imageFileId: string | null;
  /** The size a scanned barcode or a typed SKU named. */
  readonly matchedSkuId: string | null;
  readonly variants: readonly PickerVariant[];
}

export interface PickerPage {
  readonly items: readonly PickerProduct[];
  readonly nextOffset: number | null;
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

/** One page of products: what was typed, or every product when nothing was. */
export const pickProducts = (q: string, offset: number, locationId?: string | null) =>
  api.get<PickerPage>(
    `/v1/orders/picker${query({ q: q.trim(), offset: offset === 0 ? undefined : offset, locationId: locationId ?? undefined })}`,
  );

/** The products of an order's SKUs, for their photos and sizes. */
export const productsOfSkus = (skuIds: readonly string[], locationId?: string | null) =>
  api.get<PickerPage>(
    `/v1/orders/picker${query({ skuIds: skuIds.join(','), locationId: locationId ?? undefined })}`,
  );

export type OfferReason =
  | 'min_order_not_met'
  | 'min_quantity_not_met'
  | 'limit_reached'
  | 'customer_limit_reached'
  | 'first_order_only'
  | 'out_of_scope'
  | 'nothing_to_discount';

export interface OfferRow {
  readonly discountId: string;
  readonly method: 'code' | 'automatic';
  readonly code: string | null;
  readonly title: string;
  readonly description: string;
  readonly kind: string;
  readonly allowStacking: boolean;
  readonly qualifies: boolean;
  readonly discountPoisha: string;
  readonly deliveryDiscountPoisha: string;
  readonly reason: string | null;
}

export interface AppliedOffer {
  readonly discountId: string;
  readonly method: 'code' | 'automatic';
  readonly code: string | null;
  readonly title: string;
  readonly discountPoisha: string;
  readonly deliveryDiscountPoisha: string;
}

interface QuoteBase {
  readonly offers: readonly OfferRow[];
  readonly applied: readonly AppliedOffer[];
  readonly offerDiscountPoisha: string;
  readonly offerDeliveryDiscountPoisha: string;
}

export interface EditQuote extends QuoteBase {
  readonly mode: 'edit';
  readonly totals: {
    readonly itemsPoisha: string;
    readonly discountPoisha: string;
    readonly deliveryChargePoisha: string;
    readonly advancePaidPoisha: string;
    readonly codAmountPoisha: string;
  };
}

export interface ReturnQuote extends QuoteBase {
  readonly mode: 'return';
  readonly wholeReturn: boolean;
  readonly keptNetPoisha: string;
  /** The kept pieces' share of the person's own order discount. */
  readonly typedDiscountPoisha: string;
  readonly deliveryChargePoisha: string;
  readonly advanceAppliedPoisha: string;
  readonly expectedPoisha: string;
  readonly collectPoisha: string;
}

export interface EditLine {
  readonly skuId: string;
  readonly qty: number;
  readonly unitPricePoisha?: string;
  readonly discountPoisha?: string;
}

export const quoteEdit = (
  orderId: string,
  body: {
    readonly lines: readonly EditLine[];
    readonly discountPoisha: string;
    readonly deliveryChargePoisha: string;
    readonly discountIds: readonly string[];
  },
) => api.post<EditQuote>(`/v1/orders/${orderId}/offers`, { mode: 'edit', ...body });

export const quoteReturn = (
  orderId: string,
  body: {
    readonly keep: readonly { readonly skuId: string; readonly qty: number }[];
    readonly deliveryChargePoisha: string;
    readonly discountIds: readonly string[];
  },
) => api.post<ReturnQuote>(`/v1/orders/${orderId}/offers`, { mode: 'return', ...body });

/** An edit that names its offers: the typed discount and the charge are before any offer. */
export const saveEdit = (
  orderId: string,
  body: {
    readonly lines: readonly EditLine[];
    readonly discountPoisha: string;
    readonly deliveryChargePoisha: string;
    readonly discountIds: readonly string[];
  },
  ack?: boolean,
) => api.patch<{ id: string }>(`/v1/orders/${orderId}`, body, ackHeaders(ack));

export const replaceOrder = (
  orderId: string,
  body: {
    readonly reason: string;
    readonly lines: readonly EditLine[];
    readonly discountPoisha: string;
    readonly deliveryChargePoisha: string;
    readonly discountIds: readonly string[];
  },
  ack?: boolean,
) =>
  api.post<{ id: string; orderNo: string; replacedOrderId: string }>(
    `/v1/orders/${orderId}/replace`,
    body,
    ackHeaders(ack),
  );
