/**
 * The showroom POS's pure rules (architecture §14, M23; invariant 11).
 *
 * Exported as the `@elysium/domain/pos` subpath rather than through the root
 * barrel, like `courier`, `payroll` and `investors`: the names here (`Tender`,
 * `HoldReason`, `priceLines`) are POS vocabulary and would crowd the root.
 */
export * from './canonical.js';
export * from './cart.js';
export * from './discount-policy.js';
export * from './errors.js';
export * from './holds.js';
export * from './returns.js';
export * from './shift.js';
