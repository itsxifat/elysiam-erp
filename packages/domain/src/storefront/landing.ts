import {
  add,
  BASIS_POINTS,
  mulQty,
  roundedToTaka,
  sub,
  sum,
  ZERO,
  type Poisha,
} from '../money/index.js';
import { shipsFree, type ShippingRule, type WebZone } from './shipping.js';

/**
 * The website's landing pages (M35b, D-550): the pricing rule behind
 * `POST /storefront/v1/landing-pages/:code/orders`, ported from the old site's
 * `lib/landing-pricing.js`, `lib/landing-promotions.js` and the order route's arithmetic into
 * integer poisha.
 *
 * **The page decides the price, never the request.** A shopper's request only chooses which
 * offer, which sizes and where to deliver; `priceLandingOrder` reprices everything from the
 * page's published offer, the catalog's live selling prices and the page's own delivery and
 * promotion rules. A tampered request can only ever produce the price the page was set to.
 *
 * In order:
 *
 * 1. **The offer** names the goods. *Fixed*: its lines are sold together, each at a quantity,
 *    a size pinned or chosen by the shopper. *Collection*: a pool the shopper mixes from, the
 *    total quantity choosing a rung of a hand-typed price ladder. *À la carte*: a pool the
 *    shopper picks from, each item at its own price.
 * 2. **Regular total** = Σ the catalog's selling price × quantity. The order's lines carry
 *    these honest prices; the offer's saving is an order discount.
 * 3. **Offer total**: fixed and à la carte apply the pricing mode (`auto` none, `fixed` the
 *    whole offer's price, `percent` off, `amount` off); a collection takes its rung's price.
 *    Never below zero and never above the regular total.
 * 4. **Delivery**: the page's own rule — the website's charge for the address (`settings`),
 *    free, one flat rate, or the page's three zone rates.
 * 5. **Promotions**: the single best "spend or buy this much, get this off" rule, and free
 *    delivery once a threshold is met (both measured on the offer total and the pieces).
 * 6. **Total** = offer total − promotion + delivery, never below zero: §9's COD for an order
 *    whose items are the regular total and whose discount is (regular − offer) + promotion.
 *
 * **Rounding.** The old site rounded every percentage result to the whole taka; so does this,
 * through the money module (`roundedToTaka`, half away from zero). Every other figure is the
 * page's or the catalog's, exactly.
 *
 * Departures from the old site, each deliberate and tested:
 * - a collection rung above the regular total is charged the regular total (the old route
 *   would have stored a negative discount);
 * - totals are clamped to the regular total itself, not to it rounded to the taka;
 * - the `settings` delivery mode is the website's own rule for the address, free-shipping
 *   threshold included (the old site's settings had no threshold to honour);
 * - two lines of one SKU are one order line (an order holds a SKU once).
 */

export const LANDING_OFFER_KINDS = ['fixed', 'collection', 'alacarte'] as const;
export type LandingOfferKind = (typeof LANDING_OFFER_KINDS)[number];

export const LANDING_PRICING_MODES = ['auto', 'fixed', 'percent', 'amount'] as const;
export type LandingPricingMode = (typeof LANDING_PRICING_MODES)[number];

export const LANDING_SHIPPING_MODES = ['settings', 'free', 'flat', 'zones'] as const;
export type LandingShippingMode = (typeof LANDING_SHIPPING_MODES)[number];

/** The most pieces one landing order may carry, whatever an offer's own maximum says. */
export const LANDING_MAX_PIECES = 100;

/** One product an offer sells or pools: a quantity, and a size pinned or left to the shopper. */
export interface LandingOfferItem {
  readonly productId: string;
  /** Fixed offers only; a pool counts the shopper's own quantities. */
  readonly quantity: number;
  /** A pinned variant (SKU), or null to let the shopper choose. */
  readonly skuId: string | null;
}

export interface LandingTier {
  /** "Buy this many in total…" */
  readonly quantity: number;
  /** "…pay exactly this." */
  readonly pricePoisha: Poisha;
}

