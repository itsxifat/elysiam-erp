import { Inject, Injectable } from '@nestjs/common';
import type { Tx } from '@elysium/db';
import type { Poisha } from '@elysium/domain';

import type { ActiveContext } from '../../platform/http/context.js';
import { PromoError, promoHttpError } from './promo.errors.js';
import { PromoService } from './promo.service.js';

/**
 * A code, priced for one order and not yet spent.
 *
 * Returned by `priceForOrder` and handed back, unchanged, to `redeemForOrder`. Carrying
 * the amounts across rather than recomputing them is what makes the discount written on
 * the order and the one recorded in the redemption ledger the same number: there is no
 * second calculation for them to disagree with.
 */
export interface PricedPromo {
  readonly codeId: string;
  readonly customerId: string | null;
  /** Off the goods: added to the order's discount. */
  readonly discountPoisha: Poisha;
  /** Off the delivery charge: free-delivery codes only. */
  readonly deliveryDiscountPoisha: Poisha;
}

/**
 * What the order desk may ask of this module (M16; invariant 12).
 *
 * **Two phases, one transaction.** Creating an order is chicken-and-egg: the discount has
 * to be known before the order row is written, because the totals are computed from it;
 * and a redemption's foreign key needs that row to exist. So the caller prices the code,
 * writes the order, then redeems — all inside its own transaction.
 *
 * That is safe where "validate, then later redeem" is not, and the difference is the
 * transaction. `redeemForOrder` takes the use with a conditional UPDATE, so a code that
 * ran out between the two phases is refused there, the caller's transaction rolls back,
 * and no order exists with a discount it was never entitled to. Split across two requests
 * instead, a code validated against nine uses would be redeemed as the eleventh.
 */
export interface PromoApi {
  /**
   * What the code is worth for these lines. Claims nothing and writes nothing.
   *
   * Throws `PROMO_NOT_FOUND` for an unknown word and `PROMO_NOT_APPLICABLE` with the
   * domain's reason for one that does not apply — by the time an order is being written
   * the code has already been offered through `POST /v1/promo/check`, so a refusal here
   * is an exception rather than an answer.
   */
  priceForOrder(
    tx: Tx,
    context: ActiveContext,
    input: {
      readonly code: string;
      readonly customerId: string | null;
      readonly channel: string;
      /** Each line's net after its own typed discount, as the domain rule expects. */
      readonly lines: readonly { readonly skuId: string; readonly netPoisha: string }[];
      readonly deliveryChargePoisha: string;
      /** The order's Asia/Dhaka business date; today when absent. */
      readonly on?: string;
    },
  ): Promise<PricedPromo>;

  /**
   * Take a use of the code and record it against the order just written.
   *
   * Same transaction as `priceForOrder` and the order insert. Idempotent per (code,
   * order): a retried submission returns the first redemption and claims no further use.
   */
  redeemForOrder(
    tx: Tx,
    context: ActiveContext,
    priced: PricedPromo,
    orderId: string,
  ): Promise<{ readonly redemptionId: string }>;

  /**
   * Give a code's use back when an order is cancelled before it ships.
   *
   * False when the order carried no code or its redemption was already released — a
   * cancel delivered twice must not return two uses (D-204). Kept once the order ships:
   * the goods went out, and a return is a different event from never having bought.
   */
  releaseForOrder(tx: Tx, orgId: string, orderId: string): Promise<boolean>;
}

export const PROMO_API = Symbol('PromoApi');

/**
 * A promo refusal as the HTTP answer it should be, whichever module's route it crosses.
 *
 * The order desk calls this module from inside `POST /v1/orders`, so a `PromoError` thrown
 * here would reach the orders module's mapper, which maps any foreign coded error to 400
 * and has no idea a promo refusal is a 409 carrying a `reason`. Converting at this seam —
 * the one place every caller passes through — means the desk gets
 * `409 PROMO_NOT_APPLICABLE` with `reason: limit_reached` no matter which route asked.
 */
async function asHttp<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof PromoError) throw promoHttpError(error);
    throw error;
  }
}

@Injectable()
export class PromoApiService implements PromoApi {
  constructor(@Inject(PromoService) private readonly promo: PromoService) {}

  async priceForOrder(
    tx: Tx,
    context: ActiveContext,
    input: {
      readonly code: string;
      readonly customerId: string | null;
      readonly channel: string;
      readonly lines: readonly { readonly skuId: string; readonly netPoisha: string }[];
      readonly deliveryChargePoisha: string;
      readonly on?: string;
    },
  ): Promise<PricedPromo> {
    return asHttp(() => this.price(tx, context, input));
  }

  private async price(
    tx: Tx,
    context: ActiveContext,
    input: {
      readonly code: string;
      readonly customerId: string | null;
      readonly channel: string;
      readonly lines: readonly { readonly skuId: string; readonly netPoisha: string }[];
      readonly deliveryChargePoisha: string;
      readonly on?: string;
    },
  ): Promise<PricedPromo> {
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

    return {
      codeId: code.id,
      customerId: input.customerId,
      discountPoisha: verdict.discountPoisha,
      deliveryDiscountPoisha: verdict.deliveryDiscountPoisha,
    };
  }

  async redeemForOrder(
    tx: Tx,
    context: ActiveContext,
    priced: PricedPromo,
    orderId: string,
  ): Promise<{ readonly redemptionId: string }> {
    return asHttp(async () => {
      const { redemptionId } = await this.promo.redeem(tx, context, {
        codeId: priced.codeId,
        orderId,
        posSaleId: null,
        customerId: priced.customerId,
        discountPoisha: priced.discountPoisha,
        deliveryDiscountPoisha: priced.deliveryDiscountPoisha,
      });
      return { redemptionId };
    });
  }

  async releaseForOrder(tx: Tx, orgId: string, orderId: string): Promise<boolean> {
    return this.promo.releaseForOrder(tx, orgId, orderId);
  }
}
