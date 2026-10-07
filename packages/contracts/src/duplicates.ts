import { z } from 'zod';

/**
 * Duplicating products, one or many, several copies each (D-662, D-663).
 *
 * Shared by the server's `POST /v1/catalog/products/:id/duplicate` and
 * `POST /v1/catalog/products/duplicate` and the console's duplicate dialogs, so a dialog
 * never offers a number the server refuses.
 *
 * Every copy is made in one transaction that holds the brand's SKU counter until it commits
 * (that is what keeps the numbers consecutive), so another product being created in the brand
 * waits for it. `total` keeps that wait short: 200 copies is a few seconds.
 */
export const DUPLICATE_LIMITS = {
  /** Copies of each product. */
  copies: { min: 1, max: 50 },
  /** Products in one bulk duplicate, as the list's other bulk actions. */
  products: 100,
  /** New products in one request: products × copies. */
  total: 200,
} as const;

const copiesRange = `Make ${String(DUPLICATE_LIMITS.copies.min)} to ${String(DUPLICATE_LIMITS.copies.max)} copies.`;

/** How many copies of each product: a whole number from 1 to 50. */
export const duplicateCopiesSchema = z
  .number({ error: 'Type how many copies to make.' })
  .int('Copies are a whole number.')
  .min(DUPLICATE_LIMITS.copies.min, copiesRange)
  .max(DUPLICATE_LIMITS.copies.max, copiesRange);

/** The message both sides give when products × copies is over `DUPLICATE_LIMITS.total`. */
export const DUPLICATE_TOO_MANY = `Make at most ${String(DUPLICATE_LIMITS.total)} new products at a time: fewer copies, or fewer products.`;