export interface LandingOffer {
  readonly key: string;
  readonly label: string;
  readonly kind: LandingOfferKind;
  readonly items: readonly LandingOfferItem[];
  readonly pricingMode: LandingPricingMode;
  /** The whole offer's price (`fixed`) or the amount off (`amount`). */
  readonly priceValuePoisha: Poisha;
  /** The percentage off (`percent`), in basis points: 12.5% is 1250. */
  readonly percentBps: number;
  /** Collection only: the price ladder. */
  readonly tiers: readonly LandingTier[];
  /** Pool kinds: the fewest and most pieces (0 = no limit). */
  readonly minQty: number;
  readonly maxQty: number;
  /** A strike-through price the page shows; zero means the computed regular total. */
  readonly compareAtPoisha: Poisha;
  readonly isActive: boolean;
}

export interface LandingShipping {
  readonly mode: LandingShippingMode;
  readonly flatPoisha: Poisha;
  readonly zonesPoisha: Readonly<Record<WebZone, Poisha>>;
  /** Off: everyone pays the inside-Dhaka rate, whatever the address. */
  readonly askZone: boolean;
}

export type LandingRuleBasis = 'amount' | 'quantity';
export type LandingRewardType = 'amount' | 'percent';

export interface LandingDiscountRule {
  readonly basis: LandingRuleBasis;
  /** Basis `amount`: the offer total that triggers it. */
  readonly thresholdPoisha: Poisha;
  /** Basis `quantity`: the pieces that trigger it. */
  readonly thresholdQty: number;
  readonly rewardType: LandingRewardType;
  /** Reward `amount`: what comes off. */
  readonly valuePoisha: Poisha;
  /** Reward `percent`: the percentage off, in basis points. */
  readonly percentBps: number;
  /** Reward `percent`: the most it may take off; zero is uncapped. */
  readonly maxDiscountPoisha: Poisha;
  readonly label: string;
}

export interface LandingPromotions {
  readonly freeShipping: {
    readonly enabled: boolean;
    /** Zero ignores this condition. */
    readonly minSubtotalPoisha: Poisha;
    /** Zero ignores this condition. */
    readonly minQuantity: number;
  };
  readonly discountRules: readonly LandingDiscountRule[];
}

/** A variant as the page's pricing sees it: the selling price and what the website holds. */
export interface LandingSku {
  readonly id: string;
  readonly productId: string;
  /** The catalog's selling price. Never a cost. */
  readonly pricePoisha: Poisha;
  /** An active SKU of an active product shown on the website. */
  readonly sellable: boolean;
  /** Units the web locations can sell now. */
  readonly availableQty: number;
}

/** What the shopper chose: a size per fixed line, or picks from a pool. */
export type LandingChoice =
  | { readonly kind: 'fixed'; readonly lineSkus: readonly (string | null)[] }
  | {
      readonly kind: 'pool';
      readonly selections: readonly { readonly skuId: string; readonly qty: number }[];
    };

export interface LandingPricingInput {
  readonly offer: LandingOffer;
  readonly choice: LandingChoice;
  /** Every SKU of every product the offer names, sellable or not, by product. */
  readonly skusByProduct: ReadonlyMap<string, readonly LandingSku[]>;
  readonly shipping: LandingShipping;
  readonly promotions: LandingPromotions;
  /** The website's own rule, for the `settings` delivery mode. */
  readonly websiteRule: ShippingRule;
  /**
   * The website zone the address falls in: a zone, null when the website does not deliver
   * there, undefined when no address was given (no delivery charge is known yet).
   */
  readonly zone?: WebZone | null | undefined;
}

export type LandingRefusal =
  | { readonly code: 'offer_unavailable' }
  | { readonly code: 'offer_empty' }
  | { readonly code: 'no_pricing' }
  | { readonly code: 'nothing_chosen' }
  | { readonly code: 'choose_size'; readonly productId: string }
  | { readonly code: 'size_unavailable'; readonly productId: string }
  | { readonly code: 'not_in_offer'; readonly skuId: string }
  | { readonly code: 'too_few'; readonly min: number }
  | { readonly code: 'too_many'; readonly max: number }
  | {
      readonly code: 'out_of_stock';
      readonly skuId: string;
      readonly qty: number;
      readonly availableQty: number;
    }
  | { readonly code: 'no_tier_price'; readonly qty: number };

export interface LandingOrderLine {
  readonly skuId: string;
  readonly qty: number;
  /** The catalog's selling price: the order keeps honest product prices. */
  readonly unitPricePoisha: Poisha;
}

