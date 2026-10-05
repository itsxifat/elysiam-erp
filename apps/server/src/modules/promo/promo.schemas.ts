import {
  businessDateSchema,
  nonNegativePoishaSchema,
  positivePoishaSchema,
  PROMO_CHANNELS,
} from '@elysium/contracts';
import { z } from 'zod';

/**
 * The promo module's wire shapes (architecture §23), validated at the edge.
 *
 * `discountPoisha` is absent from every request on purpose: a caller sends codes and a
 * basket, and the server decides what each discount is worth. A field a client could set
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

const instantSchema = z.string().datetime({ offset: true });

const tierSchema = z
  .object({
    minSubtotalPoisha: nonNegativePoishaSchema,
    kind: z.enum(['percent', 'flat']),
    valueBps: z.number().int().min(1).max(10_000).optional(),
    valuePoisha: positivePoishaSchema.optional(),
  })
  .strict()
  .superRefine((tier, context) => {
    if (tier.kind === 'percent' && tier.valueBps === undefined) {
      context.addIssue({ code: 'custom', path: ['valueBps'], message: 'A tier needs a rate.' });
    }
    if (tier.kind === 'flat' && tier.valuePoisha === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['valuePoisha'],
        message: 'A tier needs an amount.',
      });
    }
  });

/**
 * A new discount (M16's codes, extended in M35a, D-541).
 *
 * The M16 body is still accepted as it was: a code with a kind, a value and its limits, the
 * method `code` by default. M35a adds the method `automatic` (no code; a title instead),
 * buy-X-get-Y, tiers, first-order-only, a minimum quantity, products in scope, an instant
 * window, stacking and priority.
 */
export const createPromoCodeSchema = z
  .object({
    method: z.enum(['code', 'automatic']).optional(),
    code: promoCodeWordSchema.optional(),
    title: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(1000).optional(),
    kind: z.enum(['percent', 'flat', 'free_delivery', 'buy_x_get_y', 'tiered']),
    /** Percent: 1–10,000 basis points. */
    valueBps: z.number().int().min(1).max(10_000).optional(),
    /** Flat: the amount off. */
    valuePoisha: positivePoishaSchema.optional(),
    buyQuantity: z.number().int().min(1).max(1_000).optional(),
    getQuantity: z.number().int().min(1).max(1_000).optional(),
    /** Buy X get Y: how much off each discounted unit; 10,000 (free) when absent. */
    getDiscountBps: z.number().int().min(1).max(10_000).optional(),
    tiers: z.array(tierSchema).min(1).max(10).optional(),
    minOrderPoisha: nonNegativePoishaSchema.optional(),
    minQuantity: z.number().int().min(1).max(10_000).optional(),
    firstOrderOnly: z.boolean().optional(),
    maxDiscountPoisha: positivePoishaSchema.optional(),
    totalLimit: z.number().int().positive().optional(),
    perCustomerLimit: z.number().int().positive().optional(),
    validFrom: businessDateSchema.optional(),
    validTo: businessDateSchema.optional(),
    startsAt: instantSchema.optional(),
    endsAt: instantSchema.optional(),
    channels: z.array(z.enum(PROMO_CHANNELS)).max(PROMO_CHANNELS.length).optional(),
    skuIds: z.array(uuid).max(500).optional(),
    productIds: z.array(uuid).max(500).optional(),
    categoryIds: z.array(uuid).max(100).optional(),
    customerId: uuid.optional(),
    /** The brand's own campaign this code promotes (M18): explicit attribution (D-251). */
    campaignId: uuid.optional(),
    allowStacking: z.boolean().optional(),
    priority: z.number().int().min(-100).max(100).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const method = value.method ?? 'code';
    const issue = (path: string, message: string) =>
      context.addIssue({ code: 'custom', path: [path], message });

    if (method === 'code' && value.code === undefined) issue('code', 'A code needs its word.');
    if (method === 'automatic') {
      if (value.code !== undefined) issue('code', 'An automatic discount has no code.');
      if (value.title === undefined) issue('title', 'An automatic discount needs a title.');
      if (value.customerId !== undefined) {
        issue('customerId', 'Only a code can be personal to one buyer.');
      }
    }
    if (value.kind === 'percent' && value.valueBps === undefined) {
      issue('valueBps', 'A percent code needs a rate.');
    }
    if (value.kind === 'flat' && value.valuePoisha === undefined) {
      issue('valuePoisha', 'A flat code needs an amount.');
    }
    if (
      value.kind === 'buy_x_get_y' &&
      (value.buyQuantity === undefined || value.getQuantity === undefined)
    ) {
      issue('buyQuantity', 'Buy X get Y needs both quantities.');
    }
    if (value.kind === 'tiered' && value.tiers === undefined) {
      issue('tiers', 'A tiered discount needs at least one tier.');
    }
    if (value.kind !== 'tiered' && value.tiers !== undefined) {
      issue('tiers', 'Only a tiered discount has tiers.');
    }
    if (
      value.validFrom !== undefined &&
      value.validTo !== undefined &&
      value.validFrom > value.validTo
    ) {
      issue('validTo', 'The window ends before it starts.');
    }
    if (
      value.startsAt !== undefined &&
      value.endsAt !== undefined &&
      new Date(value.startsAt) >= new Date(value.endsAt)
    ) {
      issue('endsAt', 'The window ends before it starts.');
    }
  });
export type CreatePromoCodeInput = z.infer<typeof createPromoCodeSchema>;

export const promoStatusSchema = z
  .object({ status: z.enum(['active', 'paused', 'archived']) })
  .strict();

export const promoListSchema = z
  .object({
    status: z.enum(['active', 'paused', 'archived']).optional(),
    method: z.enum(['code', 'automatic']).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();

const lineSchema = z
  .object({
    skuId: uuid,
    netPoisha: nonNegativePoishaSchema,
    /** Whole units; one when absent (M16's desk sent none). Buy-X-get-Y and minimums count them. */
    qty: z.number().int().min(1).max(10_000).optional(),
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
    lines: z.array(lineSchema).min(1).max(200),
    deliveryChargePoisha: nonNegativePoishaSchema.default('0'),
    /** The desk's typed order discount; the code is priced on what is left (W3). */
    orderDiscountPoisha: nonNegativePoishaSchema.optional(),
    /** The order's own channel, or `pos` at the till. Required: the caller always knows. */
    channel: z.enum(PROMO_CHANNELS),
    customerId: uuid.optional(),
  })
  .strict();
export type PromoCheckInput = z.infer<typeof promoCheckSchema>;

export const promoIdParamSchema = uuid;
