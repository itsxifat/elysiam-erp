/**
 * Where a sale comes from (§9 order channels; M16 promo scope).
 *
 * Here rather than in the orders module because a second module has to speak the same
 * words: a promo code scoped to "Facebook orders" is compared against an order's
 * `channel`, and two lists that drifted apart would give a code that can never match.
 * That happened — M16's first cut invented `web` and `desk`, which no order ever carries.
 */
export const ORDER_CHANNELS = [
  'facebook',
  'whatsapp',
  'instagram',
  'tiktok',
  'landing_page',
  'website',
  'phone',
  'walk_in',
  'reseller',
  // M35b (D-556): orders the ncom.bd marketplace hands over. Never a lead's channel.
  'marketplace',
] as const;
export type OrderChannel = (typeof ORDER_CHANNELS)[number];

/**
 * Where a promo code may be used: any order channel, or the showroom till.
 *
 * `pos` is separate from `walk_in`. A walk-in *order* is taken at the desk for someone who
 * came in and is delivered later; a till sale is paid and carried out on the spot, never
 * becomes an order, and is what M23's `PROMO_CODES` port prices.
 */
export const PROMO_CHANNELS = [...ORDER_CHANNELS, 'pos'] as const;
export type PromoChannel = (typeof PROMO_CHANNELS)[number];
