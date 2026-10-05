/**
 * The brand's website, run from its ERP (M33, architecture §31): which stock the website may
 * sell, the price a shopper sees, old addresses, the shipping rule, the product list's
 * parameters, and the content rules (tags, links, size charts, the category tree, the menu).
 *
 * Pure functions only. The tables are the server's `storefront` module and the catalog's;
 * the signed API that serves these rules to the website is `/storefront/v1`.
 */
export * from './availability.js';
export * from './content.js';
export * from './price.js';
export * from './query.js';
export * from './shipping.js';
export * from './slugs.js';
