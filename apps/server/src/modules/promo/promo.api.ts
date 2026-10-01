import { Inject, Injectable } from '@nestjs/common';
import type { Tx } from '@elysium/db';
import type { Poisha } from '@elysium/domain';

import type { ActiveContext } from '../../platform/http/context.js';
import { PromoError } from './promo.errors.js';
import { PromoService } from './promo.service.js';

/**
 * What the order desk and the till may ask of this module (M16; invariant 12).
 *
 * One method, and its shape is the whole point: a caller passes a **code** and the lines
 * it would apply to, and gets back the discount *and* the redemption in one call inside
 * its own transaction. There is deliberately no "what is this code worth" followed by a
 * separate "record that I used it" — two calls is how a code validated against nine uses
 * gets redeemed as the eleventh, and how an order's discount ends up being a number the
 * client chose between them.
 *
 * `applyToOrder` throws rather than returning a refusal, because by the time an order is
 * being written the code has already been offered to the buyer through
 * `POST /v1/promo/check`; a code that fails here is an exception, and the orders module
 * turns it into problem+json with the domain's reason.
 */
export interface PromoApi {
  /**
   * Price a code against an order's lines, take one of its uses, and record it.
   *
   * Runs in the caller's transaction so the order row, its discount and the redemption
   * commit together or not at all. Returns what was actually allowed, which the caller
   * writes onto the order — so the discount in the books and the one in the redemption
   * ledger are the same number by construction rather than by agreement.
   *
   * Idempotent per (code, order): a retried submission returns the first redemption's
   * amounts and claims no further use.
   */
  applyToOrder(
    tx: Tx,
    context: ActiveContext,
    input: {
      readonly code: string;
      readonly orderId: string;
      readonly customerId: string | null;
      readonly channel: string;
      readonly lines: readonly { readonly skuId: string; readonly netPoisha: string }[];
      readonly deliveryChargePoisha: string;
      /** The order's Asia/Dhaka business date; today when absent. */
      readonly on?: string;
    },
  ): Promise<{
    readonly codeId: string;
    readonly discountPoisha: Poisha;
    readonly deliveryDiscountPoisha: Poisha;
    readonly redemptionId: string;
  }>;

  /**
   * Give a code's use back when an order is cancelled before it ships.
   *
   * False when the order carried no code or its redemption was already released — a
   * cancel delivered twice must not return two uses (D-202). Kept once the order ships:
   * the goods went out, and a return is a different event from never having bought.
   */
  releaseForOrder(tx: Tx, orgId: string, orderId: string): Promise<boolean>;
}

export const PROMO_API = Symbol('PromoApi');

@Injectable()
export class PromoApiService implements PromoApi {
  constructor(@Inject(PromoService) private readonly promo: PromoService) {}

  async applyToOrder(
    tx: Tx,
    context: ActiveContext,
    input: {
      readonly code: string;
      readonly orderId: string;
      readonly customerId: string | null;
      readonly channel: string;
      readonly lines: readonly { readonly skuId: string; readonly netPoisha: string }[];
      readonly deliveryChargePoisha: string;
      readonly on?: string;
    },
  ) {
    const { code, verdict } = await this.promo.verdictFor(tx, context.orgId, {
      code: input.code,
      lines: input.lines,
      deliveryChargePoisha: input.deliveryChargePoisha,
      channel: input.channel,
      customerId: input.customerId,
      ...(input.on === undefined ? {} : { on: input.on }),
    });

    if (!verdict.ok) {
      throw new PromoError(
        'PROMO_NOT_APPLICABLE',
        'That code does not apply to this order.',
        verdict.reason,
      );
    }

    const { redemptionId } = await this.promo.redeem(tx, context, {
      codeId: code.id,
      orderId: input.orderId,
      posSaleId: null,
      customerId: input.customerId,
      discountPoisha: verdict.discountPoisha,
      deliveryDiscountPoisha: verdict.deliveryDiscountPoisha,
    });

    return {
      codeId: code.id,
      discountPoisha: verdict.discountPoisha,
      deliveryDiscountPoisha: verdict.deliveryDiscountPoisha,
      redemptionId,
    };
  }

  async releaseForOrder(tx: Tx, orgId: string, orderId: string): Promise<boolean> {
    return this.promo.releaseForOrder(tx, orgId, orderId);
  }
}
