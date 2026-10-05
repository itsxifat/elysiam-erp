/**
 * Promotions (architecture §10; M16, M35a; invariant 11).
 *
 * The `@elysium/domain/promo` subpath, like `pos` and `courier`: `PromoCode`, `Discount` and
 * `FlashOffer` are promotions vocabulary and would crowd the root barrel.
 */
export * from './discounts.js';
export * from './validate.js';
export * from './basis.js';
export * from './flash.js';
export * from './legacy.js';
