import {
  stickerExtraLineSchema,
  stickerHeightMmSchema,
  stickerWidthMmSchema,
} from '@elysium/contracts';
import { CUSTOM_STICKER_MEDIUM, MAX_STICKERS_PER_PDF, STICKER_MEDIA_IDS } from '@elysium/domain';
import { z } from 'zod';

/**
 * The catalog's edge validation (architecture §23, M06).
 *
 * In this module rather than in `packages/contracts`, following `files.schemas.ts`
 * — and for a reason that is temporary rather than principled: the contracts
 * barrel is being edited concurrently by other milestones in this working tree,
 * and a second write to it silently discards the first. The INTEGRATION section of
 * M06's report hands the integrator the move. Recorded as D-124 so it is a
 * follow-up rather than a habit: the rule is one schema shared by the form and
 * the server, and two files drifting apart is the failure it prevents.
 *
 * ## Money on the wire
 *
 * Every price is an **integer-poisha decimal string**, never a JSON number
 * (§23, D-078). `JSON.parse` turns a crore-scale poisha value into a double and
 * loses the last digits, and the screen that displays it looks perfectly correct.
 * `pricePoishaSchema` is the only way a price enters this module.
 *
 * ## No cost
 *
 * Invariant 5. There is no cost field in any schema here, and
 * the route-matrix cost sweep (`cost-sweep.e2e.test.ts`) proves no response carries one — a schema
 * that accepted `unitCostPoisha` would be a cost column in everything but name,
 * because the service would have to store it somewhere.
 */

/** A positive integer-poisha decimal string within §7's ±9e15 bound. */
export const pricePoishaSchema = z
  .string()
  .max(16, 'Prices are integer poisha, sent as a decimal string.')
  .regex(/^[1-9]\d*$/, 'Prices are positive integer poisha, sent as a decimal string.')
  .refine(
    (value) => !/^\d+$/.test(value) || BigInt(value) <= 9_000_000_000_000_000n,
    'That price is out of range.',
  );

export const catalogIdSchema = z.string().uuid('No such record.');

/**
 * A regular ("was") price (M39b, D-640): a selling-side figure, positive integer poisha like
 * a price, or null for none. Above the selling price when set; the service says which
 * variant broke that and the database's CHECK is the backstop.
 */
export const compareAtPoishaSchema = pricePoishaSchema.nullable();

/** A weight in grams, as couriers are told (M39b, D-645): 1 g to 100 kg, or null for none. */
export const weightGramsSchema = z
  .number()
  .int('A weight is whole grams.')
  .min(1, 'A weight is at least 1 gram.')
  .max(100_000, 'A weight is at most 100 kg.')
  .nullable();

/** One variant's own prices, named by its value ids (D-422, M39b D-635, D-639). */
const variantPriceSchema = z.object({
  valueIds: z.array(z.string().uuid('No such record.')).min(1).max(4),
  pricePoisha: pricePoishaSchema,
  /** Absent: the product's regular price. Null: none for this variant. */
  compareAtPoisha: compareAtPoishaSchema.optional(),
});

/** The `{CAT}`, `{COLOR}`, `{SIZE}` segments of a SKU code: upper-case, no dash. */
const segmentSchema = z
  .string()
  .trim()
  .regex(/^[A-Z0-9]{1,8}$/, 'A code is 1-8 upper-case letters or digits, with no dash.');

const slugSchema = z
  .string()
  .trim()
  .max(120)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'A slug is lower-case words joined by single dashes.');

const nameSchema = z.string().trim().min(1, 'A name is required.').max(200);

// --- categories -------------------------------------------------------------

export const createCategorySchema = z.object({
  name: nameSchema.max(120),
  slug: slugSchema,
  code: segmentSchema,
  parentId: catalogIdSchema.nullish(),
  position: z.number().int().min(0).max(9999).optional(),
});
export type CreateCategoryInput = z.infer<typeof createCategorySchema>;

