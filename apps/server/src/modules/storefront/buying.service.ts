import { createHash } from 'node:crypto';

import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { type CartQuoteRequest, type CheckoutRequest } from '@elysium/contracts';
import { withOrg, type Tx } from '@elysium/db';
import { add, normalizeBdPhone, OrderError, poisha, sub, type Poisha } from '@elysium/domain';
import { planFlashLines, type FlashLinePlan } from '@elysium/domain/promo';
import {
  attributedDiscount,
  availableForWeb,
  gatewayTakesPayments,
  normaliseEmail,
  payableOnline,
  quoteCart,
  repricedReasons,
  UNPAID_ONLINE_ORDER_MINUTES,
  wireMoney,
  type CartLineInput,
  type CartQuote,
  type CartSku,
} from '@elysium/domain/storefront';
import type { Logger } from 'pino';

import { AuditService } from '../../platform/audit/audit.service.js';
import type { RateLimitStore } from '../../platform/http/rate-limit.js';
import { enqueue } from '../../platform/jobs/enqueue.js';
import { createLogger } from '../../platform/logging/logger.js';
import { CATALOG_API, type CatalogApi, type WebSkuFact } from '../catalog/catalog.api.js';
import { INVENTORY_API, type InventoryApi } from '../inventory/inventory.api.js';
import { ORDERS_API, type OrdersApi } from '../orders/orders.api.js';
import { PROMO_API, type PromoApi } from '../promo/promo.api.js';
import type { AppliedDiscountView } from '../promo/promo.service.js';
import * as buying from './buying.repository.js';
import { OrderMail } from './order-mail.js';
import { STOREFRONT_CONFIG, type StorefrontConfig } from './storefront.config.js';
import { StorefrontError, StorefrontRefusal } from './storefront.errors.js';
import { STOREFRONT_QUEUES } from './storefront.queues.js';
import * as repo from './storefront.repository.js';
import { STOREFRONT_RATE_LIMITER } from './signature.guard.js';
import { StorefrontService } from './storefront.service.js';
import { httpCodeOf, newToken, tokenHash } from './tokens.js';
import { TrackingService } from './tracking.service.js';
import { districtName } from './web-marketing.repository.js';

/** The actor a website order is created by: the website key that signed the checkout. */
export function websiteActor(orgId: string, siteKeyId: string) {
  return { orgId, userId: `storefront:${siteKeyId}` };
}

/** What the server worked out for a cart: the quote and what checkout needs to act on it. */
export interface PricedCart {
  readonly quote: CartQuote;
  readonly facts: ReadonlyMap<string, WebSkuFact>;
  /** By SKU: the flash offer each available line is priced by (M35a), or none. */
  readonly flash: ReadonlyMap<string, FlashLinePlan>;
  readonly applied: readonly AppliedDiscountView[];
  readonly refused: readonly { readonly code: string; readonly reason: string }[];
  /** The legacy variant id each unmatched line was sent as, by line key. */
  readonly variantByKey: ReadonlyMap<string, string>;
  readonly webLocationIds: readonly string[];
  readonly customerId: string | null;
}

export interface CheckoutReceipt {
  readonly replayed: boolean;
  readonly body: {
    readonly order: {
      readonly orderNo: string;
      readonly status: string;
      readonly viewToken: string;
      readonly total: ReturnType<typeof wireMoney>;
      readonly payment: { readonly method: 'cod' | 'sslcommerz'; readonly required: boolean };
    };
  };
}

/** Checkouts one shopper address may place in ten minutes (the old site's 30, D-534). */
const CHECKOUTS_PER_10_MINUTES = 30;

/** Thrown inside the checkout's transaction when a concurrent copy of it already committed. */
class AlreadyPlaced extends Error {}

/**
 * The cart quote and the checkout (M34, D-520, D-521).
 *
 * Both run the same pricing, `price()`, in one transaction each: the lines resolved and priced
 * from the catalog, live availability at the web locations, flash prices planned the way
 * checkout claims them (M35a's `planFlashLines`), delivery from the address's zone and the
 * shipping rule, and every discount the promo engine gives (`quoteDiscounts`, D-548) — then the
 * pure `quoteCart` adds it up. A checkout that disagrees with the figures the shopper was shown
 * is refused as `CART_REPRICED` with the new quote, never charged the new figure silently.
 *
 * A checkout creates the order through the orders module (invariant 7: `pending`, the
 * unassigned queue, the buyer by phone as the desk does) and **holds the stock at once** at one
 * web location (D-532), with M07's atomic conditional reserve: two shoppers racing for the last
 * unit get one order and one `409 OUT_OF_STOCK`. In the same transaction, in M35a's order: the
 * discounts are redeemed and then the flash units claimed; the website's own record, a view
 * token, the "order placed" email and, for SSLCommerz, the sixty-minute unpaid-order timer.
 */