export interface LandingPrice {
  readonly lines: readonly LandingOrderLine[];
  readonly pieces: number;
  /** Σ selling price × quantity. */
  readonly regularPoisha: Poisha;
  /** What the offer charges for the goods. */
  readonly offerPoisha: Poisha;
  /** regular − offer. */
  readonly offerDiscountPoisha: Poisha;
  /** The page promotion's saving, at most the offer total. */
  readonly promoDiscountPoisha: Poisha;
  readonly promoLabel: string;
  readonly freeShipping: boolean;
  /** The delivery charge before any promotion: what the page's rule charges this address. */
  readonly baseDeliveryPoisha: Poisha;
  /** What the shopper pays for delivery. */
  readonly deliveryPoisha: Poisha;
  /** Whether the page delivers to the address; null when no address was given. */
  readonly deliverable: boolean | null;
  /** The order discount: offer saving + promotion. */
  readonly discountPoisha: Poisha;
  /** offer − promotion + delivery: the COD. */
  readonly totalPoisha: Poisha;
}

export type LandingPricing =
  ({ readonly ok: true } & LandingPrice) | { readonly ok: false; readonly refusal: LandingRefusal };

const max0 = (value: Poisha): Poisha => (value < 0n ? ZERO : value);
const min = (a: Poisha, b: Poisha): Poisha => (a < b ? a : b);
const clampBps = (bps: number): bigint =>
  BigInt(Math.max(0, Math.min(Number(BASIS_POINTS), Math.trunc(bps))));

/**
 * An offer's pricing mode applied to the regular total (the old `applyOfferPricing`): never
 * below zero, never above the regular total. A percentage is rounded to the whole taka on the
 * total the shopper pays, as the old site rounded it.
 */
export function applyOfferPricing(
  pricing: {
    readonly pricingMode: LandingPricingMode;
    readonly priceValuePoisha: Poisha;
    readonly percentBps: number;
  },
  regularPoisha: Poisha,
): Poisha {
  let total: Poisha;
  switch (pricing.pricingMode) {
    case 'fixed':
      total = max0(pricing.priceValuePoisha);
      break;
    case 'percent': {
      const keep = BASIS_POINTS - clampBps(pricing.percentBps);
      total = roundedToTaka(regularPoisha * keep, BASIS_POINTS);
      break;
    }
    case 'amount':
      total = sub(regularPoisha, max0(pricing.priceValuePoisha));
      break;
    case 'auto':
      total = regularPoisha;
  }
  return max0(min(total, regularPoisha));
}

/** The ladder, cleaned: rungs of one piece or more, ascending (the old `tierPriceFor`'s view). */
export function sortedTiers(tiers: readonly LandingTier[]): LandingTier[] {
  return tiers
    .filter((tier) => Number.isSafeInteger(tier.quantity) && tier.quantity >= 1)
    .map((tier) => ({ quantity: tier.quantity, pricePoisha: max0(tier.pricePoisha) }))
    .sort((a, b) => a.quantity - b.quantity);
}

/**
 * A collection's price for a total quantity: the highest rung at or below it (a gap floors to
 * the rung beneath), or null below the smallest rung.
 */
export function tierPriceFor(tiers: readonly LandingTier[], qty: number): Poisha | null {
  if (qty <= 0) return null;
  let match: LandingTier | null = null;
  for (const tier of sortedTiers(tiers)) {
    if (tier.quantity <= qty) match = tier;
    else break;
  }
  return match === null ? null : match.pricePoisha;
}

/** The most pieces the ladder prices: a collection order's ceiling. */
export function maxTierQuantity(tiers: readonly LandingTier[]): number {
  return sortedTiers(tiers).reduce((most, tier) => Math.max(most, tier.quantity), 0);
}

/** The fewest pieces the ladder prices: a collection order's floor. */
export function minTierQuantity(tiers: readonly LandingTier[]): number {
  const sorted = sortedTiers(tiers);
  return sorted[0]?.quantity ?? 0;
}

function meetsThreshold(rule: LandingDiscountRule, goods: Poisha, qty: number): boolean {
  if (rule.basis === 'quantity') return rule.thresholdQty > 0 && qty >= rule.thresholdQty;
  return rule.thresholdPoisha > 0n && goods >= rule.thresholdPoisha;
}

