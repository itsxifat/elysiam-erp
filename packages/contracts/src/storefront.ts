import { z } from 'zod';

/**
 * The website's settings and content, as the console edits them and the server checks them
 * (M33, D-500 to D-505). One schema per form, shared, so the console can never accept what
 * the server refuses.
 *
 * Money is integer poisha as a decimal string (§23, D-078), like every other amount on the
 * wire. Links a person types go through `siteLinkSchema`: a path on the site or an
 * `https://` address, never `javascript:` or `//elsewhere` (the same rule as the domain's
 * `isSafeSiteLink`, held equal by a test in the server).
 */

const poishaString = z
  .string()
  .regex(/^\d{1,16}$/, 'An amount is integer poisha, sent as a decimal string.')
  // Guarded: zod runs a refinement even when the regex above has already failed.
  .refine(
    (value) => !/^\d+$/.test(value) || BigInt(value) <= 9_000_000_000_000_000n,
    'That amount is out of range.',
  );

const uuid = z.string().uuid('No such record.');

/** A path on the website (`/shop?category=men`) or an `https://` address. */
export function isSiteLink(href: string): boolean {
  if (href === '' || href.length > 500 || href.trim() !== href) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f\\]/.test(href)) return false;
  if (href.startsWith('/')) return !href.startsWith('//');
  if (!href.startsWith('https://')) return false;
  try {
    const url = new URL(href);
    return (
      url.protocol === 'https:' && url.hostname !== '' && url.username === '' && url.password === ''
    );
  } catch {
    return false;
  }
}

export const siteLinkSchema = z
  .string()
  .max(500)
  .refine(isSiteLink, 'A link is a path on the site (starting with /) or an https:// address.');

/** A link that may be left empty. */
const optionalLink = z.union([z.literal(''), siteLinkSchema]);

/** An outside address only: social profiles. */
const httpsLink = z.union([
  z.literal(''),
  z
    .string()
    .max(300)
    .refine(
      (value) => value.startsWith('https://') && isSiteLink(value),
      'A profile link is an https:// address.',
    ),
]);

const text = (max: number) => z.string().trim().max(max);

export const WEB_GENDERS = ['men', 'women', 'kids', 'unisex'] as const;
export const webGenderSchema = z.enum(WEB_GENDERS);
export type WebGender = z.infer<typeof webGenderSchema>;

// --- products and categories ----------------------------------------------------------------

/** The product page's Website card (D-500). Every field optional: send what changed. */
export const productWebFieldsSchema = z
  .object({
    webVisible: z.boolean(),
    featured: z.boolean(),
    newArrival: z.boolean(),
    gender: webGenderSchema.nullable(),
    material: text(200).nullable(),
    careInstructions: text(2000).nullable(),
    tags: z.array(z.string().max(60)).max(60),
    sizeChartId: uuid.nullable(),
    seoTitle: text(120).nullable(),
    seoDescription: text(320).nullable(),
  })
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Nothing to change.');
export type ProductWebFieldsInput = z.infer<typeof productWebFieldsSchema>;

/** A category's website fields on Catalog setup (D-501). */
export const categoryWebFieldsSchema = z
  .object({
    webVisible: z.boolean(),
    featured: z.boolean(),
    gender: webGenderSchema.nullable(),
    description: text(2000).nullable(),
    imageFileId: uuid.nullable(),
    /** The size chart new products filed here start with (M39b, D-646), or none. */
    defaultSizeChartId: uuid.nullable(),
  })
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Nothing to change.');
export type CategoryWebFieldsInput = z.infer<typeof categoryWebFieldsSchema>;

/**
 * The product list's bulk website switches (M39b, D-642): show or hide many products on the
 * website, or give them one size chart. `update Storefront`, like the product's own Website
 * card (D-508).
 */
export const bulkProductWebFieldsSchema = z
  .object({
    productIds: z.array(uuid).min(1, 'Choose at least one product.').max(100),
    webVisible: z.boolean().optional(),
    sizeChartId: uuid.nullable().optional(),
  })
  .strict()
  .refine(
    (value) => value.webVisible !== undefined || value.sizeChartId !== undefined,
    'Nothing to change.',
  );
export type BulkProductWebFieldsInput = z.infer<typeof bulkProductWebFieldsSchema>;

// --- settings (D-503) -----------------------------------------------------------------------

export const siteInfoSchema = z
  .object({
    siteName: text(120).min(1, 'The site needs a name.'),
    logoFileId: uuid.nullable(),
    /** Printed on courier labels; never sent to the website. */
    merchantId: text(60),
    whatsapp: z
      .string()
      .trim()
      .max(20)
      .regex(/^(\+?\d{6,15})?$/, 'A WhatsApp number is digits, with an optional +.'),
    phone: text(30),
    email: z.union([
      z.literal(''),
      z.string().trim().max(200).email('That is not an email address.'),
    ]),
    address: text(300),
    /** The website's own address, for the console's "View on website" links. */
    siteUrl: httpsLink,
  })
  .strict();
export type SiteInfo = z.infer<typeof siteInfoSchema>;

export const socialLinksSchema = z
  .object({
    facebook: httpsLink,
    instagram: httpsLink,
    tiktok: httpsLink,
    youtube: httpsLink,
  })
  .strict();
export type SocialLinks = z.infer<typeof socialLinksSchema>;

export const announcementSchema = z
  .object({
    enabled: z.boolean(),
    text: text(200),
    link: optionalLink,
  })
  .strict()
  .refine(
    (value) => !value.enabled || value.text !== '',
    'An announcement that is on needs words.',
  );
