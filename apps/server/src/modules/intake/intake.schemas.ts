import { z } from 'zod';

import { TURNSTILE_TOKEN_MAX } from './turnstile.js';

/**
 * What the public intake accepts (architecture §23), and what an org admin sends to issue
 * a key.
 *
 * The public body is **narrower than the desk's** `createOrderSchema` on purpose, and each
 * omission is a thing a stranger's form must not be able to set:
 *
 * * **No price, no discount, no delivery charge, no advance.** The catalog prices the lines
 *   and the zone prices delivery, exactly as the desk does when the agent does not override
 *   them. A landing page that could send `unitPricePoisha` would be a landing page that
 *   sells at whatever a visitor's browser says.
 * * **No channel, no landing page id.** The key decides both (see `site_keys.channel`), so
 *   a request cannot file itself as a phone order or claim another page's attribution.
 * * **No assignee, branch or location.** A public order joins §6's unassigned queue, where
 *   the desk picks it up, and ships from the default warehouse.
 *
 * Quantities are capped at twenty per line and twenty lines: a real landing-page order is
 * one to three items, and a form that could reserve a warehouse on confirm is a form that
 * could be used to empty one.
 */

const uuid = z.string().uuid();
const text = (max: number) => z.string().trim().min(1).max(max);

const lineSchema = z
  .object({
    /** The SKU code printed on the page, e.g. `ELY-SHRT-0042-BLK-M`. */
    skuCode: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9]+(-[A-Z0-9]+)*$/, 'That is not a SKU code.')
      .max(64)
      .optional(),
    skuId: uuid.optional(),
    qty: z.number().int().min(1).max(20),
  })
  .strict()
  .refine((line) => (line.skuCode === undefined) !== (line.skuId === undefined), {
    message: 'Each line names its SKU once: a skuCode or a skuId.',
  });

export const publicOrderSchema = z
  .object({
    customer: z
      .object({
        name: text(200),
        /** Any spelling `normalizeBdPhone` accepts; the domain decides, not a regex here. */
        phone: z.string().min(6).max(32),
      })
      .strict(),
    address: z
      .object({
        districtId: z.number().int().positive(),
        thanaId: z.number().int().positive(),
        area: z.string().trim().max(160).optional(),
        addressLine: z.string().trim().min(3).max(500),
      })
      .strict(),
    lines: z.array(lineSchema).min(1).max(20),
    notes: z.string().trim().max(500).optional(),
    /** The page's UTM parameters, as the visitor arrived with them (§9 `source`). */
    utm: z
      .object({
        source: z.string().max(120).optional(),
        medium: z.string().max(120).optional(),
        campaign: z.string().max(120).optional(),
        content: z.string().max(120).optional(),
        term: z.string().max(120).optional(),
      })
      .strict()
      .optional(),
    /** The widget's token, as the browser handed it to the landing page's server. */
    turnstileToken: z.string().min(1).max(TURNSTILE_TOKEN_MAX),
    /**
     * The visitor, as the landing page's server saw them.
     *
     * Inside the signed body rather than in a header, so it is covered by the signature: a
     * visitor address anyone could set would be a rate limit anyone could step around.
     */
    visitor: z
      .object({ ip: z.union([z.ipv4(), z.ipv6()]).optional() })
      .strict()
      .optional(),
  })
  .strict();

export type PublicOrderInput = z.infer<typeof publicOrderSchema>;

export const issueSiteKeySchema = z
  .object({
    label: text(120),
    channel: z.enum(['landing_page', 'website']).default('landing_page'),
    landingPageId: uuid.optional(),
  })
  .strict();

export type IssueSiteKeyInput = z.infer<typeof issueSiteKeySchema>;

export const siteKeyIdSchema = uuid;