/** What one rule takes off the goods: capped for a percentage, never more than the goods. */
export function discountRuleAmount(rule: LandingDiscountRule, goods: Poisha): Poisha {
  let amount: Poisha;
  if (rule.rewardType === 'percent') {
    amount = roundedToTaka(goods * clampBps(rule.percentBps), BASIS_POINTS);
    if (rule.maxDiscountPoisha > 0n) amount = min(amount, rule.maxDiscountPoisha);
  } else {
    amount = max0(rule.valuePoisha);
  }
  return max0(min(amount, goods));
}

/** Free delivery once any switched-on threshold is met. */
export function qualifiesFreeShipping(
  freeShipping: LandingPromotions['freeShipping'],
  goods: Poisha,
  qty: number,
): boolean {
  if (!freeShipping.enabled) return false;
  if (freeShipping.minSubtotalPoisha > 0n && goods >= freeShipping.minSubtotalPoisha) return true;
  if (freeShipping.minQuantity > 0 && qty >= freeShipping.minQuantity) return true;
  return false;
}

export interface AppliedPromotions {
  readonly promoDiscountPoisha: Poisha;
  readonly promoLabel: string;
  readonly freeShipping: boolean;
  readonly deliveryPoisha: Poisha;
}

/**
 * The page's promotions on one order (the old `applyPromotions`): the single best rule for
 * the shopper (the first of equals), and free delivery, which stacks with it.
 */
export function applyPromotions(input: {
  readonly goodsPoisha: Poisha;
  readonly qty: number;
  readonly deliveryPoisha: Poisha;
  readonly promotions: LandingPromotions;
}): AppliedPromotions {
  let best: { amount: Poisha; rule: LandingDiscountRule | null } = { amount: ZERO, rule: null };
  for (const rule of input.promotions.discountRules) {
    if (!meetsThreshold(rule, input.goodsPoisha, input.qty)) continue;
    const amount = discountRuleAmount(rule, input.goodsPoisha);
    if (amount > best.amount) best = { amount, rule };
  }
  const free = qualifiesFreeShipping(input.promotions.freeShipping, input.goodsPoisha, input.qty);
  return {
    promoDiscountPoisha: best.amount,
    promoLabel: best.rule === null ? '' : best.rule.label,
    freeShipping: free,
    deliveryPoisha: free ? ZERO : max0(input.deliveryPoisha),
  };
}

/**
 * What the page charges for delivery to an address, before its promotions.
 *
 * `free` and `flat` deliver everywhere at one rate. `zones` charges the page's own three
 * rates by the address's website zone (with `askZone` off, the inside-Dhaka rate everywhere).
 * `settings` is the website's own rule for the address — its zone fee, free when the website's
 * free shipping applies to these goods — and, like the website, does not deliver where the
 * website does not.
 */
export function landingDeliveryFee(input: {
  readonly shipping: LandingShipping;
  readonly websiteRule: ShippingRule;
  readonly zone: WebZone | null | undefined;
  readonly goodsPoisha: Poisha;
}): { readonly feePoisha: Poisha; readonly deliverable: boolean | null } {
  const { shipping, websiteRule, zone } = input;
  switch (shipping.mode) {
    case 'free':
      return { feePoisha: ZERO, deliverable: true };
    case 'flat':
      return { feePoisha: max0(shipping.flatPoisha), deliverable: true };
    case 'zones':
      if (!shipping.askZone) {
        return { feePoisha: max0(shipping.zonesPoisha.inside_dhaka), deliverable: true };
      }
      if (zone === undefined) return { feePoisha: ZERO, deliverable: null };
      if (zone === null) return { feePoisha: ZERO, deliverable: false };
      return { feePoisha: max0(shipping.zonesPoisha[zone]), deliverable: true };
    case 'settings': {
      if (zone === undefined) return { feePoisha: ZERO, deliverable: null };
      if (zone === null) return { feePoisha: ZERO, deliverable: false };
      if (shipsFree(websiteRule, input.goodsPoisha)) return { feePoisha: ZERO, deliverable: true };
      const charged = shipping.askZone ? zone : 'inside_dhaka';
      return { feePoisha: max0(websiteRule.zones[charged].feePoisha), deliverable: true };
    }
  }
}

/** The SKUs a product may sell at, honouring a pinned one. */
function candidates(
  skusByProduct: ReadonlyMap<string, readonly LandingSku[]>,
  productId: string,
  pinned: string | null,
): LandingSku[] {
  const all = (skusByProduct.get(productId) ?? []).filter((sku) => sku.sellable);
  return pinned === null ? all : all.filter((sku) => sku.id === pinned);
}

