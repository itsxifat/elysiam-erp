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
   * A price for some of the generated variants, named by their value ids (D-422).
   * Every other variant starts at `pricePoisha`. Refused when it names a combination
   * the axes do not produce, so a typed price is never silently dropped.
   */
  variantPrices: z
    .array(
      z.object({
        valueIds: z.array(catalogIdSchema).min(1).max(4),
        pricePoisha: pricePoishaSchema,
      }),
    )
    .max(500)
    .optional(),
});
export type CreateProductInput = z.infer<typeof createProductSchema>;

export const updateProductSchema = z
  .object({
    name: nameSchema.optional(),
    slug: slugSchema.optional(),
    categoryId: catalogIdSchema.nullish(),
    description: z.string().trim().max(20000).nullish(),
    status: productStatusSchema.optional(),
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
  /** The price for the new SKUs. Defaults to the product's cheapest existing SKU. */
  pricePoisha: pricePoishaSchema.optional(),
});
export type ExtendMatrixInput = z.infer<typeof extendMatrixSchema>;

// --- prices -----------------------------------------------------------------

export const setPricesSchema = z.object({
  prices: z
    .array(z.object({ skuId: catalogIdSchema, pricePoisha: pricePoishaSchema }))
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

export const labelSheetSchema = z.object({
  /** The SKUs to print, and how many labels of each. */
  items: z
    .array(
      z.object({
        skuId: catalogIdSchema,
        copies: z.number().int().min(1).max(200).default(1),
      }),
    )
    .min(1)
    .max(200),
  /** Show the selling price on the label. Off by default. */
  showPrice: z.boolean().default(false),
});
export type LabelSheetInput = z.infer<typeof labelSheetSchema>;
