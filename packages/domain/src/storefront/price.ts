import { poisha, takaParts, type Poisha } from '../money/index.js';

/**
 * The price a shopper sees (M33; M35 flash offers; M39b regular prices, D-640).
 *
 * The SKU's shelf price is the catalog's `price_poisha`. A live flash offer below it is what
 * the shopper pays; a regular ("was") price the brand set on the variant, `compare_at_poisha`,
 * is only ever shown struck through, never charged.
 *
 * What is struck through:
 *
 * - with a flash price, the higher of the shelf price and the regular price (a ৳1,890
 *   regular, ৳1,490 shelf, ৳1,190 flash reads "৳1,190, was ৳1,890");
 * - without one, the regular price when it is above the shelf price (the catalog refuses
 *   any other, `skus_compare_at_above_price`);
 * - otherwise nothing: the website never draws a strike-through the ERP cannot justify.
 */

export interface FlashOffer {
  readonly skuId: string;
  readonly pricePoisha: Poisha;
}

export interface StorefrontPrice {
  readonly pricePoisha: Poisha;
  /** The struck-through figure, or null when nothing is on offer and no regular price is set. */
  readonly compareAtPoisha: Poisha | null;
}

export function storefrontPrice(
  sku: {
    readonly id: string;
    readonly pricePoisha: Poisha;
    readonly compareAtPoisha?: Poisha | null;
  },
  offers: readonly FlashOffer[] = [],
): StorefrontPrice {
  let best: Poisha | null = null;
  for (const offer of offers) {
    if (offer.skuId !== sku.id) continue;
    if (offer.pricePoisha <= 0n || offer.pricePoisha >= sku.pricePoisha) continue;
    if (best === null || offer.pricePoisha < best) best = offer.pricePoisha;
  }
  const regular =
    sku.compareAtPoisha !== undefined &&
    sku.compareAtPoisha !== null &&
    sku.compareAtPoisha > sku.pricePoisha
      ? sku.compareAtPoisha
      : null;
  if (best !== null) {
    return { pricePoisha: best, compareAtPoisha: regular ?? sku.pricePoisha };
  }
  return { pricePoisha: sku.pricePoisha, compareAtPoisha: regular };
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
