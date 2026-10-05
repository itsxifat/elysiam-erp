import { add, mulQty, poisha, sub, sum, ZERO, type Poisha } from '../money/index.js';
import { shipsFree, webZoneFor, type ShippingRule, type WebZone } from './shipping.js';

/**
 * What a website cart costs (M34, D-520): the pure rule behind `POST /storefront/v1/cart/quote`
 * and the checkout's re-quote, so the two cannot disagree.
 *
 * In order:
 *
 * 1. **Lines.** The website's lines arrive keyed by SKU (an old variant id is resolved to its
 *    SKU before this runs). Two lines for the same SKU are one line: an order holds a SKU
 *    once. A line is *unavailable* when the SKU is unknown, is not on the website, or the web
 *    locations hold fewer units than it asks for; an unavailable line is reported with its
 *    reason and left out of every total, so the website can say "only 2 left" without the
 *    figures lying about what can be bought.
 * 2. **Unit price.** The shelf price, or the flash sale price the caller planned for the line
 *    (M35a's `planFlashLines`: the cheapest live offer below the shelf price that still covers
 *    the whole line). A planned price at or above the shelf price is ignored.
 * 3. **Delivery.** The shopper's address resolves to an ERP delivery zone, the zone to one of
 *    the website's three zones (`webZoneFor`), and that zone's fee applies — or nothing when
 *    the order ships free. Free shipping when switched on and the items total reaches the
 *    threshold; **a threshold of zero, or none, means every order ships free** (D-503: the old
 *    site kept two thresholds and read one; here it is one number). An address the website
 *    does not ship to is not deliverable and has no fee; no address yet has no fee either.
 * 4. **Discounts.** Priced elsewhere (the promo module, from the lines and the delivery fee
 *    computed here) and handed in: what comes off the goods and what comes off delivery.
 * 5. **Total** = items − discount + delivery − delivery discount: §9's COD for an order with
 *    no advance, which is what `computeOrderTotals` will make of the same figures.
 */

export type CartUnavailableReason =
  'not_found' | 'not_on_website' | 'sold_out' | 'not_enough_stock';

export interface CartLineInput {
  /** The website's own key for the line (its SKU id, or the old variant id it sent). */
  readonly key: string;
  /** The SKU the line resolved to, or null when nothing matched. */
  readonly skuId: string | null;
  readonly qty: number;
}

export interface CartSku {
  readonly id: string;
  /** The catalog's selling price: the shelf price. Never a cost. */
  readonly pricePoisha: Poisha;
  /** Active, on an active product shown on the website. */
  readonly sellable: boolean;
  /** Units the web locations can sell now (`availableForWeb`). */
  readonly availableQty: number;
}

export interface CartDiscount {
  /** The code as the shopper typed it, or the automatic discount's label (M35a). */
  readonly code: string;
  readonly discountPoisha: Poisha;
  readonly deliveryDiscountPoisha: Poisha;
}

export interface CartQuoteInput {
  readonly lines: readonly CartLineInput[];
  readonly skus: ReadonlyMap<string, CartSku>;
  /**
   * The flash sale price each SKU's line is planned at (M35a's `planFlashLines`, on the
   * available lines), by SKU id. A SKU not here is sold at its shelf price.
   */
  readonly flashPrices?: ReadonlyMap<string, Poisha>;
  readonly rule: ShippingRule;
  /**
   * The ERP delivery zone the shopper's address falls in: a zone id, null when the address
   * falls in no zone, undefined when no address was given yet.
   */
  readonly deliveryZoneId?: string | null | undefined;
  readonly discounts?: readonly CartDiscount[];
}

export interface QuotedLine {
  readonly key: string;
  readonly skuId: string;
  readonly qty: number;
  readonly unitPricePoisha: Poisha;
  /** The shelf price, when an offer undercuts it. */
  readonly compareAtPoisha: Poisha | null;
  readonly lineTotalPoisha: Poisha;
  readonly availableQty: number;
}

export interface UnavailableLine {
  readonly key: string;
  readonly skuId: string | null;
  readonly qty: number;
  readonly reason: CartUnavailableReason;
  readonly availableQty: number;
}

export interface CartQuote {
  readonly lines: readonly QuotedLine[];
  readonly unavailable: readonly UnavailableLine[];
  readonly itemsPoisha: Poisha;
  /** The website zone the address fell in; null with no address or one not shipped to. */
  readonly zone: WebZone | null;
  /** True: ships there. False: the website does not ship to that address. Null: no address. */
  readonly deliverable: boolean | null;
  readonly freeShipping: boolean;
  /** The delivery fee before any discount; zero when there is no fee to charge yet. */
  readonly deliveryPoisha: Poisha;
  readonly discounts: readonly CartDiscount[];
  /** What comes off the goods. */
  readonly discountPoisha: Poisha;
  /** What comes off delivery (a free-delivery code). */
  readonly deliveryDiscountPoisha: Poisha;
  /** items − discount + delivery − delivery discount. */
  readonly totalPoisha: Poisha;
}

export class CartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CartError';
  }
}

/** Lines for the same SKU folded into one, in first-seen order; unmatched lines kept apart. */
export function foldCartLines(lines: readonly CartLineInput[]): CartLineInput[] {
  const folded: CartLineInput[] = [];
  const bySku = new Map<string, number>();
  for (const line of lines) {
    if (!Number.isSafeInteger(line.qty) || line.qty <= 0) {
      throw new CartError('A cart line quantity must be a positive whole number.');
    }
    if (line.skuId === null) {
      folded.push(line);
      continue;
    }
    const at = bySku.get(line.skuId);
    if (at === undefined) {
      bySku.set(line.skuId, folded.length);
      folded.push(line);
      continue;
    }
    const first = folded[at];
    if (first !== undefined) folded[at] = { ...first, qty: first.qty + line.qty };
  }
  return folded;
}

