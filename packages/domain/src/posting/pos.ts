/**
 * M23's showroom journals (§7): a sale at the till and a return to it.
 *
 * The aggregator for the `@elysium/domain/posting/pos` subpath, like
 * `./investors.js`. The posting barrel exports this file rather than the two
 * below individually, so the root barrel has one path to each name (TS2308).
 */
export * from './pos-sale.js';
export * from './pos-return.js';
