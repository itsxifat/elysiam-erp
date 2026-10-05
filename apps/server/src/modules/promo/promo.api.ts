import { Inject, Injectable } from '@nestjs/common';
import type { Tx } from '@elysium/db';
import type { Poisha } from '@elysium/domain';
import type { FlashOffer } from '@elysium/domain/promo';

import type { ActiveContext } from '../../platform/http/context.js';
import { FlashService, type FlashClaimLine } from './flash.service.js';
import { PromoError, promoHttpError } from './promo.errors.js';
import * as repo from './promo.repository.js';
import { PromoService, type AppliedDiscountView, type DiscountQuote } from './promo.service.js';

export type { AppliedDiscountView, DiscountQuote, QuoteRefusal } from './promo.service.js';
export type { FlashClaimLine } from './flash.service.js';

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

/** A basket line as the caller priced it (M35a): flash prices already applied. */
export interface QuoteLine {
  readonly skuId: string;
  /** Whole units. */
  readonly qty: number;
  /** What the buyer pays for the whole line before any discount. */
  readonly netPoisha: Poisha | bigint | string;
}

/**
 * What other modules may ask of this one (M16, M35a; invariant 12).
 *
 * **Two phases, one transaction.** Creating an order is chicken-and-egg: the discount has
 * to be known before the order row is written, because the totals are computed from it;
 * and a redemption's foreign key needs that row to exist. So the caller prices, writes the
 * order, then redeems (and claims flash units) — all inside its own transaction.
 *
 * That is safe where "validate, then later redeem" is not, and the difference is the
 * transaction. Redeeming takes each use with a conditional UPDATE, so a discount that ran
 * out between the two phases is refused there, the caller's transaction rolls back, and no
 * order exists with a discount it was never entitled to. Split across two requests instead,
 * a code validated against nine uses would be redeemed as the eleventh.
 *
 * The desk uses `priceForOrder` / `redeemForOrder` (one typed code, no automatic discounts,
 * D-544). The website (M34) uses `quoteDiscounts` / `redeem` and the flash-sale calls.
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
      /** Each line's net after its own typed discount, and its units (M35a). */
      readonly lines: readonly {
        readonly skuId: string;
        readonly netPoisha: string;
        readonly qty?: number;
      }[];
      /** The agent's typed order discount, spread over the lines first (`promoBasis`, W3). */
      readonly orderDiscountPoisha?: string;
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
   * Give every discount's use back when an order is cancelled before it ships.
   *
   * False when the order carried none or they were already released — a cancel delivered
   * twice must not return two uses (D-204). Kept once the order ships: the goods went out,
   * and a return is a different event from never having bought.
   */
  releaseForOrder(tx: Tx, orgId: string, orderId: string): Promise<boolean>;

  /**
   * A personal single-use code for one buyer's birthday or anniversary (M16 check 2).
   *
   * In the caller's transaction, so the code, the message announcing it and the record
   * that the greeting went out commit together or not at all.
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

  /**
   * The campaign each of these codes was made for, when it was made for one (M18).
   *
   * §11's first attribution rule is "a campaign set explicitly on the order", and a code
   * made for a campaign is that campaign named by the buyer (D-251). Codes with no
   * campaign, and ids that are not this brand's, are simply absent from the map.
   */
  campaignsOfCodes(
    tx: Tx,
    orgId: string,
    codeIds: readonly string[],
  ): Promise<ReadonlyMap<string, string>>;

  // --- M35a: the website's discounts and flash sales -----------------------------------

  /**
   * Every discount a basket gets (D-540): the brand's live automatic discounts (unless
   * `automatic` is false) and the typed codes, through the one engine the desk uses.
   * Returns what applies, the amounts, and why each typed code did not (`not_found` for a
   * word that names nothing). Claims nothing.
   *
   * `customerId` is the ERP's buyer (by phone); a signed-in website account resolves to its
   * buyer first (M34), so per-customer limits and first-order checks count one person once.
   */
  quoteDiscounts(
    tx: Tx,
    orgId: string,
    input: {
      readonly lines: readonly QuoteLine[];
      readonly customerId: string | null;
      readonly channel: string;
      readonly codes: readonly string[];
      readonly deliveryChargePoisha: Poisha | bigint | string;
      readonly now: Date;
      /** Default true. */
      readonly automatic?: boolean;
    },
  ): Promise<DiscountQuote>;

  /**
   * Take a use of every discount a quote applied and record each against the order just
   * written, in its transaction. Any refusal (a limit reached since the quote) throws
   * `PROMO_NOT_APPLICABLE`; the caller's transaction then rolls the order back.
   */
  redeem(
    tx: Tx,
    orgId: string,
    input: {
      readonly orderId: string;
      readonly customerId: string | null;
      readonly applied: readonly AppliedDiscountView[];
    },
  ): Promise<{ readonly redemptionIds: readonly string[] }>;

  /**
   * The switched-on flash offers on these SKUs that have not ended (D-542). Which one prices
   * a line is `bestFlashOffer` / `planFlashLines` from `@elysium/domain/promo`.
   */
  liveFlashOffers(
    tx: Tx,
    orgId: string,
    skuIds: readonly string[],
    now: Date,
  ): Promise<readonly FlashOffer[]>;

  /**
   * Take the flash units an order was priced with, all or nothing, in its transaction and
   * after its row exists. Refused lines throw `FLASH_SALE_UNAVAILABLE` (409, with
   * `skuIds`); every unit this call took is undone by its savepoint.
   */
  claimFlashUnits(
    tx: Tx,
    orgId: string,
    input: {
      readonly orderId: string;
      readonly lines: readonly FlashClaimLine[];
      readonly now: Date;
    },
  ): Promise<{ readonly claimIds: readonly string[] }>;

  /**
   * Give an order's flash units back, exactly once: all of them on a cancel, or up to the
   * units returned per SKU after a partial delivery. Returns the units given back.
   */
  releaseFlashUnits(
    tx: Tx,
    orgId: string,
    orderId: string,
    returned?: readonly { readonly skuId: string; readonly qty: number }[],
  ): Promise<number>;
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
  constructor(
    @Inject(PromoService) private readonly promo: PromoService,
    @Inject(FlashService) private readonly flash: FlashService,
  ) {}

  async priceForOrder(
    tx: Tx,
    context: ActiveContext,
    input: Parameters<PromoApi['priceForOrder']>[2],
  ): Promise<PricedPromo> {
    return asHttp(() => this.price(tx, context, input));
  }

  private async price(
    tx: Tx,
    context: ActiveContext,
    input: Parameters<PromoApi['priceForOrder']>[2],
  ): Promise<PricedPromo> {
    const { code, verdict } = await this.promo.verdictFor(tx, context.orgId, {
      code: input.code,
      lines: input.lines,
      ...(input.orderDiscountPoisha === undefined
        ? {}
        : { orderDiscountPoisha: input.orderDiscountPoisha }),
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

  issueOccasionCode(
    tx: Tx,
    orgId: string,
    input: Parameters<PromoApi['issueOccasionCode']>[2],
  ): Promise<{ readonly codeId: string; readonly code: string }> {
    return this.promo.issueOccasionCode(tx, orgId, input);
  }

  async releaseForOrder(tx: Tx, orgId: string, orderId: string): Promise<boolean> {
    return this.promo.releaseForOrder(tx, orgId, orderId);
  }

  async campaignsOfCodes(
    tx: Tx,
    orgId: string,
    codeIds: readonly string[],
  ): Promise<ReadonlyMap<string, string>> {
    return repo.campaignsOfCodes(tx, orgId, codeIds);
  }

  async quoteDiscounts(
    tx: Tx,
    orgId: string,
    input: Parameters<PromoApi['quoteDiscounts']>[2],
  ): Promise<DiscountQuote> {
    return asHttp(() =>
      this.promo.quote(tx, orgId, {
        lines: input.lines.map((line) => ({
          skuId: line.skuId,
          qty: line.qty,
          netPoisha: line.netPoisha.toString(),
        })),
        deliveryChargePoisha: input.deliveryChargePoisha.toString(),
        channel: input.channel,
        customerId: input.customerId,
        codes: input.codes,
        automatic: input.automatic ?? true,
        now: input.now,
      }),
    );
  }

  async redeem(
    tx: Tx,
    orgId: string,
    input: Parameters<PromoApi['redeem']>[2],
  ): Promise<{ readonly redemptionIds: readonly string[] }> {
    return asHttp(() => this.promo.redeemQuote(tx, { orgId }, input));
  }

  async liveFlashOffers(
    tx: Tx,
    orgId: string,
    skuIds: readonly string[],
    now: Date,
  ): Promise<readonly FlashOffer[]> {
    return this.flash.liveOffers(tx, orgId, skuIds, now);
  }

  async claimFlashUnits(
    tx: Tx,
    orgId: string,
    input: Parameters<PromoApi['claimFlashUnits']>[2],
  ): Promise<{ readonly claimIds: readonly string[] }> {
    return asHttp(() => this.flash.claim(tx, orgId, input));
  }

  async releaseFlashUnits(
    tx: Tx,
    orgId: string,
    orderId: string,
    returned?: readonly { readonly skuId: string; readonly qty: number }[],
  ): Promise<number> {
    return this.flash.release(tx, orgId, orderId, returned);
  }
}
