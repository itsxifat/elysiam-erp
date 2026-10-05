import type { Poisha } from '../money/index.js';

/**
 * Flash sales: which offer prices a line (M35a, D-542; ported from the old site's
 * `lib/flash-pricing.js`).
 *
 * A flash sale offers some SKUs at a sale price for a while, each with a number of units or
 * "all stock". Several sales can run at once and offer the same SKU at different prices, so
 * a line needs a rule for which one it gets, and it is the old site's: **the cheapest live
 * offer below the shelf price, then the one ending soonest** (so its allocation is used
 * before it expires), then the sale with the higher priority, then the offer id, so the
 * answer never depends on the order rows arrived in.
 *
 * Pure (invariant 11). The server reads the offers and claims units with a conditional
 * UPDATE (`claimFlashUnits`); this only decides which offer a line should try for and what
 * the cart should show.
 */

export interface FlashOffer {
  readonly flashSaleItemId: string;
  readonly flashSaleId: string;
  readonly skuId: string;
  readonly salePricePoisha: Poisha;
  /** Units still claimable at the sale price; null when the sale offers all its stock. */
  readonly unitsLeft: number | null;
  readonly startsAt: Date | null;
  readonly endsAt: Date | null;
  /** The sale and this SKU's entry are both switched on. */
  readonly enabled: boolean;
  /** The sale's priority: higher wins a tie on price and end. */
  readonly priority: number;
}

export type FlashSaleStatus = 'draft' | 'scheduled' | 'live' | 'ended';

/** Switched off is a draft; otherwise where `now` falls in the window (both ends inclusive). */
export function flashSaleStatus(
  sale: {
    readonly enabled: boolean;
    readonly startsAt: Date | null;
    readonly endsAt: Date | null;
  },
  now: Date,
): FlashSaleStatus {
  if (!sale.enabled) return 'draft';
  if (sale.endsAt !== null && sale.endsAt < now) return 'ended';
  if (sale.startsAt !== null && sale.startsAt > now) return 'scheduled';
  return 'live';
}

export function isFlashOfferLive(offer: FlashOffer, now: Date): boolean {
  return flashSaleStatus(offer, now) === 'live';
}

function endTime(offer: FlashOffer): number {
  return offer.endsAt === null ? Number.POSITIVE_INFINITY : offer.endsAt.getTime();
}

function compareOffers(a: FlashOffer, b: FlashOffer): number {
  if (a.salePricePoisha !== b.salePricePoisha)
    return a.salePricePoisha < b.salePricePoisha ? -1 : 1;
  const ends = endTime(a) - endTime(b);
  // Infinity - Infinity is NaN, which would sort unpredictably: two open ends are a tie.
  if (!Number.isNaN(ends) && ends !== 0) return ends < 0 ? -1 : 1;
  if (a.priority !== b.priority) return b.priority - a.priority;
  return a.flashSaleItemId < b.flashSaleItemId ? -1 : a.flashSaleItemId > b.flashSaleItemId ? 1 : 0;
}

/**
 * The offers that can price a unit of this SKU, best first: live, with units left, and
 * genuinely below the shelf price. An offer at or above the shelf price is no offer.
 */
export function rankFlashOffers(
  shelfPricePoisha: Poisha,
  offers: readonly FlashOffer[],
  now: Date,
): FlashOffer[] {
  return offers
    .filter(
      (offer) =>
        isFlashOfferLive(offer, now) &&
        offer.salePricePoisha > 0n &&
        offer.salePricePoisha < shelfPricePoisha &&
        (offer.unitsLeft === null || offer.unitsLeft > 0),
    )
    .sort(compareOffers);
}

/**
 * The best offer that still covers `qty` units, or null for the shelf price.
 *
 * Whole lines only, as the old site did: a line of three with two units left at the sale
 * price is not split into two at the sale price and one at the shelf price; it takes the
 * next offer that covers all three, or the shelf price.
 */
export function bestFlashOffer(
  shelfPricePoisha: Poisha,
  offers: readonly FlashOffer[],
  now: Date,
  qty = 1,
): FlashOffer | null {
  return (
    rankFlashOffers(shelfPricePoisha, offers, now).find(
      (offer) => offer.unitsLeft === null || offer.unitsLeft >= qty,
    ) ?? null
  );
}

export interface FlashLine {
  readonly skuId: string;
  readonly qty: number;
  readonly shelfPricePoisha: Poisha;
}

export interface FlashLinePlan {
  /** The offer this line is priced by, or null for the shelf price. */
  readonly offer: FlashOffer | null;
  readonly unitPricePoisha: Poisha;
  /**
   * The best offer the line could have had with a smaller quantity and how many units it
   * has left, so a cart can say "only 2 left at this price". Null when there is none.
   */
  readonly best: { readonly offer: FlashOffer; readonly left: number } | null;
}

/**
 * A basket priced against the offers exactly the way checkout claims them: line by line,
 * whole lines only, each line using up allocation the next one sees (the old site's
 * `planFlashLines`). Checkout then claims the same choices atomically, so the cart shows what
 * the order charges unless somebody else takes the units in between, and then the claim is
 * refused rather than the buyer charged more than they were shown.
 */
export function planFlashLines(
  lines: readonly FlashLine[],
  offers: readonly FlashOffer[],
  now: Date,
): FlashLinePlan[] {
  const used = new Map<string, number>();
  return lines.map((line) => {
    const ranked = rankFlashOffers(
      line.shelfPricePoisha,
      offers.filter((offer) => offer.skuId === line.skuId),
      now,
    );
    let best: FlashLinePlan['best'] = null;
    for (const offer of ranked) {
      const taken = used.get(offer.flashSaleItemId) ?? 0;
      const left =
        offer.unitsLeft === null ? Number.POSITIVE_INFINITY : Math.max(0, offer.unitsLeft - taken);
      if (best === null && left > 0) best = { offer, left };
      if (line.qty > 0 && left >= line.qty) {
        used.set(offer.flashSaleItemId, taken + line.qty);
        return { offer, unitPricePoisha: offer.salePricePoisha, best: { offer, left } };
      }
    }
    return { offer: null, unitPricePoisha: line.shelfPricePoisha, best };
  });
}