@Injectable()
export class BuyingService {
  private cachedLogger: Logger | undefined;

  private get logger(): Logger {
    this.cachedLogger ??= createLogger('storefront');
    return this.cachedLogger;
  }

  constructor(
    @Inject(STOREFRONT_CONFIG) private readonly config: StorefrontConfig,
    @Inject(STOREFRONT_RATE_LIMITER) private readonly limiter: RateLimitStore,
    @Inject(CATALOG_API) private readonly catalog: CatalogApi,
    @Inject(INVENTORY_API) private readonly inventory: InventoryApi,
    @Inject(ORDERS_API) private readonly orders: OrdersApi,
    @Inject(PROMO_API) private readonly promo: PromoApi,
    private readonly settings: StorefrontService,
    private readonly mail: OrderMail,
    private readonly audit: AuditService,
    private readonly tracking: TrackingService,
  ) {}

  // --- the quote ---------------------------------------------------------------------------------

  async quote(orgId: string, input: CartQuoteRequest) {
    return withOrg({ orgId }, async (tx) => {
      const phone = input.phone === undefined ? null : this.phoneOrNull(input.phone);
      const customerId = await this.customerFor(tx, orgId, input.accountId ?? null, phone);
      const priced = await this.price(tx, orgId, {
        lines: input.lines,
        address: input.address ?? null,
        codes: input.codes ?? [],
        customerId,
        now: new Date(),
      });
      return { quote: renderQuote(priced, input.codes ?? []) };
    });
  }

