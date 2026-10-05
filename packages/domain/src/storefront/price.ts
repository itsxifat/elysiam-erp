import { poisha, takaParts, type Poisha } from '../money/index.js';

/**
 * The price a shopper sees (M33; M35 adds flash offers).
 *
 * Today it is the SKU's shelf price, the catalog's `price_poisha`. M35 passes the live
 * flash offers and this returns the lower of the two with the shelf price as the "was"
 * figure; until then `compareAtPoisha` is always null, so the website never draws a
 * strike-through it cannot justify.
 */

export interface FlashOffer {
  readonly skuId: string;
  readonly pricePoisha: Poisha;
}

export interface StorefrontPrice {
  readonly pricePoisha: Poisha;
  /** The shelf price, when an offer undercuts it. Null when nothing is on offer. */
  readonly compareAtPoisha: Poisha | null;
}

export function storefrontPrice(
  sku: { readonly id: string; readonly pricePoisha: Poisha },
  offers: readonly FlashOffer[] = [],
): StorefrontPrice {
  let best: Poisha | null = null;
  for (const offer of offers) {
    if (offer.skuId !== sku.id) continue;
    if (offer.pricePoisha <= 0n || offer.pricePoisha >= sku.pricePoisha) continue;
    if (best === null || offer.pricePoisha < best) best = offer.pricePoisha;
  }
  return best === null
    ? { pricePoisha: sku.pricePoisha, compareAtPoisha: null }
    : { pricePoisha: best, compareAtPoisha: sku.pricePoisha };
}

/**
 * An amount as a plain taka decimal string, `"1250.00"`: the display convenience the
 * storefront API sends beside every poisha figure (D-506).
 *
 * Not formatted (no grouping, no currency mark): the website formats for its own locale.
 * Built from the integer parts, never by dividing a float (invariant 1).
 */
export function takaDecimal(amount: Poisha): string {
  const { negative, taka, poisha: rest } = takaParts(amount);
  return `${negative ? '-' : ''}${taka.toString()}.${rest.toString().padStart(2, '0')}`;
}

/** A money pair as the storefront API sends it: integer poisha and taka, both strings. */
export interface WireMoney {
  readonly poisha: string;
  readonly taka: string;
}

export function wireMoney(amount: Poisha | bigint | string): WireMoney {
  const value = poisha(amount);
  return { poisha: value.toString(), taka: takaDecimal(value) };
}
