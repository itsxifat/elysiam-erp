import type { OrderStatus } from '../orders/state.js';

/**
 * What a shopper is told about an order (M34, D-524).
 *
 * The desk's eleven statuses are the ERP's working vocabulary; a shopper needs seven, and
 * never "on hold" (a hold is the desk waiting on a phone call, not news for the buyer) or
 * "packed" (a box on a shelf is still processing to the person waiting for it).
 */
export const SHOPPER_STATUSES = [
  'placed',
  'processing',
  'shipped',
  'delivered',
  'partly_delivered',
  'returned',
  'cancelled',
  'exchanged',
] as const;

export type ShopperStatus = (typeof SHOPPER_STATUSES)[number];

export function shopperStatusOf(status: OrderStatus): ShopperStatus {
  switch (status) {
    case 'pending':
      return 'placed';
    case 'confirmed':
    case 'on_hold':
    case 'packed':
      return 'processing';
    case 'shipped':
      return 'shipped';
    case 'delivered':
      return 'delivered';
    case 'partially_delivered':
      return 'partly_delivered';
    case 'return_in_transit':
    case 'returned':
      return 'returned';
    case 'cancelled':
      return 'cancelled';
    case 'exchange':
      return 'exchanged';
  }
}

/** The words the plan names, for a website that shows them as given (it may use its own). */
export const SHOPPER_STATUS_LABELS: Readonly<
  Record<ShopperStatus, { readonly en: string; readonly bn: string }>
> = {
  placed: { en: 'Order placed', bn: 'অর্ডার গ্রহণ করা হয়েছে' },
  processing: { en: 'Processing', bn: 'প্রস্তুত হচ্ছে' },
  shipped: { en: 'Shipped', bn: 'পাঠানো হয়েছে' },
  delivered: { en: 'Delivered', bn: 'ডেলিভারি হয়েছে' },
  partly_delivered: { en: 'Partly delivered', bn: 'আংশিক ডেলিভারি হয়েছে' },
  returned: { en: 'Returned', bn: 'ফেরত এসেছে' },
  cancelled: { en: 'Cancelled', bn: 'বাতিল হয়েছে' },
  exchanged: { en: 'Exchanged', bn: 'বদল করা হয়েছে' },
};

/** How the shopper paid, as the website shows it. */
export type ShopperPaymentStatus = 'cash_on_delivery' | 'awaiting_payment' | 'paid' | 'refund_due';

export function shopperPaymentStatus(input: {
  readonly method: 'cod' | 'sslcommerz';
  /** Verified gateway money on the order. */
  readonly paidPoisha: bigint;
  /** What the rider still collects. */
  readonly codPoisha: bigint;
  readonly orderStatus: OrderStatus;
}): ShopperPaymentStatus {
  if (input.paidPoisha > 0n) {
    return input.orderStatus === 'cancelled' || input.orderStatus === 'returned'
      ? 'refund_due'
      : 'paid';
  }
  if (input.method === 'sslcommerz' && input.orderStatus === 'pending') return 'awaiting_payment';
  return 'cash_on_delivery';
}