  /**
   * Price a cart in the caller's transaction (D-520). Not cached: availability and flash
   * allocations are live, and a quote is a promise only until the checkout re-runs it.
   */
  async price(
    tx: Tx,
    orgId: string,
    input: {
      readonly lines: CartQuoteRequest['lines'];
      readonly address: { readonly districtId: number; readonly thanaId: number } | null;
      readonly codes: readonly string[];
      readonly customerId: string | null;
      readonly now: Date;
    },
  ): Promise<PricedCart> {
    // 1. Lines: a SKU id as sent, an old variant id through the legacy map (D-505).
    const variantIds = input.lines.flatMap((line) =>
      line.variantId === undefined ? [] : [line.variantId],
    );
    const legacy =
      variantIds.length === 0
        ? new Map<string, string>()
        : await repo.legacyIds(tx, orgId, 'variant', [...new Set(variantIds)]);
    const variantByKey = new Map<string, string>();
    const lines: CartLineInput[] = input.lines.map((line, index) => {
      if (line.skuId !== undefined) return { key: line.skuId, skuId: line.skuId, qty: line.qty };
      const variantId = line.variantId ?? '';
      const key = `variant:${String(index)}`;
      variantByKey.set(key, variantId);
      return { key, skuId: legacy.get(variantId) ?? null, qty: line.qty };
    });

    // 2. The catalog's selling prices and the website's live availability.
    const skuIds = [...new Set(lines.flatMap((line) => (line.skuId === null ? [] : [line.skuId])))];
    const [factRows, settings] = await Promise.all([
      this.catalog.webSkuFacts(tx, orgId, skuIds),
      this.settings.settingsIn(tx, orgId),
    ]);
    const facts = new Map(factRows.map((fact) => [fact.id, fact]));
    const webLocationIds = settings.webLocationIds;
    const levels = await this.inventory.levelsAt(tx, orgId, skuIds, [...webLocationIds]);
    const available = availableForWeb(levels, webLocationIds);
    const skus = new Map<string, CartSku>(
      factRows.map((fact) => [
        fact.id,
        {
          id: fact.id,
          pricePoisha: poisha(fact.pricePoisha),
          sellable: fact.sellable,
          availableQty: available.get(fact.id) ?? 0,
        },
      ]),
    );

    // 3. Where it goes.
    let deliveryZoneId: string | null | undefined;
    if (input.address !== null) {
      const area = await this.orders.deliveryZoneForArea(
        tx,
        orgId,
        input.address.districtId,
        input.address.thanaId,
      );
      if (!area.valid) {
        throw new StorefrontError(
          'VALIDATION_FAILED',
          HttpStatus.BAD_REQUEST,
          'That thana is not one of the district’s. Choose the district, then a thana in it.',
        );
      }
      deliveryZoneId = area.zoneId;
    }
    const rule = await this.shippingRule(tx, orgId);

    // 4. Flash prices, planned on the lines that can be bought (M35a, D-542).
    const first = quoteCart({ lines, skus, rule, deliveryZoneId });
    const flash = new Map<string, FlashLinePlan>();
    if (first.lines.length > 0) {
      const offers = await this.promo.liveFlashOffers(
        tx,
        orgId,
        first.lines.map((line) => line.skuId),
        input.now,
      );
      if (offers.length > 0) {
        const plans = planFlashLines(
          first.lines.map((line) => ({
            skuId: line.skuId,
            qty: line.qty,
            shelfPricePoisha: line.unitPricePoisha,
          })),
          offers,
          input.now,
        );
        plans.forEach((plan, index) => {
          const line = first.lines[index];
          if (line !== undefined && plan.offer !== null) flash.set(line.skuId, plan);
        });
      }
    }
    const flashPrices = new Map(
      [...flash.entries()].map(([skuId, plan]) => [skuId, plan.unitPricePoisha]),
    );
    const second = quoteCart({ lines, skus, rule, deliveryZoneId, flashPrices });

    // 5. Every discount the engine gives this basket (D-540, D-548).
    let applied: readonly AppliedDiscountView[] = [];
    let refused: readonly { code: string; reason: string }[];
    if (second.lines.length > 0) {
      const discounts = await this.promo.quoteDiscounts(tx, orgId, {
        lines: second.lines.map((line) => ({
          skuId: line.skuId,
          qty: line.qty,
          netPoisha: line.lineTotalPoisha,
        })),
        customerId: input.customerId,
        channel: 'website',
        codes: input.codes,
        deliveryChargePoisha: second.deliveryPoisha,
        now: input.now,
      });
      applied = discounts.applied;
      refused = discounts.refused.map((entry) => ({ code: entry.code, reason: entry.reason }));
    } else {
      refused = input.codes.map((code) => ({ code, reason: 'empty_cart' }));
    }

    const quote = quoteCart({
      lines,
      skus,
      rule,
      deliveryZoneId,
      flashPrices,
      discounts: applied.map((discount) => ({
        code: discount.code ?? discount.title,
        discountPoisha: poisha(discount.discountPoisha),
        deliveryDiscountPoisha: poisha(discount.deliveryDiscountPoisha),
      })),
    });
    return {
      quote,
      facts,
      flash,
      applied,
      refused,
      variantByKey,
      webLocationIds,
      customerId: input.customerId,
    };
  }

  // --- the checkout ------------------------------------------------------------------------------

