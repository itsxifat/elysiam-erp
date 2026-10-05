import { z } from 'zod';

/**
 * What the inventory endpoints accept (architecture §23; validate at the edge).
 *
 * Two shapes are deliberately absent, and their absence is the design:
 *
 * * **No unit cost on any request here.** Purchase cost enters through M09's supply
 *   entries (invariant 5), and stock leaving is valued at the weighted average the
 *   server holds. An `unitCostPoisha` on an adjustment request would let somebody
 *   write off a lakh of stock at a claimed value of one taka and stay under every
 *   approval threshold (D-072).
 * * **No `qtyDelta` on any request here.** Quantities are positive magnitudes and the
 *   direction comes from the endpoint. A signed quantity lets "write off 5" become
 *   "create 5" with one keystroke, and the database CHECK that catches it would
 *   report it as a server error rather than as a rejected request.
 */

export const stockIdSchema = z.string().uuid('That is not a valid id.');

const qtySchema = z
  .number()
  .int('Quantities are whole units.')
  .positive('A quantity must be positive.')
  .max(1_000_000, 'That quantity is larger than any real stock movement.');

export const createLocationSchema = z
  .object({
    code: z
      .string()
      .regex(
        /^[A-Z0-9][A-Z0-9-]{0,15}$/,
        'A location code is upper-case letters, digits and dashes.',
      ),
    name: z.string().trim().min(1).max(120),
    kind: z.enum(['warehouse', 'showroom', 'damaged', 'in_transit']),
    /**
     * Required for a showroom and refused for the rest, checked in the service
     * where the branch can be looked up. §8 gives an org one location per branch
     * plus the `damaged` and `in_transit` ones, which are org-level.
     */
    branchId: stockIdSchema.optional(),
  })
  .strict();

export const updateLocationSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    isActive: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Nothing to change.');

export const stockQuerySchema = z
  .object({
    locationId: stockIdSchema.optional(),
    /** Matches a SKU code or a product name. */
    q: z.string().trim().min(1).max(80).optional(),
    /** One product's SKUs: the product page's stock grid (D-427). */
    productId: stockIdSchema.optional(),
    /** A category and everything under it. */
    categoryId: stockIdSchema.optional(),
    low: z.coerce.boolean().optional(),
    page: z.coerce.number().int().min(1).max(10_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();

export const movementQuerySchema = z
  .object({
    skuId: stockIdSchema.optional(),
    /** Every SKU of one product: the product page's stock history (D-427). */
    productId: stockIdSchema.optional(),
    locationId: stockIdSchema.optional(),
    from: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    to: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    page: z.coerce.number().int().min(1).max(10_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();

export const setReorderLevelSchema = z
  .object({
    skuId: stockIdSchema,
    locationId: stockIdSchema,
    reorderLevel: z.number().int().min(0).max(1_000_000),
  })
  .strict();

export const requestAdjustmentSchema = z
  .object({
    locationId: stockIdSchema,
    direction: z.enum(['loss', 'gain']),
    reason: z.string().trim().min(1, 'An adjustment needs a reason.').max(500),
    countSessionId: stockIdSchema.optional(),
    lines: z
      .array(z.object({ skuId: stockIdSchema, qty: qtySchema }).strict())
      .min(1, 'An adjustment needs at least one line.')
      .max(500),
  })
  .strict();

export const dispatchTransferSchema = z
  .object({
    fromLocationId: stockIdSchema,
    toLocationId: stockIdSchema,
    memo: z.string().trim().max(500).optional(),
    lines: z
      .array(z.object({ skuId: stockIdSchema, qty: qtySchema }).strict())
      .min(1, 'A transfer needs at least one line.')
      .max(500),
  })
  .strict()
  .refine(
    (value) => value.fromLocationId !== value.toLocationId,
    'A transfer needs two different locations.',
  );

export const openCountSchema = z
  .object({ locationId: stockIdSchema, memo: z.string().trim().max(500).optional() })
  .strict();

export const recordCountsSchema = z
  .object({
    lines: z
      .array(
        z
          .object({
            skuId: stockIdSchema,
            /**
             * Zero is valid and important: an empty shelf is a count, and refusing
             * it would make "we found none" indistinguishable from "we did not look",
             * which is the difference the variance depends on.
             */
            countedQty: z.number().int().min(0).max(1_000_000),
          })
          .strict(),
      )
      .min(1)
      .max(500),
    /**
     * Why a figure was typed rather than scanned (M38a, D-606): a manual correction of a
     * scanned count carries a note, which the audit entry keeps.
     */
    note: z.string().trim().max(500).optional(),
  })
  .strict();

export const reconcileQuerySchema = z
  .object({ limit: z.coerce.number().int().min(1).max(50).default(14) })
  .strict();

export type CreateLocationInput = z.infer<typeof createLocationSchema>;
export type UpdateLocationInput = z.infer<typeof updateLocationSchema>;
export type StockQuery = z.infer<typeof stockQuerySchema>;
export type MovementQuery = z.infer<typeof movementQuerySchema>;
export type SetReorderLevelInput = z.infer<typeof setReorderLevelSchema>;
export type RequestAdjustmentInput = z.infer<typeof requestAdjustmentSchema>;
export type DispatchTransferInput = z.infer<typeof dispatchTransferSchema>;
export type OpenCountInput = z.infer<typeof openCountSchema>;
export type RecordCountsInput = z.infer<typeof recordCountsSchema>;