export function quoteCart(input: CartQuoteInput): CartQuote {
  const lines: QuotedLine[] = [];
  const unavailable: UnavailableLine[] = [];

  for (const line of foldCartLines(input.lines)) {
    const sku = line.skuId === null ? undefined : input.skus.get(line.skuId);
    if (sku === undefined) {
      unavailable.push({ ...line, reason: 'not_found', availableQty: 0 });
      continue;
    }
    const availableQty = Math.max(0, Math.trunc(sku.availableQty));
    if (!sku.sellable) {
      unavailable.push({ ...line, skuId: sku.id, reason: 'not_on_website', availableQty: 0 });
      continue;
    }
    if (availableQty < line.qty) {
      unavailable.push({
        ...line,
        skuId: sku.id,
        reason: availableQty === 0 ? 'sold_out' : 'not_enough_stock',
        availableQty,
      });
      continue;
    }
    const flash = input.flashPrices?.get(sku.id);
    const onSale = flash !== undefined && flash > 0n && flash < sku.pricePoisha;
    const unitPricePoisha = onSale ? flash : sku.pricePoisha;
    lines.push({
      key: line.key,
      skuId: sku.id,
      qty: line.qty,
      unitPricePoisha,
      compareAtPoisha: onSale ? sku.pricePoisha : null,
      lineTotalPoisha: mulQty(unitPricePoisha, line.qty),
      availableQty,
    });
  }

  const itemsPoisha = sum(lines.map((line) => line.lineTotalPoisha));

  let zone: WebZone | null = null;
  let deliverable: boolean | null = null;
  if (input.deliveryZoneId !== undefined) {
    zone = input.deliveryZoneId === null ? null : webZoneFor(input.rule, input.deliveryZoneId);
    deliverable = zone !== null;
  }
  const freeShipping = shipsFree(input.rule, itemsPoisha);
  const deliveryPoisha =
    zone === null || freeShipping ? ZERO : poisha(input.rule.zones[zone].feePoisha);

  const discounts = input.discounts ?? [];
  for (const discount of discounts) {
    if (discount.discountPoisha < 0n || discount.deliveryDiscountPoisha < 0n) {
      throw new CartError('A discount cannot be negative.');
    }
  }
  const discountPoisha = sum(discounts.map((discount) => discount.discountPoisha));
  const deliveryDiscountPoisha = sum(discounts.map((discount) => discount.deliveryDiscountPoisha));
  if (discountPoisha > itemsPoisha) {
    // The promo engine caps a discount at what the goods are worth; more is a pricing bug,
    // and revenue cannot be negative (§9).
    throw new CartError('The discounts come to more than the goods are worth.');
  }
  if (deliveryDiscountPoisha > deliveryPoisha) {
    throw new CartError('A delivery discount cannot be more than the delivery fee.');
  }

  const totalPoisha = add(
    sub(itemsPoisha, discountPoisha),
    sub(deliveryPoisha, deliveryDiscountPoisha),
  );

  return {
    lines,
    unavailable,
    itemsPoisha,
    zone,
    deliverable,
    freeShipping,
    deliveryPoisha,
    discounts,
    discountPoisha,
    deliveryDiscountPoisha,
    totalPoisha,
  };
}

/** What the website showed the shopper, sent back with the checkout. */
export interface ExpectedCart {
  readonly totalPoisha: Poisha;
  readonly lines?: readonly { readonly skuId: string; readonly unitPricePoisha: Poisha }[];
}

export type RepricedReason = 'total' | 'unit_price' | 'unavailable' | 'not_deliverable';

/**
 * Why a checkout must be refused as repriced (D-521), or an empty list when the quote the
 * server just made is the one the shopper saw. Any moved figure counts: a cheaper total is
 * still a different total, and the shopper agreed to the one on the screen.
 */
export function repricedReasons(expected: ExpectedCart, quote: CartQuote): RepricedReason[] {
  const reasons = new Set<RepricedReason>();
  if (quote.unavailable.length > 0) reasons.add('unavailable');
  if (quote.deliverable !== true) reasons.add('not_deliverable');
  if (expected.totalPoisha !== quote.totalPoisha) reasons.add('total');
  for (const line of expected.lines ?? []) {
    const quoted = quote.lines.find((candidate) => candidate.skuId === line.skuId);
    if (quoted !== undefined && quoted.unitPricePoisha !== line.unitPricePoisha) {
      reasons.add('unit_price');
    }
  }
  return [...reasons];
}

/** An applied discount, as far as choosing the order's attribution needs it. */
export interface AttributableDiscount {
  readonly discountId: string;
  readonly method: 'code' | 'automatic';
  readonly discountPoisha: Poisha;
  readonly deliveryDiscountPoisha: Poisha;
}

/**
 * Which discount an order's `promo_code_id` names when several applied (D-539): M18's
 * attribution reads it, and a code the shopper typed says more about where they came from than
 * a discount everybody got. So the typed code that gave the most (goods plus delivery), else the
 * automatic discount that gave the most, else none; a tie goes to the first the engine listed.
 */
export function attributedDiscount(applied: readonly AttributableDiscount[]): string | null {
  const worth = (discount: AttributableDiscount) =>
    add(discount.discountPoisha, discount.deliveryDiscountPoisha);
  const pick = (method: 'code' | 'automatic') =>
    applied
      .filter((discount) => discount.method === method)
      .reduce<AttributableDiscount | null>(
        (best, discount) => (best === null || worth(discount) > worth(best) ? discount : best),
        null,
      );
  return (pick('code') ?? pick('automatic'))?.discountId ?? null;
}
