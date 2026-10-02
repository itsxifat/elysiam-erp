import type { Tx } from '@elysium/db';
import type { Poisha } from '@elysium/domain';

import type { ActiveContext } from '../../../platform/http/context.js';

/**
 * What the order desk needs from promo codes (M16; invariant 12).
 *
 * Declared here, in the consumer, as `fraud-gate.port.ts` is: this module states exactly
 * what it asks for, and `orders.module.ts` binds it to `PROMO_API` with `useExisting`.
 * Nothing here knows how a code is stored or priced.
 *
 * **The order never carries a client's discount.** A caller sends a code *word* on order
 * create. The server prices it against the lines it has itself priced, folds the result
 * into the order's discount, writes the order, and redeems — all in one transaction, so
 * a code that ran out between pricing and redeeming rolls the order back rather than
 * leaving it with a discount it was never entitled to. The `promoCodeId` that order
 * create used to accept from the client is gone (D-204).
 */

/** A code priced for one order and not yet spent; handed back unchanged to redeem it. */
export interface PricedPromo {
  readonly codeId: string;
  readonly customerId: string | null;
  readonly discountPoisha: Poisha;
  readonly deliveryDiscountPoisha: Poisha;
}

export interface PromoPort {
  /** What the code is worth for these lines. Claims nothing; throws when it does not apply. */
  priceForOrder(
    tx: Tx,
    context: ActiveContext,
    input: {
      readonly code: string;
      readonly customerId: string | null;
      readonly channel: string;
      readonly lines: readonly { readonly skuId: string; readonly netPoisha: string }[];
      readonly deliveryChargePoisha: string;
    },
  ): Promise<PricedPromo>;

  /** Take the use and record it against the order just written, same transaction. */
  redeemForOrder(
    tx: Tx,
    context: ActiveContext,
    priced: PricedPromo,
    orderId: string,
  ): Promise<{ readonly redemptionId: string }>;

  /** Give the use back when the order is cancelled before it ships. Once, however often. */
  releaseForOrder(tx: Tx, orgId: string, orderId: string): Promise<boolean>;

  /**
   * A personal single-use code for a buyer's occasion (M16 check 2), in the caller's
   * transaction — the CRM's greeting, its code and the record that it went out commit
   * together.
   */
  issueOccasionCode(
    tx: Tx,
    orgId: string,
    input: {
      readonly customerId: string;
      readonly occasion: 'birthday' | 'anniversary';
      readonly kind: 'percent' | 'flat';
      readonly valueBps: number;
      readonly valuePoisha: bigint;
      readonly validFrom: string;
      readonly validTo: string;
      readonly actorUserId: string;
    },
  ): Promise<{ readonly codeId: string; readonly code: string }>;
}

export const PROMO_PORT = Symbol('OrdersPromoPort');
