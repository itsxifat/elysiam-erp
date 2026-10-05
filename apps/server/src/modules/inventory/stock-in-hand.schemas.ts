import { z } from 'zod';

import { stockIdSchema } from './inventory.schemas.js';

/**
 * What the stock-in-hand, window, scan and lookup routes accept (M38a, D-602, D-605,
 * D-606).
 *
 * `inventory.schemas.ts` says no request in this module carries a unit cost, and stock in
 * hand is the one deliberate exception (D-602): stock the brand already holds came from no
 * supplier the books know, so its cost is typed here, by a role holding `read:cost`, and
 * nowhere else. The split mirrors supply's (D-005): the draft schemas have no cost field at
 * all, and are strict, so a warehouse role cannot send one even by hand; the posting
 * schemas require a positive cost on every line.
 */

const qtySchema = z
  .number()
  .int('Quantities are whole pieces.')
  .positive('A quantity must be positive.')
  .max(1_000_000, 'That quantity is larger than any real stock.');

/** Integer poisha as a decimal string, above zero: a piece that cost nothing is not stock in hand. */
const costSchema = z
  .string()
  .regex(/^\d{1,16}$/, 'A cost is integer poisha, sent as a decimal string.')
  .refine((value) => BigInt(value) > 0n, 'Each piece needs a cost above zero.')
  .refine((value) => BigInt(value) <= 9_000_000_000_000_000n, 'That cost is out of range.');

const memoSchema = z.string().trim().max(500);

function uniqueSkus(lines: readonly { skuId: string }[]): boolean {
  return new Set(lines.map((line) => line.skuId)).size === lines.length;
}

const draftLines = z
  .array(z.object({ skuId: stockIdSchema, qty: qtySchema }).strict())
  .min(1, 'Count at least one piece.')
  .max(500, 'At most 500 lines in one entry.')
  .refine(uniqueSkus, 'Each SKU appears once in an entry; add the pieces together.');

const pricedLines = z
  .array(z.object({ skuId: stockIdSchema, qty: qtySchema, unitCostPoisha: costSchema }).strict())
  .min(1, 'Count at least one piece.')
  .max(500, 'At most 500 lines in one entry.')
  .refine(uniqueSkus, 'Each SKU appears once in an entry; add the pieces together.');

/** A quantity-only draft (warehouse). `entryId` is the client's key, kept across retries. */
export const stockInHandDraftSchema = z
  .object({
    entryId: stockIdSchema,
    locationId: stockIdSchema,
    memo: memoSchema.optional(),
    lines: draftLines,
  })
  .strict();

export const updateStockInHandDraftSchema = z
  .object({
    locationId: stockIdSchema.optional(),
    memo: memoSchema.nullable().optional(),
    lines: draftLines.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Nothing to change.');

/** Enter and post in one call, with a cost per piece on every line (`read:cost`). */
export const createStockInHandSchema = z
  .object({
    entryId: stockIdSchema,
    locationId: stockIdSchema,
    memo: memoSchema.optional(),
    lines: pricedLines,
  })
  .strict();

/**
 * Price a draft and post it. Every line of the draft is priced, and only those, and the
 * request repeats the location and the pieces the person posting it read: a draft changed
 * since (another phone, the warehouse) is refused with `STOCK_IN_HAND_CHANGED`, so equity is
 * never credited for pieces nobody who could see the cost looked at.
 */
export const postStockInHandSchema = z
  .object({
    locationId: stockIdSchema,
    lines: pricedLines,
  })
  .strict();

/** Ask to take a posted entry back out: a reason, which the checker reads. */
export const reverseStockInHandSchema = z
  .object({ reason: z.string().trim().min(3, 'Say why it is being reversed.').max(500) })
  .strict();

export const stockInHandListSchema = z
  .object({ status: z.enum(['draft', 'posted', 'reversed']).optional() })
  .strict();

/** Closing the window: an optional word on why now. */
export const closeWindowSchema = z.object({ note: memoSchema.optional() }).strict();

/** Asking to reopen it: a reason, which the checker reads. */
export const reopenWindowSchema = z
  .object({ reason: z.string().trim().min(3, 'Say why it needs reopening.').max(500) })
  .strict();

/** One scan on an open count: the device's key for the scan, and what it read. */
export const countScanSchema = z
  .object({
    scanId: stockIdSchema,
    code: z.string().trim().min(1).max(64),
  })
  .strict();

/** `GET /v1/catalog/lookup?code=`: a barcode or a SKU code. */
export const lookupQuerySchema = z
  .object({ code: z.string().trim().min(1, 'Scan or type a code.').max(64) })
  .strict();

export type StockInHandDraftInput = z.infer<typeof stockInHandDraftSchema>;
export type UpdateStockInHandDraftInput = z.infer<typeof updateStockInHandDraftSchema>;
export type CreateStockInHandInput = z.infer<typeof createStockInHandSchema>;
export type PostStockInHandInput = z.infer<typeof postStockInHandSchema>;
export type ReverseStockInHandInput = z.infer<typeof reverseStockInHandSchema>;
export type StockInHandListQuery = z.infer<typeof stockInHandListSchema>;
export type CloseWindowInput = z.infer<typeof closeWindowSchema>;
export type ReopenWindowInput = z.infer<typeof reopenWindowSchema>;
export type CountScanInput = z.infer<typeof countScanSchema>;
