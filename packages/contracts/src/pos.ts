import { z } from 'zod';

import { positivePoishaSchema } from './ledger.js';

/**
 * What a showroom till sends (M23, architecture §14 and §23): one sale or return
 * document per sale or return, queued on the till and synced oldest first.
 *
 * Here rather than in the server so the till, its offline test double and the
 * server validate against one definition. A till that builds a document this
 * schema refuses would queue it, retry it forever and never post it — and the
 * customer would already have walked out with the goods — so the till's own
 * tests parse what it builds with these.
 *
 * Every amount is integer poisha as a decimal string: a crore of taka in poisha is
 * past `Number.MAX_SAFE_INTEGER`, and a till must never be the place `JSON.parse`
 * rounds one (invariant 1).
 */

/** A non-negative integer-poisha string that fits §7's ±9e15 bound. */
export const nonNegativePoishaSchema = z
  .string()
  .max(16, 'Amounts are integer poisha, sent as a decimal string.')
  .regex(/^(0|[1-9]\d*)$/, 'Amounts are non-negative integer poisha, sent as a decimal string.')
  .refine(
    (value) => !/^\d+$/.test(value) || BigInt(value) <= 9_000_000_000_000_000n,
    'That amount is out of range.',
  );

const uuid = z.string().uuid();

export const posTenderSchema = z.enum(['cash', 'bkash', 'card']);
export type PosTender = z.infer<typeof posTenderSchema>;

/** Printed on paper and typed back at the counter: capitals, digits and dashes. */
export const receiptNoSchema = z
  .string()
  .regex(/^[A-Z0-9][A-Z0-9-]{0,39}$/, 'Not a receipt number.');

const instantSchema = z.string().datetime({ offset: true });

export const saleDocumentSchema = z
  .object({
    kind: z.literal('sale'),
    /** The till's own id for the sale: the idempotency key's source (§14). */
    id: uuid,
    registerId: uuid,
    shiftId: uuid,
    receiptNo: receiptNoSchema,
    occurredAt: instantSchema,
    lines: z
      .array(
        z
          .object({
            lineNo: z.number().int().min(1).max(500),
            skuId: uuid,
            qty: z.number().int().min(1).max(9_999),
            unitPricePoisha: nonNegativePoishaSchema,
            discountPoisha: nonNegativePoishaSchema,
          })
          .strict(),
      )
      .min(1)
      .max(200),
    tenders: z
      .array(
        z
          .object({
            tender: posTenderSchema,
            amountPoisha: positivePoishaSchema,
            reference: z.string().trim().min(1).max(40).optional(),
          })
          .strict(),
      )
      .max(3),
    /** Cash the customer handed over; the change is derived, never sent. */
    cashReceivedPoisha: nonNegativePoishaSchema.optional(),
    /** What the till printed. Checked against the server's own pricing. */
    totals: z
      .object({
        grossPoisha: nonNegativePoishaSchema,
        discountPoisha: nonNegativePoishaSchema,
        netPoisha: nonNegativePoishaSchema,
      })
      .strict(),
    /** On an exchange's replacement sale: the return it pairs with. */
    exchangeReturnId: uuid.optional(),
  })
  .strict();
export type SaleDocument = z.infer<typeof saleDocumentSchema>;

export const returnDocumentSchema = z
  .object({
    kind: z.literal('return'),
    id: uuid,
    registerId: uuid,
    shiftId: uuid,
    saleId: uuid,
    /** The return slip's own number. */
    receiptNo: receiptNoSchema,
    occurredAt: instantSchema,
    reason: z.string().trim().max(200).optional(),
    lines: z
      .array(
        z
          .object({
            lineNo: z.number().int().min(1).max(500),
            saleLineNo: z.number().int().min(1).max(500),
            qty: z.number().int().min(1).max(9_999),
            refundPoisha: nonNegativePoishaSchema,
          })
          .strict(),
      )
      .min(1)
      .max(200),
    tenders: z
      .array(z.object({ tender: posTenderSchema, amountPoisha: positivePoishaSchema }).strict())
      .max(3),
    refundPoisha: nonNegativePoishaSchema,
  })
  .strict();
export type ReturnDocument = z.infer<typeof returnDocumentSchema>;

export const tillDocumentSchema = z.discriminatedUnion('kind', [
  saleDocumentSchema,
  returnDocumentSchema,
]);
export type TillDocument = z.infer<typeof tillDocumentSchema>;

/**
 * One sync: the till's queue, oldest first.
 *
 * Bounded at 50 so one request is one short transaction per document rather than
 * a batch that holds locks for seconds; a till with more queued sends several.
 * Order matters and is kept: an exchange's return precedes its replacement sale.
 */
export const posSyncSchema = z
  .object({
    documents: z.array(tillDocumentSchema).min(1).max(50),
  })
  .strict();
export type PosSyncInput = z.infer<typeof posSyncSchema>;
