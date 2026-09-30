import type { IsoDate } from '../dates/index.js';
import { percentOf, poisha, sum, ZERO, type Poisha } from '../money/index.js';

/**
 * Promo codes (architecture §10, M16): whether a code applies to a basket, and for
 * how much.
 *
 * A pure function, so the order desk, the till and later the landing pages all get
 * the same answer, and so every rule has a table-driven test (check 3). The server
 * calls it inside the transaction that records the redemption; the client only ever
 * sends the code, never an amount.
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

export const PROMO_REASONS = [
  'inactive',
  'not_yet_valid',
  'expired',
  'personal_code',
  'wrong_channel',
  'limit_reached',
  'customer_limit_reached',
  'min_order_not_met',
  'out_of_scope',
  'nothing_to_discount',
] as const;

export type PromoReason = (typeof PROMO_REASONS)[number];

export type PromoVerdict =
  | {
      readonly ok: true;
      /** Off the goods: goes to the order's discount. */
      readonly discountPoisha: Poisha;
      /** Off the delivery charge: free-delivery codes only. */
      readonly deliveryDiscountPoisha: Poisha;
    }
  | { readonly ok: false; readonly reason: PromoReason };

function refuse(reason: PromoReason): PromoVerdict {
  return { ok: false, reason };
}

function capped(amount: Poisha, cap: Poisha | null): Poisha {
  return cap !== null && cap < amount ? cap : amount;
}

export function validatePromo(
  code: PromoCode,
  basket: PromoBasket,
  usage: PromoUsage,
): PromoVerdict {
  if (code.status !== 'active') return refuse('inactive');
  if (code.validFrom !== null && basket.on < code.validFrom) return refuse('not_yet_valid');
  if (code.validTo !== null && basket.on > code.validTo) return refuse('expired');
  if (code.customerId !== null && code.customerId !== basket.customerId) {
    return refuse('personal_code');
  }
  if (code.channels.length > 0 && !code.channels.includes(basket.channel)) {
    return refuse('wrong_channel');
  }
  if (code.totalLimit !== null && usage.total >= code.totalLimit) return refuse('limit_reached');
  if (code.perCustomerLimit !== null && usage.byCustomer >= code.perCustomerLimit) {
    return refuse('customer_limit_reached');
  }

  const subtotal = sum(basket.lines.map((line) => line.netPoisha));
  if (code.minOrderPoisha !== null && subtotal < code.minOrderPoisha) {
    return refuse('min_order_not_met');
  }

  if (code.kind === 'free_delivery') {
    if (basket.deliveryChargePoisha <= 0n) return refuse('nothing_to_discount');
    return {
      ok: true,
      discountPoisha: ZERO,
      deliveryDiscountPoisha: capped(basket.deliveryChargePoisha, code.maxDiscountPoisha),
    };
  }

  const scoped = code.skuIds.length > 0 || code.categoryIds.length > 0;
  const eligible = sum(
    basket.lines
      .filter(
        (line) =>
          !scoped ||
          code.skuIds.includes(line.skuId) ||
          (line.categoryId !== null && code.categoryIds.includes(line.categoryId)),
      )
      .map((line) => line.netPoisha),
  );
  if (eligible <= 0n) return refuse(scoped ? 'out_of_scope' : 'nothing_to_discount');

  const raw =
    code.kind === 'percent'
      ? percentOf(eligible, code.valueBps)
      : code.valuePoisha < eligible
        ? code.valuePoisha
        : eligible;
  const discount = capped(raw, code.maxDiscountPoisha);
  if (discount <= 0n) return refuse('nothing_to_discount');
  return { ok: true, discountPoisha: poisha(discount), deliveryDiscountPoisha: ZERO };
}

/** Codes are matched without regard to case or surrounding spaces: people type them. */
export function normaliseCode(input: string): string {
  return input.trim().toUpperCase();
}
