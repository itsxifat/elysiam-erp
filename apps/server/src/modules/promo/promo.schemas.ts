import {
  businessDateSchema,
  nonNegativePoishaSchema,
  positivePoishaSchema,
} from '@elysium/contracts';
import { z } from 'zod';

/**
 * The promo module's wire shapes (architecture §23), validated at the edge.
 *
 * `discountPoisha` is absent from every request on purpose: a caller sends a code and a
 * basket, and the server decides what the code is worth. A field a client could set
 * would be the discount, whatever the rules said.
 */

const uuid = z.string().uuid();

/** As typed on a form; stored upper-case. The database's CHECK is the same shape. */
export const promoCodeWordSchema = z
  .string()
  .trim()
  .min(3)
  .max(40)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{2,39}$/, 'A code is letters, digits, dashes and underscores.');

export const createPromoCodeSchema = z
  .object({
    code: promoCodeWordSchema,
    kind: z.enum(['percent', 'flat', 'free_delivery']),
    /** Percent codes only: 1–10,000 basis points. */
    valueBps: z.number().int().min(1).max(10_000).optional(),
    /** Flat codes only. */
    valuePoisha: positivePoishaSchema.optional(),
    minOrderPoisha: nonNegativePoishaSchema.optional(),
    maxDiscountPoisha: positivePoishaSchema.optional(),
    totalLimit: z.number().int().positive().optional(),
    perCustomerLimit: z.number().int().positive().optional(),
    validFrom: businessDateSchema.optional(),
    validTo: businessDateSchema.optional(),
    channels: z
      .array(z.enum(['web', 'desk', 'pos', 'reseller']))
      .max(4)
      .optional(),
    skuIds: z.array(uuid).max(500).optional(),
    categoryIds: z.array(uuid).max(100).optional(),
    customerId: uuid.optional(),
    campaignId: uuid.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.kind === 'percent' && value.valueBps === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['valueBps'],
        message: 'A percent code needs a rate.',
      });
    }
    if (value.kind === 'flat' && value.valuePoisha === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['valuePoisha'],
        message: 'A flat code needs an amount.',
      });
    }
    if (
      value.validFrom !== undefined &&
      value.validTo !== undefined &&
      value.validFrom > value.validTo
    ) {
      context.addIssue({
        code: 'custom',
        path: ['validTo'],
        message: 'The window ends before it starts.',
      });
    }
  });
export type CreatePromoCodeInput = z.infer<typeof createPromoCodeSchema>;

export const promoStatusSchema = z
  .object({ status: z.enum(['active', 'paused', 'archived']) })
  .strict();

export const promoListSchema = z
  .object({
    status: z.enum(['active', 'paused', 'archived']).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();

/**
 * The desk's live check: a code and the basket it would apply to.
 *
 * Line amounts are what the caller has already priced — the net after any typed
 * discount — and the server reprices nothing here, because this endpoint answers "would
 * this code work" rather than "charge this". The order's own transaction prices the
 * basket again when it redeems, and that one is the figure that reaches the books.
 */
export const promoCheckSchema = z
  .object({
    code: promoCodeWordSchema,
    lines: z
      .array(z.object({ skuId: uuid, netPoisha: nonNegativePoishaSchema }).strict())
      .min(1)
      .max(200),
    deliveryChargePoisha: nonNegativePoishaSchema.default('0'),
    channel: z.enum(['web', 'desk', 'pos', 'reseller']).default('desk'),
    customerId: uuid.optional(),
  })
  .strict();
export type PromoCheckInput = z.infer<typeof promoCheckSchema>;

export const promoIdParamSchema = uuid;
