/**
 * Marketing (architecture §11, M18; invariant 11).
 *
 * The `@elysium/domain/marketing` subpath, like `promo` and `crm`: attribution, §11's
 * metric definitions, what is sent to Meta, and lead segments.
 */
export * from './attribution.js';
export * from './metrics.js';
export * from './meta.js';
export * from './leads.js';
