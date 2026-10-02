import { computePartialDelivery, poisha, ZERO, type Poisha } from '@elysium/domain';

/**
 * An order's delivered revenue, one way for everyone who needs it (M16, M18).
 *
 * The buyer's lifetime value (M16) and §11's `delivered_revenue` (M18) are the same number
 * as the delivery journal's sales revenue: the delivered lines' net item value, after line
 * and order-level discounts, without the delivery charge. All three go through
 * `computePartialDelivery`, so none of them can disagree with the books.
 */

interface DiscountedOrder {
  readonly discount_poisha: string;
  readonly delivery_charge_poisha: string;
}

interface DeliveredLine {
  readonly qty: number;
  readonly unit_price_poisha: string;
  readonly discount_poisha: string;
  readonly delivered_qty: number;
}

/**
 * The order-level discount: the order's total discount minus what the lines carry.
 *
 * Derived rather than stored separately because `orders.discount_poisha` is what §9
 * names and what the COD CHECK re-derives from. Splitting it into two columns would
 * give two numbers that must agree, and the one the reports read would be whichever
 * the last migration touched.
 */
export function orderLevelDiscount(
  order: Pick<DiscountedOrder, 'discount_poisha'>,
  lines: readonly Pick<DeliveredLine, 'discount_poisha'>[],
): bigint {
  const lineDiscounts = lines.reduce((total, line) => total + BigInt(line.discount_poisha), 0n);
  const remainder = BigInt(order.discount_poisha) - lineDiscounts;
  return remainder > 0n ? remainder : 0n;
}

/** Net revenue recognised for the units the lines record as delivered; zero if none. */
export function deliveredNetItems(
  order: DiscountedOrder,
  lines: readonly DeliveredLine[],
): Poisha {
  if (!lines.some((line) => line.delivered_qty > 0)) return ZERO;
  const recognised = computePartialDelivery({
    lines: lines.map((line) => ({
      qty: line.qty,
      unitPricePoisha: poisha(BigInt(line.unit_price_poisha)),
      lineDiscountPoisha: poisha(BigInt(line.discount_poisha)),
      deliveredQty: line.delivered_qty,
    })),
    orderDiscountPoisha: poisha(orderLevelDiscount(order, lines)),
    deliveryChargePoisha: poisha(BigInt(order.delivery_charge_poisha)),
  });
  const net = BigInt(recognised.deliveredNetItemsPoisha);
  return poisha(net > 0n ? net : 0n);
}