  async checkout(
    site: { readonly orgId: string; readonly siteKeyId: string },
    input: CheckoutRequest,
    request: { readonly idempotencyKey: string; readonly rawBody: Buffer },
  ): Promise<CheckoutReceipt> {
    const { orgId } = site;
    // The old site's ceiling, per shopper address (D-534): loose, because mobile shoppers share
    // carrier NAT; it stops a script, not a street of buyers.
    if (input.client !== undefined) {
      const decision = await this.limiter.hit(
        `storefront:checkout:${orgId}:${input.client.ip}`,
        CHECKOUTS_PER_10_MINUTES,
        600,
      );
      if (!decision.allowed) {
        throw new StorefrontError(
          'RATE_LIMITED',
          HttpStatus.TOO_MANY_REQUESTS,
          'Too many orders from this shopper. Wait a few minutes and try again.',
          decision.retryAfterSeconds ?? 600,
        );
      }
    }
    const phone = this.phoneOf(input.contact.phone);
    const email =
      input.contact.email === undefined || input.contact.email === ''
        ? null
        : normaliseEmail(input.contact.email);
    if (input.contact.email !== undefined && input.contact.email !== '' && email === null) {
      throw new StorefrontError(
        'VALIDATION_FAILED',
        HttpStatus.BAD_REQUEST,
        'contact.email: that is not an email address.',
      );
    }
    const requestSha256 = createHash('sha256').update(request.rawBody).digest('hex');

    // A replay answers from the record, before anything is priced or held.
    const previous = await withOrg({ orgId }, (tx) =>
      buying.checkoutFor(tx, orgId, site.siteKeyId, request.idempotencyKey),
    );
    if (previous !== undefined) return this.replay(site, previous, requestSha256);

    const actor = websiteActor(orgId, site.siteKeyId);
    try {
      return await withOrg(actor, async (tx) => {
        const claim = await buying.claimCheckout(tx, {
          orgId,
          siteKeyId: site.siteKeyId,
          idempotencyKey: request.idempotencyKey,
          requestSha256,
        });
        if (claim === undefined) throw new AlreadyPlaced();

        const settings = await this.settings.settingsIn(tx, orgId);
        await this.assertPaymentMethod(tx, orgId, settings.payments, input.paymentMethod);

        const account =
          input.accountId === undefined
            ? undefined
            : await buying.accountById(tx, orgId, input.accountId);
        if (input.accountId !== undefined && account === undefined) {
          throw new StorefrontError('ACCOUNT_NOT_FOUND', HttpStatus.NOT_FOUND, 'No such account.');
        }
        const orderEmail = email ?? account?.email ?? null;
        if (input.paymentMethod === 'sslcommerz' && orderEmail === null) {
          throw new StorefrontError(
            'VALIDATION_FAILED',
            HttpStatus.BAD_REQUEST,
            'contact.email: paying online needs an email address for the gateway’s receipt.',
          );
        }

        const now = new Date();
        // The buyer the order will belong to — the one its phone names — so discount limits
        // are counted against the buyer the redemption is recorded for (ledger audit N6).
        const customerId = await this.customerFor(tx, orgId, null, phone);
        const priced = await this.price(tx, orgId, {
          lines: input.lines,
          address: { districtId: input.address.districtId, thanaId: input.address.thanaId },
          codes: input.codes ?? [],
          customerId,
          now,
        });
        const { quote } = priced;
        if (quote.unavailable.length > 0) throw outOfStock(priced);
        if (quote.deliverable !== true) {
          throw new StorefrontError(
            'CART_NOT_DELIVERABLE',
            HttpStatus.CONFLICT,
            'The website does not deliver to that address.',
          );
        }
        const reasons = repricedReasons(
          {
            totalPoisha: poisha(input.expected.totalPoisha),
            lines: (input.expected.lines ?? []).map((line) => ({
              skuId: line.skuId,
              unitPricePoisha: poisha(line.unitPricePoisha),
            })),
          },
          quote,
        );
        if (reasons.length > 0) throw repriced(priced, input.codes ?? []);
        if (input.paymentMethod === 'sslcommerz' && !payableOnline(quote.totalPoisha)) {
          // Outside SSLCommerz's range (৳10 to ৳5,00,000): the page would never open, and
          // the order would hold its stock for an hour for nothing (ledger audit N1).
          throw new StorefrontError(
            'PAYMENT_METHOD_UNAVAILABLE',
            HttpStatus.CONFLICT,
            'This order cannot be paid online; choose cash on delivery.',
          );
        }

        const locationId = await this.holdLocation(tx, orgId, priced);

        const created = await this.orders.createOrder(
          tx,
          actor,
          {
            channel: 'website',
            source: {},
            customer: { phone, name: input.contact.name },
            shipTo: {
              name: input.contact.name,
              districtId: input.address.districtId,
              thanaId: input.address.thanaId,
              ...(input.address.area === undefined || input.address.area === ''
                ? {}
                : { area: input.address.area }),
              addressLine: input.address.addressLine,
            },
            lines: quote.lines.map((line) => ({
              skuId: line.skuId,
              qty: line.qty,
              unitPricePoisha: line.unitPricePoisha.toString(),
            })),
            deliveryChargePoisha: sub(
              quote.deliveryPoisha,
              quote.deliveryDiscountPoisha,
            ).toString(),
            discountPoisha: quote.discountPoisha.toString(),
            ...(input.notes === undefined || input.notes === '' ? {} : { notes: input.notes }),
          },
          { holdStockAt: locationId, promoCodeId: attributedDiscount(priced.applied) },
        );
        if (BigInt(created.codAmountPoisha) !== quote.totalPoisha) {
          // The orders module and the quote disagree: a bug in one of them, and never a figure
          // to charge a shopper. Rolled back.
          this.logger.error(
            { orderTotal: created.codAmountPoisha, quoteTotal: quote.totalPoisha.toString() },
            'a checkout total did not match its quote',
          );
          throw repriced(priced, input.codes ?? []);
        }
        const summary = await this.orders.summary(tx, orgId, created.id);
        if (summary === undefined) throw new Error('an order just created could not be read');

        // M35a's order: redeem, then claim the flash units (D-548).
        if (priced.applied.length > 0) {
          await this.promo.redeem(tx, orgId, {
            orderId: created.id,
            customerId: summary.customerId,
            applied: priced.applied,
          });
        }
        if (priced.flash.size > 0) {
          const orderLines = await this.orders.shopperOrderLines(tx, orgId, created.id);
          await this.promo.claimFlashUnits(tx, orgId, {
            orderId: created.id,
            lines: orderLines.flatMap((line) => {
              const plan = priced.flash.get(line.skuId);
              if (plan?.offer == null) return [];
              return [
                {
                  orderLineId: line.id,
                  skuId: line.skuId,
                  qty: line.qty,
                  flashSaleItemId: plan.offer.flashSaleItemId,
                  salePricePoisha: plan.offer.salePricePoisha,
                },
              ];
            }),
          });
        }

        const locale =
          account?.locale === 'en' || account?.locale === 'bn'
            ? (input.locale ?? account.locale)
            : (input.locale ?? 'bn');
        await buying.insertWebOrder(tx, {
          orgId,
          orderId: created.id,
          accountId: account?.id ?? null,
          email: orderEmail,
          locale,
          paymentMethod: input.paymentMethod,
          phoneE164: phone,
        });
        if (account !== undefined) {
          await this.linkAccountToBuyer(tx, orgId, account, phone, summary.customerId);
        }

        const viewToken = newToken();
        await buying.insertViewToken(tx, {
          orgId,
          orderId: created.id,
          tokenSha256: tokenHash(viewToken),
          purpose: 'confirmation',
        });
        await buying.completeCheckout(tx, orgId, claim, created.id);

        // M35b (D-552): the server-side Purchase, `purchase_<order no>`, as the confirmation
        // page's browser event names it. Cash on delivery goes now; paid online, it waits for
        // the payment.
        await this.tracking.recordPurchase(tx, orgId, {
          orderId: created.id,
          orderNo: created.orderNo,
          totalPoisha: quote.totalPoisha,
          lines: quote.lines.map((line) => {
            const fact = priced.facts.get(line.skuId);
            return {
              productId: fact?.productId ?? line.skuId,
              name: fact?.productName ?? '',
              qty: line.qty,
              unitPricePoisha: line.unitPricePoisha,
            };
          }),
          buyer: {
            name: input.contact.name,
            phoneE164: phone,
            email: orderEmail,
            city: await districtName(tx, input.address.districtId),
            customerId: summary.customerId,
          },
          browser: input.tracking,
          client: input.client,
          waitForPayment: input.paymentMethod === 'sslcommerz',
        });

        if (orderEmail !== null) {
          await this.mail.queueOrderEmail(tx, orgId, {
            orderId: created.id,
            orderNo: created.orderNo,
            template: 'order.placed',
            to: orderEmail,
            locale,
            name: input.contact.name,
            totalPoisha: quote.totalPoisha,
          });
        }
        if (input.paymentMethod === 'sslcommerz') {
          await enqueue(
            tx,
            STOREFRONT_QUEUES.expireUnpaid.name,
            { orderId: created.id },
            {
              orgId,
              ref: created.id,
              startAfter: new Date(
                now.getTime() +
                  (this.config.STOREFRONT_UNPAID_ORDER_MINUTES ?? UNPAID_ONLINE_ORDER_MINUTES) *
                    60_000,
              ),
            },
          );
        }

        await this.audit.record(tx, {
          orgId,
          actorUserId: actor.userId,
          operation: 'create',
          action: 'storefront.checkout',
          entityType: 'order',
          entityId: created.id,
          // `phone`, so the audit's redactor masks it (invariant 10).
          after: {
            orderNo: created.orderNo,
            paymentMethod: input.paymentMethod,
            totalPoisha: quote.totalPoisha.toString(),
            heldAt: locationId,
            discounts: priced.applied.length,
            flashLines: priced.flash.size,
            accountId: account?.id ?? null,
            phone,
          },
        });

        return {
          replayed: false,
          body: {
            order: {
              orderNo: created.orderNo,
              status: 'placed',
              viewToken,
              total: wireMoney(quote.totalPoisha),
              payment: {
                method: input.paymentMethod,
                required: input.paymentMethod === 'sslcommerz',
              },
            },
          },
        };
      });
    } catch (error) {
      if (error instanceof AlreadyPlaced) {
        const raced = await withOrg({ orgId }, (tx) =>
          buying.checkoutFor(tx, orgId, site.siteKeyId, request.idempotencyKey),
        );
        if (raced === undefined) {
          throw new StorefrontError(
            'IDEMPOTENCY_IN_FLIGHT',
            HttpStatus.CONFLICT,
            'That checkout is still being placed. Retry in a moment with the same Idempotency-Key.',
          );
        }
        return this.replay(site, raced, requestSha256);
      }
      throw await this.refusalOf(error, orgId, input);
    }
  }