export type Announcement = z.infer<typeof announcementSchema>;

export const promoBannerSchema = z
  .object({
    enabled: z.boolean(),
    headline: text(80),
    subtext: text(300),
    note: text(120),
    decorativeText: text(12),
    primaryLabel: text(40),
    primaryHref: optionalLink,
    secondaryLabel: text(40),
    secondaryHref: optionalLink,
  })
  .strict()
  .refine(
    (value) => !value.enabled || value.headline !== '',
    'A banner that is on needs a headline.',
  );
export type PromoBanner = z.infer<typeof promoBannerSchema>;

export const testimonialSchema = z
  .object({
    name: text(80).min(1, 'A testimonial needs a name.'),
    location: text(80),
    rating: z.number().int().min(1).max(5),
    text: text(600).min(1, 'A testimonial needs its words.'),
  })
  .strict();
export const testimonialsSchema = z.array(testimonialSchema).max(20);
export type Testimonial = z.infer<typeof testimonialSchema>;

export const WEB_ZONE_KEYS = ['inside_dhaka', 'suburbs', 'outside_dhaka'] as const;

const webZoneSchema = z
  .object({
    feePoisha: poishaString,
    deliveryZoneIds: z.array(uuid).max(20),
  })
  .strict();

export const shippingRuleSchema = z
  .object({
    freeShippingEnabled: z.boolean(),
    freeShippingThresholdPoisha: poishaString.nullable(),
    zones: z
      .object({ inside_dhaka: webZoneSchema, suburbs: webZoneSchema, outside_dhaka: webZoneSchema })
      .strict(),
  })
  .strict();
export type ShippingRuleInput = z.infer<typeof shippingRuleSchema>;

export const paymentMethodsSchema = z
  .object({ cod: z.boolean(), sslcommerz: z.boolean() })
  .strict()
  .refine((value) => value.cod || value.sslcommerz, 'The checkout needs at least one way to pay.');
export type PaymentMethods = z.infer<typeof paymentMethodsSchema>;

export const webLocationIdsSchema = z
  .array(uuid)
  .min(1, 'The website sells from at least one stock location.')
  .max(10);

/**
 * Website → Settings saves one section at a time: each section sent replaces that section,
 * and the sections not sent stay as they are.
 */
export const storefrontSettingsPatchSchema = z
  .object({
    siteInfo: siteInfoSchema,
    social: socialLinksSchema,
    announcement: announcementSchema,
    promoBanner: promoBannerSchema,
    testimonials: testimonialsSchema,
    shipping: shippingRuleSchema,
    payments: paymentMethodsSchema,
    webLocationIds: webLocationIdsSchema,
  })
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Nothing to change.');
export type StorefrontSettingsPatch = z.infer<typeof storefrontSettingsPatchSchema>;

// --- hero slides, menu, size charts (D-502, D-504) ------------------------------------------

export const heroSlideSchema = z
  .object({
    desktopFileId: uuid,
    mobileFileId: uuid.nullable(),
    link: siteLinkSchema,
    altText: text(200).nullable(),
    isActive: z.boolean(),
  })
  .strict();
export type HeroSlideInput = z.infer<typeof heroSlideSchema>;

/** The new order of a list, every id exactly once. */
export const reorderSchema = z
  .object({ ids: z.array(uuid).min(1).max(200) })
  .strict()
  .refine((value) => new Set(value.ids).size === value.ids.length, 'An item is listed twice.');

export const NAV_ITEM_KINDS = ['link', 'category', 'dropdown'] as const;

export const navItemSchema = z
  .object({
    parentId: uuid.nullable(),
    kind: z.enum(NAV_ITEM_KINDS),
    label: text(60).nullable(),
    href: siteLinkSchema.nullable(),
    categoryId: uuid.nullable(),
    highlighted: z.boolean(),
    isActive: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.kind === 'link' && value.href === null) {
      context.addIssue({ code: 'custom', path: ['href'], message: 'A link item needs a link.' });
    }
    if (value.kind === 'category' && value.categoryId === null) {
      context.addIssue({
        code: 'custom',
        path: ['categoryId'],
        message: 'A category item needs a category.',
      });
    }
    if (value.kind !== 'category' && (value.label ?? '') === '') {
      context.addIssue({ code: 'custom', path: ['label'], message: 'This item needs a label.' });
    }
  });
export type NavItemInput = z.infer<typeof navItemSchema>;

/** The whole menu's shape after a drag: every item's parent and place. */
export const navLayoutSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            id: uuid,
            parentId: uuid.nullable(),
            position: z.number().int().min(0).max(999),
          })
          .strict(),
      )
      .max(200),
  })
  .strict()
  .refine(
    (value) => new Set(value.items.map((item) => item.id)).size === value.items.length,
    'An item is listed twice.',
  );

export const sizeChartSchema = z
  .object({
    name: text(120).min(1, 'A size chart needs a name.'),
    columns: z.array(z.string().trim().min(1).max(40)).min(1).max(12),
    rows: z.array(z.array(z.string().trim().max(40)).max(12)).max(60),
  })
  .strict()
  .refine(
    (value) => value.rows.every((row) => row.length === value.columns.length),
    'Every row has one cell per column.',
  );
export type SizeChartInput = z.infer<typeof sizeChartSchema>;

// --- the website's keys (D-506) -------------------------------------------------------------

export const issueStorefrontKeySchema = z
  .object({ label: z.string().trim().min(1, 'A key needs a label.').max(120) })
  .strict();