export const updateCategorySchema = z
  .object({
    name: nameSchema.max(120).optional(),
    slug: slugSchema.optional(),
    // `code` is absent on purpose: it is a segment of every SKU code already
    // printed under this category, and those are stored strings.
    parentId: catalogIdSchema.nullish(),
    position: z.number().int().min(0).max(9999).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Nothing to change.');
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;

// --- attributes -------------------------------------------------------------

export const attributeKindSchema = z.enum(['size', 'colour', 'custom']);

export const createAttributeSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^[A-Z][A-Z0-9_]{0,31}$/, 'An attribute code is upper-case, starting with a letter.'),
  name: nameSchema.max(60),
  kind: attributeKindSchema.default('custom'),
  isVariant: z.boolean().default(true),
  position: z.number().int().min(0).max(9999).optional(),
});
export type CreateAttributeInput = z.infer<typeof createAttributeSchema>;

export const createAttributeValueSchema = z.object({
  code: segmentSchema,
  label: z.string().trim().min(1).max(60),
  position: z.number().int().min(0).max(9999).optional(),
});
export type CreateAttributeValueInput = z.infer<typeof createAttributeValueSchema>;

/**
 * Rename an attribute or move it in the list (D-424). `code` is absent on purpose:
 * it is the attribute's key in every import file and report.
 */