  // --- the pieces --------------------------------------------------------------------------------

  /**
   * The web location that holds the whole order (D-521): the first, in the brand's order, where
   * every line has its units free. An order is held and dispatched at one place.
   */
  private async holdLocation(tx: Tx, orgId: string, priced: PricedCart): Promise<string> {
    const lines = priced.quote.lines;
    const levels = await this.inventory.levelsAt(
      tx,
      orgId,
      lines.map((line) => line.skuId),
      [...priced.webLocationIds],
    );
    let best: { id: string; short: string[] } | null = null;
    for (const locationId of priced.webLocationIds) {
      const free = availableForWeb(
        levels.filter((level) => level.locationId === locationId),
        [locationId],
      );
      const short = lines
        .filter((line) => (free.get(line.skuId) ?? 0) < line.qty)
        .map((line) => line.skuId);
      if (short.length === 0) return locationId;
      if (best === null || short.length < best.short.length) best = { id: locationId, short };
    }
    throw new StorefrontRefusal(
      'OUT_OF_STOCK',
      HttpStatus.CONFLICT,
      'Some of these items are no longer available in the quantity asked.',
      {
        lines: lines
          .filter((line) => best === null || best.short.includes(line.skuId))
          .map((line) => ({
            skuId: line.skuId,
            qty: line.qty,
            availableQty: Math.min(line.availableQty, line.qty - 1),
          })),
      },
    );
  }

