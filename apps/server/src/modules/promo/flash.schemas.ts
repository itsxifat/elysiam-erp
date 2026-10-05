import { positivePoishaSchema } from '@elysium/contracts';
import { z } from 'zod';

/**
 * Flash sales over the wire (M35a, D-542; architecture §23).
 *
 * The editor sends the whole sale, its SKUs included, and the server makes the stored sale
 * match: prices and limits change, SKUs left out are switched off (never deleted; claims
 * name them), and what each SKU has sold is never taken from the request.
 */

const uuid = z.string().uuid();
const instantSchema = z.string().datetime({ offset: true });

/** The sale's page, `/flash-sale/<slug>`: lower-case words joined by single dashes. */
export const flashSlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(80)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'A slug is lower-case letters and digits joined by dashes.');

const itemSchema = z
  .object({
    skuId: uuid,
    salePricePoisha: positivePoishaSchema,
    /** Units at the sale price; null sells all the stock there is. */
    unitLimit: z.number().int().min(1).max(1_000_000).nullable(),
  })
  .strict();

export const flashSaleBodySchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    subtitle: z.string().trim().max(160).default(''),
    description: z.string().trim().max(1000).default(''),
    /** Derived from the title when absent, with `-2`, `-3` on a clash. */
    slug: flashSlugSchema.optional(),
    bannerFileId: uuid.nullable().default(null),
    enabled: z.boolean().default(false),
    showOnHome: z.boolean().default(true),
    priority: z.number().int().min(-100).max(100).default(0),
    startsAt: instantSchema.nullable().default(null),
    endsAt: instantSchema.nullable().default(null),
    items: z.array(itemSchema).max(500).default([]),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.startsAt !== null &&
      value.endsAt !== null &&
      new Date(value.startsAt) >= new Date(value.endsAt)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['endsAt'],
        message: 'The sale has to end after it starts.',
      });
    }
    const skus = value.items.map((item) => item.skuId);
    if (new Set(skus).size !== skus.length) {
      context.addIssue({
        code: 'custom',
        path: ['items'],
        message: 'A SKU appears twice in the sale.',
      });
    }
    // Only a sale that is switched on has to be complete; a draft may be saved half-done.
    if (value.enabled && value.items.length === 0) {
      context.addIssue({
        code: 'custom',
        path: ['items'],
        message: 'Put at least one SKU on sale before switching the sale on.',
      });
    }
  });
export type FlashSaleBody = z.infer<typeof flashSaleBodySchema>;

export const flashEnabledSchema = z.object({ enabled: z.boolean() }).strict();

export const flashListSchema = z
  .object({ limit: z.coerce.number().int().min(1).max(200).default(100) })
  .strict();

export const flashIdParamSchema = uuid;