export const updateAttributeSchema = z
  .object({
    name: nameSchema.max(60).optional(),
    position: z.number().int().min(0).max(9999).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Nothing to change.');
export type UpdateAttributeInput = z.infer<typeof updateAttributeSchema>;

/**
 * Fix a value's label or move it (D-424). `code` is absent on purpose: it is a segment
 * of every SKU code already built from this value, and those are printed on labels.
 */
export const updateAttributeValueSchema = z
  .object({
    label: z.string().trim().min(1).max(60).optional(),
    position: z.number().int().min(0).max(9999).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Nothing to change.');
export type UpdateAttributeValueInput = z.infer<typeof updateAttributeValueSchema>;

// --- products and the variant matrix ---------------------------------------

/**
 * One axis of the matrix: an attribute and the values chosen for this product.
 *
 * Value **ids**, not codes. A code is a label that an org may reuse (`M` for
 * both a size and a sleeve length); the id is what the SKU's `variant_key` is
 * built from, and check 1 depends on that key meaning the same combination
 * before and after somebody renames a value.
 */
export const variantAxisSchema = z.object({
  attributeId: catalogIdSchema,
  valueIds: z.array(catalogIdSchema).min(1, 'An axis needs at least one value.').max(50),
});

export const productStatusSchema = z.enum(['draft', 'active', 'archived']);

export const createProductSchema = z.object({
  name: nameSchema,
  slug: slugSchema,
  categoryId: catalogIdSchema.nullish(),
  description: z.string().trim().max(20000).optional(),
  status: productStatusSchema.default('draft'),
  /** The selling price every generated SKU starts at. */
  pricePoisha: pricePoishaSchema,
  /**
   * The axes. Empty is allowed and means one unvaried SKU.
   *
   * A product with **no** SKUs at all is also allowed — that is a draft, which
   * the console's create flow needs (D-121). `generateSkus: false` produces one.
   */
  axes: z.array(variantAxisSchema).max(4).default([]),
  generateSkus: z.boolean().default(true),
  /**
   * A price for some of the generated variants, named by their value ids (D-422), each
   * with its own regular price if it has one (M39b, D-635). Every other variant starts at
   * `pricePoisha`. Refused when it names a combination the axes do not produce, so a
   * typed price is never silently dropped.
   */
  variantPrices: z.array(variantPriceSchema).max(500).optional(),
  /** The regular ("was") price every generated variant starts with (M39b, D-640). */
  compareAtPoisha: pricePoishaSchema.optional(),
  /** What one piece weighs, in grams (M39b, D-645). */
  weightGrams: weightGramsSchema.optional(),
});
export type CreateProductInput = z.infer<typeof createProductSchema>;

export const updateProductSchema = z
  .object({
    name: nameSchema.optional(),
    slug: slugSchema.optional(),
    categoryId: catalogIdSchema.nullish(),
    description: z.string().trim().max(20000).nullish(),
    status: productStatusSchema.optional(),
    /** Grams per piece, or null to clear it (M39b, D-645). */
    weightGrams: weightGramsSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Nothing to change.');
export type UpdateProductInput = z.infer<typeof updateProductSchema>;

/**
 * Extend a product's matrix.
 *
 * Deliberately named `extend` rather than `set`: the endpoint adds the
 * combinations the axes imply and that do not exist yet, and nothing else. A
 * `PUT /variants` that replaced the matrix is the shape check 1 exists to rule
 * out — the SKUs it dropped have stock, movements and printed labels behind them.
 */
export const extendMatrixSchema = z.object({
  axes: z.array(variantAxisSchema).min(1).max(4),
  /**
   * The main price for new SKUs that have no price of their own (M39b, D-639): used when a
   * new variant has no same-size variant to follow. Absent: the price most of the product's
   * active variants carry. Never the cheapest, never an archived variant's.
   */
  pricePoisha: pricePoishaSchema.optional(),
  /** A price (and regular price) for some of the new variants, by their value ids. */
  variantPrices: z.array(variantPriceSchema).max(500).optional(),
});
export type ExtendMatrixInput = z.infer<typeof extendMatrixSchema>;

// --- prices -----------------------------------------------------------------

export const setPricesSchema = z.object({
  prices: z
    .array(
      z
        .object({
          skuId: catalogIdSchema,
          pricePoisha: pricePoishaSchema.optional(),
          /** The regular price (M39b, D-640): absent leaves it, null clears it. */
          compareAtPoisha: compareAtPoishaSchema.optional(),
          /**
           * The selling price the change was worked out from (the bulk editor's preview): a
           * price changed by someone else since is refused rather than overwritten.
           */
          expectedPricePoisha: pricePoishaSchema.optional(),
        })
        .refine(
          (entry) => entry.pricePoisha !== undefined || entry.compareAtPoisha !== undefined,
          'Each entry changes a price, a regular price or both.',
        ),
    )
    .min(1, 'Name at least one SKU.')
    .max(500, 'Reprice at most 500 SKUs at a time.'),
  reason: z.string().trim().max(200).optional(),
});
export type SetPricesInput = z.infer<typeof setPricesSchema>;

export const setBarcodeSchema = z.object({
  /** Null clears it, which makes the SKU code the label's payload again. */
  barcode: z
    .string()
    .trim()
    .max(48)
    .regex(/^[\x20-\x7e]+$/, 'A Code 128 barcode holds printable ASCII only.')
    .nullable(),
});
export type SetBarcodeInput = z.infer<typeof setBarcodeSchema>;

/**
 * Archive a SKU or bring it back (D-423). Stock stays where it is: an archived SKU
 * cannot be sold, but it can still be transferred, counted and written off.
 */
export const updateSkuSchema = z.object({ status: z.enum(['active', 'archived']) }).strict();
export type UpdateSkuInput = z.infer<typeof updateSkuSchema>;

// --- images -----------------------------------------------------------------

export const attachImageSchema = z.object({
  /** A `files.objects` id from `POST /v1/files`, already finalized and public. */
  fileId: catalogIdSchema,
  altText: z.string().trim().max(200).optional(),
  /** The colour this photo shows (M39b, D-643): a colour value of the brand's, or none. */
  colourValueId: catalogIdSchema.nullish(),
});
export type AttachImageInput = z.infer<typeof attachImageSchema>;

export const reorderImagesSchema = z.object({
  /** Every image id of the product, in the order they should appear. */
  imageIds: z.array(catalogIdSchema).min(1).max(50),
});
export type ReorderImagesInput = z.infer<typeof reorderImagesSchema>;

// --- search and listing -----------------------------------------------------

export const productQuerySchema = z.object({
  /**
   * A search fragment. Three characters minimum, and the floor is not arbitrary:
   * `pg_trgm` produces no trigrams from a two-character word, so a shorter
   * fragment cannot use the GIN index and the query becomes the sequential scan
   * check 2 is about.
   */
  q: z.string().trim().min(3, 'Search needs at least three characters.').max(80).optional(),
  categoryId: catalogIdSchema.optional(),
  status: productStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(200).optional(),
});
export type ProductQuery = z.infer<typeof productQuerySchema>;

export const skuQuerySchema = z.object({
  q: z.string().trim().min(3).max(80).optional(),
  /** An exact code or barcode, for a scanner. Bypasses the trigram index. */
  code: z.string().trim().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type SkuQuery = z.infer<typeof skuQuerySchema>;

// --- CSV import -------------------------------------------------------------

export const priceImportSchema = z.object({
  /**
   * The file, as text. Uploaded through this endpoint rather than §22's presigned
   * PUT because a price file is a few kilobytes and the operator is waiting for
   * the report — a presign, an upload and a poll would be three round trips for
   * something that fits in one.
   */
  csv: z.string().min(1, 'The file is empty.').max(2_000_000, 'That file is too large to import.'),
  reason: z.string().trim().max(200).optional(),
});
export type PriceImportInput = z.infer<typeof priceImportSchema>;

/** The new-products spreadsheet (D-425): the file as text, like the price importer. */
export const productImportSchema = z
  .object({
    csv: z
      .string()
      .min(1, 'The file is empty.')
      .max(2_000_000, 'That file is too large to import.'),
  })
  .strict();
export type ProductImportInput = z.infer<typeof productImportSchema>;

// --- labels -----------------------------------------------------------------

export const labelSheetSchema = z
  .object({
    /**
     * The SKUs to print, and how many stickers of each: one per piece (M38a). At most
     * `MAX_STICKERS_PER_PDF` in all, which the service checks (the console prints more in
     * parts).
     */
    items: z
      .array(
        z.object({
          skuId: catalogIdSchema,
          copies: z.number().int().min(1).max(MAX_STICKERS_PER_PDF).default(1),
        }),
      )
      .min(1)
      .max(500),
    /** Show the selling price on the sticker. Off unless asked; the console asks by default. */
    showPrice: z.boolean().default(false),
    /**
     * What the stickers print on (D-604, D-650): a thermal roll (one sticker a page, at the
     * sticker's size), an A4 sheet, or `custom`, a roll sticker of `widthMm × heightMm`.
     * M06's A4 3 × 8 sheet when absent.
     */
    medium: z.enum([...STICKER_MEDIA_IDS, CUSTOM_STICKER_MEDIUM]).default('a4-3x8'),
    /** A custom sticker's size in millimetres, one decimal at most (D-650); custom only. */
    widthMm: stickerWidthMmSchema.optional(),
    heightMm: stickerHeightMmSchema.optional(),
    /** On a sheet, the first unused position (1 = top left); the ones before stay blank. */
    startAt: z.number().int().min(1).max(40).default(1),
    /** A short line printed on every sticker of this print (D-651); blank for none. */
    extraLine: stickerExtraLineSchema.optional(),
  })
  .strict()
  .superRefine((input, context) => {
    const sized = input.widthMm !== undefined || input.heightMm !== undefined;
    if (input.medium === CUSTOM_STICKER_MEDIUM) {
      if (input.widthMm === undefined || input.heightMm === undefined) {
        context.addIssue({
          code: 'custom',
          path: [input.widthMm === undefined ? 'widthMm' : 'heightMm'],
          message: 'A custom sticker needs its width and height in millimetres.',
        });
      }
    } else if (sized) {
      context.addIssue({
        code: 'custom',
        path: ['medium'],
        message: 'A width and height are given only with the custom size.',
      });
    }
  });
export type LabelSheetInput = z.infer<typeof labelSheetSchema>;

// --- M39b: product management (D-641 to D-646) -------------------------------------

/** Which colour a photo shows, or null for every colour (D-643). */
export const imageColourSchema = z.object({ colourValueId: catalogIdSchema.nullable() }).strict();
export type ImageColourInput = z.infer<typeof imageColourSchema>;

/** A variant's own weight in grams, or null to use the product's (D-645). */
export const skuWeightSchema = z.object({ weightGrams: weightGramsSchema }).strict();
export type SkuWeightInput = z.infer<typeof skuWeightSchema>;

/**
 * Duplicate a product (D-641): its name, and optionally its web address (made from the name
 * and kept unique otherwise).
 */
export const duplicateProductSchema = z
  .object({
    name: nameSchema,
    slug: slugSchema.optional(),
  })
  .strict();
export type DuplicateProductInput = z.infer<typeof duplicateProductSchema>;

/**
 * Many products at once from the product list (D-642): archive or restore them, or file them
 * under another category. The website's switches go through the storefront's own bulk route
 * (`update Storefront`, D-508).
 */
export const bulkProductsSchema = z
  .object({
    productIds: z
      .array(catalogIdSchema)
      .min(1, 'Choose at least one product.')
      .max(100, 'Change at most 100 products at a time.'),
    status: productStatusSchema.optional(),
    categoryId: catalogIdSchema.nullish(),
  })
  .strict()
  .refine(
    (value) => value.status !== undefined || value.categoryId !== undefined,
    'Nothing to change.',
  );
export type BulkProductsInput = z.infer<typeof bulkProductsSchema>;