  private async replay(
    site: { readonly orgId: string; readonly siteKeyId: string },
    previous: { readonly request_sha256: string; readonly order_id: string | null },
    requestSha256: string,
  ): Promise<CheckoutReceipt> {
    if (previous.request_sha256 !== requestSha256) {
      throw new StorefrontError(
        'IDEMPOTENCY_CONFLICT',
        HttpStatus.CONFLICT,
        'That Idempotency-Key was already used for a different checkout.',
      );
    }
    const orderId = previous.order_id;
    if (orderId === null) {
      throw new StorefrontError(
        'IDEMPOTENCY_IN_FLIGHT',
        HttpStatus.CONFLICT,
        'That checkout is still being placed. Retry in a moment with the same Idempotency-Key.',
      );
    }
    const { orgId } = site;
    // The first answer's token is only ever in that answer; the retry gets a fresh one.
    return withOrg(websiteActor(orgId, site.siteKeyId), async (tx) => {
      const [order] = await this.orders.shopperOrders(tx, orgId, [orderId]);
      const web = await buying.webOrder(tx, orgId, orderId);
      if (order === undefined || web === undefined) throw new Error('a placed order vanished');
      const viewToken = newToken();
      await buying.insertViewToken(tx, {
        orgId,
        orderId,
        tokenSha256: tokenHash(viewToken),
        purpose: 'confirmation',
      });
      const method = web.payment_method === 'sslcommerz' ? 'sslcommerz' : 'cod';
      return {
        replayed: true,
        body: {
          order: {
            orderNo: order.orderNo,
            status: 'placed',
            viewToken,
            total: wireMoney(
              add(
                sub(poisha(order.itemsPoisha), poisha(order.discountPoisha)),
                poisha(order.deliveryChargePoisha),
              ),
            ),
            payment: { method, required: method === 'sslcommerz' },
          },
        },
      };
    });
  }