interface Resolved {
  readonly lines: Map<string, { sku: LandingSku; qty: number }>;
  readonly pieces: number;
}

function addLine(resolved: Resolved['lines'], sku: LandingSku, qty: number): void {
  const existing = resolved.get(sku.id);
  if (existing === undefined) resolved.set(sku.id, { sku, qty });
  else existing.qty += qty;
}

/** A fixed offer's lines: each at its own quantity, a pinned size or the shopper's. */
function resolveFixed(
  offer: LandingOffer,
  lineSkus: readonly (string | null)[],
  skusByProduct: ReadonlyMap<string, readonly LandingSku[]>,
): Resolved | LandingRefusal {
  const lines = new Map<string, { sku: LandingSku; qty: number }>();
  let pieces = 0;
  for (const [index, item] of offer.items.entries()) {
    const quantity = Math.max(1, Math.trunc(item.quantity));
    const options = candidates(skusByProduct, item.productId, item.skuId);
    let chosen: LandingSku | undefined;
    if (item.skuId !== null) {
      chosen = options[0];
    } else {
      const wanted = lineSkus[index] ?? null;
      if (wanted !== null) {
        chosen = options.find((sku) => sku.id === wanted);
        if (chosen === undefined) return { code: 'size_unavailable', productId: item.productId };
      } else if (options.length === 1) {
        // One size: nothing to choose (the old site's single-variant rule).
        chosen = options[0];
      } else if (options.length === 0) {
        return { code: 'size_unavailable', productId: item.productId };
      } else {
        return { code: 'choose_size', productId: item.productId };
      }
    }
    if (chosen === undefined) return { code: 'size_unavailable', productId: item.productId };
    addLine(lines, chosen, quantity);
    pieces += quantity;
  }
  return { lines, pieces };
}

/** A pool's picks: each must be a sellable size of a pooled product (its pinned size if any). */
function resolvePool(
  offer: LandingOffer,
  selections: readonly { readonly skuId: string; readonly qty: number }[],
  skusByProduct: ReadonlyMap<string, readonly LandingSku[]>,
): Resolved | LandingRefusal {
  const lines = new Map<string, { sku: LandingSku; qty: number }>();
  let pieces = 0;
  for (const selection of selections) {
    const qty = Math.max(1, Math.trunc(selection.qty));
    // The pooled product the size belongs to, sellable or not.
    const owner = offer.items.find((item) =>
      (skusByProduct.get(item.productId) ?? []).some((sku) => sku.id === selection.skuId),
    );
    if (owner === undefined) return { code: 'not_in_offer', skuId: selection.skuId };
    const found = candidates(skusByProduct, owner.productId, owner.skuId).find(
      (sku) => sku.id === selection.skuId,
    );
    if (found === undefined) return { code: 'size_unavailable', productId: owner.productId };
    addLine(lines, found, qty);
    pieces += qty;
  }
  if (pieces === 0) return { code: 'nothing_chosen' };
  return { lines, pieces };
}

function isRefusal(value: Resolved | LandingRefusal): value is LandingRefusal {
  return 'code' in value;
}

/**
 * Price one landing-page order from the page alone (D-550). Refuses with the old site's
 * reasons — the offer gone, a size not chosen or not sold, a pick outside the offer, too few
 * or too many pieces, a line the website cannot fill — rather than guessing.
 */
