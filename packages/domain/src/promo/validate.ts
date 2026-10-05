import type { IsoDate } from '../dates/index.js';
import { poisha, type Poisha } from '../money/index.js';
import {
  DISCOUNT_REASONS,
  evaluateDiscount,
  type Discount,
  type DiscountBasket,
  type DiscountReason,
} from './discounts.js';

/**
 * Promo codes (architecture §10, M16): whether a code applies to a basket, and for
 * how much.
 *
 * Since M35a this is a view of the one discount engine (`discounts.ts`, D-540): an M16 code
 * is a `Discount` with the method `code`, no instant window, no buy-X-get-Y or tiers, and
 * lines of one unit each. Nothing here decides anything `evaluateDiscount` does not, so the
 * desk, the till and the website cannot disagree about a code.
 *
 * The checks run in a fixed order and the first failure is the reason, so a person
 * is told the thing that matters most: a paused code is "inactive" even if it has
 * also expired, and a code for another buyer says so before it mentions a minimum.
 */

export type PromoKind = 'percent' | 'flat' | 'free_delivery';

export interface PromoCode {
  readonly id: string;
  readonly code: string;
  readonly kind: PromoKind;
  /** Percent codes: basis points, 1–10,000. */
  readonly valueBps: number;
  /** Flat codes: the amount off, in poisha. */
  readonly valuePoisha: Poisha;
  readonly minOrderPoisha: Poisha | null;
  readonly maxDiscountPoisha: Poisha | null;
  readonly totalLimit: number | null;
  readonly perCustomerLimit: number | null;
  /** Asia/Dhaka calendar dates, both inclusive. */
  readonly validFrom: IsoDate | null;
  readonly validTo: IsoDate | null;
  /** Empty: every channel. */
  readonly channels: readonly string[];
  /** Both empty: the whole basket. Otherwise a line counts if either matches. */
  readonly skuIds: readonly string[];
  readonly categoryIds: readonly string[];
  /** A personal code belongs to one buyer and to nobody else. */
  readonly customerId: string | null;
  readonly status: 'active' | 'paused' | 'archived';
}

export interface PromoUsage {
  /** Uses already applied and not released, across every buyer. */
  readonly total: number;
  /** Of those, this buyer's. Zero for a buyer the brand has never seen. */
  readonly byCustomer: number;
}

export interface PromoBasketLine {
  readonly skuId: string;
  readonly categoryId: string | null;
  /** The line after any typed discount, in poisha. */
  readonly netPoisha: Poisha;
}

export interface PromoBasket {
  readonly lines: readonly PromoBasketLine[];
  readonly deliveryChargePoisha: Poisha;
  readonly channel: string;
  readonly customerId: string | null;
  /** The Asia/Dhaka date the order is taken on. */
  readonly on: IsoDate;
}

/** M16's ten reasons and M35a's two, in the order the checks run. */
export const PROMO_REASONS = DISCOUNT_REASONS;

export type PromoReason = DiscountReason;

export type PromoVerdict =
  | {
      readonly ok: true;
      /** Off the goods: goes to the order's discount. */
      readonly discountPoisha: Poisha;
      /** Off the delivery charge: free-delivery codes only. */
      readonly deliveryDiscountPoisha: Poisha;
    }
  | { readonly ok: false; readonly reason: PromoReason };

/** An M16 code as the engine reads it. */
export function discountFromPromoCode(code: PromoCode): Discount {
  return {
    id: code.id,
    method: 'code',
    code: code.code,
    kind: code.kind,
    valueBps: code.valueBps,
    valuePoisha: code.valuePoisha,
    buyQuantity: 0,
    getQuantity: 0,
    getDiscountBps: 10_000,
    tiers: [],
    minOrderPoisha: code.minOrderPoisha,
    minQuantity: null,
    firstOrderOnly: false,
    maxDiscountPoisha: code.maxDiscountPoisha,
    totalLimit: code.totalLimit,
    perCustomerLimit: code.perCustomerLimit,
    validFrom: code.validFrom,
    validTo: code.validTo,
    startsAt: null,
    endsAt: null,
    channels: code.channels,
    skuIds: code.skuIds,
    productIds: [],
    categoryIds: code.categoryIds,
    customerId: code.customerId,
    allowStacking: false,
    priority: 0,
    status: code.status,
  };
}

export function validatePromo(
  code: PromoCode,
  basket: PromoBasket,
  usage: PromoUsage,
): PromoVerdict {
  const asDiscounts: DiscountBasket = {
    lines: basket.lines.map((line) => ({
      skuId: line.skuId,
      productId: null,
      categoryIds: line.categoryId === null ? [] : [line.categoryId],
      qty: 1,
      netPoisha: line.netPoisha,
    })),
    deliveryChargePoisha: basket.deliveryChargePoisha,
    channel: basket.channel,
    customerId: basket.customerId,
    // An M16 code has no first-order rule and no instant window, so neither is read.
    isFirstOrder: true,
    on: basket.on,
    now: new Date(`${basket.on}T12:00:00+06:00`),
  };
  const verdict = evaluateDiscount(discountFromPromoCode(code), asDiscounts, usage);
  return verdict.ok
    ? {
        ok: true,
        discountPoisha: poisha(verdict.discountPoisha),
        deliveryDiscountPoisha: poisha(verdict.deliveryDiscountPoisha),
      }
    : verdict;
}