  /** A refusal from inside the checkout, as what the website is told. */
  private async refusalOf(error: unknown, orgId: string, input: CheckoutRequest): Promise<unknown> {
    if (error instanceof StorefrontError) return error;
    const code = httpCodeOf(error) ?? (error as { code?: unknown } | null)?.code;
    if (code === 'STOCK_INSUFFICIENT') {
      // Lost the race for the last units: the transaction rolled back, so the shelves are read
      // again to name the lines that are short now.
      const priced = await withOrg({ orgId }, (tx) =>
        this.price(tx, orgId, {
          lines: input.lines,
          address: null,
          codes: [],
          customerId: null,
          now: new Date(),
        }),
      );
      return priced.quote.unavailable.length > 0
        ? outOfStock(priced)
        : new StorefrontRefusal(
            'OUT_OF_STOCK',
            HttpStatus.CONFLICT,
            'Some of these items were just taken by another order.',
            {
              lines: priced.quote.lines.map((line) => ({
                skuId: line.skuId,
                qty: line.qty,
                availableQty: line.availableQty,
              })),
            },
          );
    }
    if (code === 'PROMO_NOT_APPLICABLE' || code === 'FLASH_SALE_UNAVAILABLE') {
      // A discount ran out or a flash allocation was taken between the price and the claim:
      // priced again for the same buyer, so the new quote does not offer it again (audit N7).
      const fresh = await withOrg({ orgId }, async (tx) =>
        this.price(tx, orgId, {
          lines: input.lines,
          address: { districtId: input.address.districtId, thanaId: input.address.thanaId },
          codes: input.codes ?? [],
          customerId: await this.customerFor(
            tx,
            orgId,
            null,
            this.phoneOrNull(input.contact.phone),
          ),
          now: new Date(),
        }),
      );
      return repriced(fresh, input.codes ?? []);
    }
    if (error instanceof OrderError) {
      return new StorefrontError(
        error.code === 'ORDER_PHONE_INVALID' ? 'ORDER_PHONE_INVALID' : 'VALIDATION_FAILED',
        HttpStatus.BAD_REQUEST,
        error.message,
      );
    }
    return error;
  }

  private async assertPaymentMethod(
    tx: Tx,
    orgId: string,
    switches: { readonly cod: boolean; readonly sslcommerz: boolean },
    method: 'cod' | 'sslcommerz',
  ): Promise<void> {
    if (method === 'cod' && switches.cod) return;
    if (method === 'sslcommerz' && switches.sslcommerz) {
      const gateway = await buying.gatewaySettings(tx, orgId);
      if (
        gateway?.enabled === true &&
        gatewayTakesPayments(gateway.mode, this.config.STOREFRONT_SSLCOMMERZ_ALLOW_SANDBOX)
      ) {
        return;
      }
    }
    throw new StorefrontError(
      'PAYMENT_METHOD_UNAVAILABLE',
      HttpStatus.CONFLICT,
      method === 'cod'
        ? 'Cash on delivery is switched off for this website.'
        : 'Paying online is not available on this website.',
    );
  }

  /**
   * The buyer the discount engine counts limits against (D-541): a signed-in account's linked
   * buyer, else the buyer the phone names, else none (a first-time shopper).
   */
  private async customerFor(
    tx: Tx,
    orgId: string,
    accountId: string | null,
    phone: string | null,
  ): Promise<string | null> {
    // The phone the order will be placed with names its buyer, so the quote and the checkout
    // count limits against the same buyer the redemption is recorded for (ledger audit N6).
    if (phone !== null) return (await this.orders.buyerIdByPhone(tx, orgId, phone)) ?? null;
    if (accountId === null) return null;
    const account = await buying.accountById(tx, orgId, accountId);
    if (account?.customer_id != null) return account.customer_id;
    if (account?.phone_e164 == null) return null;
    return (await this.orders.buyerIdByPhone(tx, orgId, account.phone_e164)) ?? null;
  }

  /**
   * An account meets its buyer (D-533): the first order placed with the account's own phone (or
   * by an account that has none yet) links the account to that buyer, so the desk sees the
   * account on the buyer's profile.
   */
  private async linkAccountToBuyer(
    tx: Tx,
    orgId: string,
    account: buying.AccountRow,
    phone: string,
    customerId: string,
  ): Promise<void> {
    if (account.customer_id !== null) return;
    if (account.phone_e164 !== null && account.phone_e164 !== phone) return;
    await buying.updateProfile(tx, {
      orgId,
      id: account.id,
      customerId,
      ...(account.phone_e164 === null ? { phoneE164: phone } : {}),
    });
  }