export function priceLandingOrder(input: LandingPricingInput): LandingPricing {
  const { offer } = input;
  if (!offer.isActive) return { ok: false, refusal: { code: 'offer_unavailable' } };
  if (offer.items.length === 0) return { ok: false, refusal: { code: 'offer_empty' } };
  if (offer.kind === 'collection' && sortedTiers(offer.tiers).length === 0) {
    return { ok: false, refusal: { code: 'no_pricing' } };
  }

  let resolved: Resolved | LandingRefusal;
  if (offer.kind === 'fixed') {
    resolved = resolveFixed(
      offer,
      input.choice.kind === 'fixed' ? input.choice.lineSkus : [],
      input.skusByProduct,
    );
  } else {
    if (input.choice.kind !== 'pool' || input.choice.selections.length === 0) {
      return { ok: false, refusal: { code: 'nothing_chosen' } };
    }
    resolved = resolvePool(offer, input.choice.selections, input.skusByProduct);
  }
  if (isRefusal(resolved)) return { ok: false, refusal: resolved };
  const { lines, pieces } = resolved;

  // Piece limits: the ladder's for a collection, the offer's own for à la carte, and the
  // order's ceiling for everything.
  if (offer.kind === 'collection') {
    const floor = minTierQuantity(offer.tiers);
    const ceiling = maxTierQuantity(offer.tiers);
    if (pieces < floor) return { ok: false, refusal: { code: 'too_few', min: floor } };
    if (pieces > ceiling) return { ok: false, refusal: { code: 'too_many', max: ceiling } };
  } else if (offer.kind === 'alacarte') {
    const floor = Math.max(1, Math.trunc(offer.minQty));
    const ceiling = Math.trunc(offer.maxQty);
    if (pieces < floor) return { ok: false, refusal: { code: 'too_few', min: floor } };
    if (ceiling > 0 && pieces > ceiling) {
      return { ok: false, refusal: { code: 'too_many', max: ceiling } };
    }
  }
  if (pieces > LANDING_MAX_PIECES) {
    return { ok: false, refusal: { code: 'too_many', max: LANDING_MAX_PIECES } };
  }

  // Stock, against the folded quantity: two picks of one size cannot pass two checks of one.
  for (const { sku, qty } of lines.values()) {
    if (sku.availableQty < qty) {
      return {
        ok: false,
        refusal: {
          code: 'out_of_stock',
          skuId: sku.id,
          qty,
          availableQty: Math.max(0, sku.availableQty),
        },
      };
    }
  }

  const orderLines: LandingOrderLine[] = [...lines.values()].map(({ sku, qty }) => ({
    skuId: sku.id,
    qty,
    unitPricePoisha: sku.pricePoisha,
  }));
  const regular = sum(orderLines.map((line) => mulQty(line.unitPricePoisha, line.qty)));

  let offerTotal: Poisha;
  if (offer.kind === 'collection') {
    const rung = tierPriceFor(offer.tiers, pieces);
    if (rung === null) return { ok: false, refusal: { code: 'no_tier_price', qty: pieces } };
    offerTotal = max0(min(rung, regular));
  } else {
    offerTotal = applyOfferPricing(offer, regular);
  }

  const delivery = landingDeliveryFee({
    shipping: input.shipping,
    websiteRule: input.websiteRule,
    zone: input.zone,
    goodsPoisha: offerTotal,
  });
  const promo = applyPromotions({
    goodsPoisha: offerTotal,
    qty: pieces,
    deliveryPoisha: delivery.feePoisha,
    promotions: input.promotions,
  });
  const promoDiscount = min(promo.promoDiscountPoisha, offerTotal);
  const offerDiscount = sub(regular, offerTotal);
  const deliveryPoisha = delivery.deliverable === false ? ZERO : promo.deliveryPoisha;
  const total = max0(add(sub(offerTotal, promoDiscount), deliveryPoisha));

  return {
    ok: true,
    lines: orderLines,
    pieces,
    regularPoisha: regular,
    offerPoisha: offerTotal,
    offerDiscountPoisha: offerDiscount,
    promoDiscountPoisha: promoDiscount,
    promoLabel: promoDiscount > 0n ? promo.promoLabel : '',
    freeShipping: promo.freeShipping,
    baseDeliveryPoisha: delivery.feePoisha,
    deliveryPoisha,
    deliverable: delivery.deliverable,
    discountPoisha: add(offerDiscount, promoDiscount),
    totalPoisha: total,
  };
}

/** What a landing offer shows before anything is chosen: a headline price and a saving. */
export interface LandingOfferHeadline {
  readonly pricePoisha: Poisha;
  readonly compareAtPoisha: Poisha | null;
  readonly savingsPoisha: Poisha;
}

/**
 * An offer's headline for the public page, or null when it cannot be bought now (the old
 * `publicOffers`): a fixed offer at its first sizes that hold its quantities; a collection at
 * its cheapest rung; à la carte at its minimum pieces of its cheapest size.
 */