  private async shippingRule(tx: Tx, orgId: string) {
    const { shipping } = await this.settings.settingsIn(tx, orgId);
    const zone = (key: 'inside_dhaka' | 'suburbs' | 'outside_dhaka') => ({
      feePoisha: poisha(shipping.zones[key].feePoisha),
      deliveryZoneIds: shipping.zones[key].deliveryZoneIds,
    });
    return {
      freeShippingEnabled: shipping.freeShippingEnabled,
      freeShippingThresholdPoisha:
        shipping.freeShippingThresholdPoisha === null
          ? null
          : poisha(shipping.freeShippingThresholdPoisha),
      zones: {
        inside_dhaka: zone('inside_dhaka'),
        suburbs: zone('suburbs'),
        outside_dhaka: zone('outside_dhaka'),
      },
    };
  }

  private phoneOf(input: string): string {
    try {
      return normalizeBdPhone(input);
    } catch {
      throw new StorefrontError(
        'ORDER_PHONE_INVALID',
        HttpStatus.BAD_REQUEST,
        'That is not a Bangladeshi mobile number.',
      );
    }
  }

  private phoneOrNull(input: string): string | null {
    try {
      return normalizeBdPhone(input);
    } catch {
      return null;
    }
  }
}

function sizeOf(fact: WebSkuFact | undefined, kind: string): string | null {
  return fact?.values.find((value) => value.kind === kind)?.label ?? null;
}

/** A priced cart as the website is told about it. Money as `{ poisha, taka }`. */
export function renderQuote(priced: PricedCart, codes: readonly string[]) {
  const { quote, facts } = priced;
  const appliedCodes = new Set(
    priced.applied.flatMap((discount) =>
      discount.code === null ? [] : [discount.code.toUpperCase()],
    ),
  );
  return {
    lines: quote.lines.map((line) => {
      const fact = facts.get(line.skuId);
      return {
        skuId: line.skuId,
        sku: fact?.code ?? null,
        name: fact?.productName ?? null,
        slug: fact?.productSlug ?? null,
        size: sizeOf(fact, 'size'),
        colour: sizeOf(fact, 'colour'),
        qty: line.qty,
        unitPrice: wireMoney(line.unitPricePoisha),
        compareAt: line.compareAtPoisha === null ? null : wireMoney(line.compareAtPoisha),
        lineTotal: wireMoney(line.lineTotalPoisha),
        availableQty: line.availableQty,
        flashSale: priced.flash.has(line.skuId),
      };
    }),
    unavailable: quote.unavailable.map((line) => ({
      skuId: line.skuId,
      variantId: priced.variantByKey.get(line.key) ?? null,
      qty: line.qty,
      reason: line.reason,
      availableQty: line.availableQty,
    })),
    discounts: priced.applied.map((discount) => ({
      code: discount.code,
      title: discount.title,
      kind: discount.kind,
      automatic: discount.method === 'automatic',
      amount: wireMoney(discount.discountPoisha),
      deliveryAmount: wireMoney(discount.deliveryDiscountPoisha),
    })),
    codes: codes.map((code) => {
      const refusal = priced.refused.find(
        (entry) => entry.code.toUpperCase() === code.toUpperCase(),
      );
      return {
        code,
        applied: appliedCodes.has(code.toUpperCase()),
        reason: refusal?.reason ?? null,
      };
    }),
    items: wireMoney(quote.itemsPoisha),
    discount: wireMoney(quote.discountPoisha),
    delivery: wireMoney(quote.deliveryPoisha),
    deliveryDiscount: wireMoney(quote.deliveryDiscountPoisha),
    total: wireMoney(quote.totalPoisha),
    deliverable: quote.deliverable,
    zone: quote.zone,
    freeShipping: quote.freeShipping,
  };
}

function outOfStock(priced: PricedCart): StorefrontRefusal {
  return new StorefrontRefusal(
    'OUT_OF_STOCK',
    HttpStatus.CONFLICT,
    'Some of these items are no longer available in the quantity asked.',
    {
      lines: priced.quote.unavailable.map((line) => ({
        skuId: line.skuId,
        variantId: priced.variantByKey.get(line.key) ?? null,
        qty: line.qty,
        reason: line.reason,
        availableQty: line.availableQty,
      })),
    },
  );
}

function repriced(priced: PricedCart, codes: readonly string[]): StorefrontRefusal {
  return new StorefrontRefusal(
    'CART_REPRICED',
    HttpStatus.CONFLICT,
    'A price, a discount or the delivery charge changed. Show the shopper the new total and ask again.',
    { quote: renderQuote(priced, codes) },
  );
}

export type { Poisha };