export function landingOfferHeadline(
  offer: LandingOffer,
  skusByProduct: ReadonlyMap<string, readonly LandingSku[]>,
): LandingOfferHeadline | null {
  if (!offer.isActive || offer.items.length === 0) return null;
  const compareAt = offer.compareAtPoisha > 0n ? offer.compareAtPoisha : null;
  if (offer.kind === 'fixed') {
    let regular = ZERO;
    for (const item of offer.items) {
      const quantity = Math.max(1, Math.trunc(item.quantity));
      const first = candidates(skusByProduct, item.productId, item.skuId).find(
        (sku) => sku.availableQty >= quantity,
      );
      if (first === undefined) return null;
      regular = add(regular, mulQty(first.pricePoisha, quantity));
    }
    const price = applyOfferPricing(offer, regular);
    return {
      pricePoisha: price,
      compareAtPoisha: compareAt ?? regular,
      savingsPoisha: sub(regular, price),
    };
  }
  const pooled = offer.items.flatMap((item) =>
    candidates(skusByProduct, item.productId, item.skuId).filter((sku) => sku.availableQty >= 1),
  );
  if (pooled.length === 0) return null;
  if (offer.kind === 'collection') {
    const first = sortedTiers(offer.tiers)[0];
    if (first === undefined) return null;
    return { pricePoisha: first.pricePoisha, compareAtPoisha: compareAt, savingsPoisha: ZERO };
  }
  const cheapest = pooled.reduce(
    (low, sku) => (sku.pricePoisha < low ? sku.pricePoisha : low),
    pooled[0]?.pricePoisha ?? ZERO,
  );
  const minimum = Math.max(1, Math.trunc(offer.minQty));
  const regular = mulQty(cheapest, minimum);
  const price = applyOfferPricing(offer, regular);
  return { pricePoisha: price, compareAtPoisha: compareAt, savingsPoisha: sub(regular, price) };
}

// --- page codes -----------------------------------------------------------------------------

/** Read aloud and typed from a flyer: no 0/o, 1/l/i. */
export const LANDING_CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export const LANDING_CODE_LENGTH = 6;
/** Paths under `/lp/` that are not pages. */
export const RESERVED_LANDING_CODES: ReadonlySet<string> = new Set([
  'new',
  'edit',
  'api',
  'admin',
  'preview',
]);
const LANDING_CODE_SHAPE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

/** A random code from random bytes (the server's `crypto.randomBytes`). */
export function landingCodeFrom(bytes: Uint8Array, length = LANDING_CODE_LENGTH): string {
  let out = '';
  for (let index = 0; index < length; index += 1) {
    out += LANDING_CODE_ALPHABET[(bytes[index] ?? 0) % LANDING_CODE_ALPHABET.length] ?? 'a';
  }
  return out;
}

/** A hand-typed code, made URL-safe and short (the old `normalizeCode`). */
export function normaliseLandingCode(raw: string): string {
  return raw
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)
    .replace(/-$/, '');
}

/** Whether a code may name a page: the right shape and not a reserved path. */
export function isLandingCode(code: string): boolean {
  return LANDING_CODE_SHAPE.test(code) && !RESERVED_LANDING_CODES.has(code);
}

// --- campaign links -------------------------------------------------------------------------

/** A campaign link's five-digit code, from a random integer (the old `generateUniqueCode`). */
export function campaignLinkCodeFrom(random: number): string {
  const value = 10_000 + (Math.abs(Math.trunc(random)) % 90_000);
  return String(value);
}

export const CAMPAIGN_LINK_CODE = /^\d{5}$/;

/**
 * A campaign's address on the website without its `?cu=` (the old `buildBasePath`): the
 * category's shop page, the shop, or the custom path.
 */
export function campaignBasePath(input: {
  readonly baseType: 'category' | 'shop' | 'custom';
  readonly categorySlug: string | null;
  readonly customPath: string | null;
}): string {
  if (input.baseType === 'category' && input.categorySlug !== null && input.categorySlug !== '') {
    return `/shop?category=${encodeURIComponent(input.categorySlug)}`;
  }
  if (input.baseType === 'custom' && input.customPath !== null && input.customPath !== '') {
    return input.customPath.startsWith('/') ? input.customPath : `/${input.customPath}`;
  }
  return '/shop';
}

/** The shareable address: the base path with `cu=<code>` joined correctly. */
export function campaignFullPath(basePath: string, code: string): string {
  return `${basePath}${basePath.includes('?') ? '&' : '?'}cu=${code}`;
}
