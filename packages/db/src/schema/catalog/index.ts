import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgSchema,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { primaryId, timestamps } from '../columns.js';
import { fileObjects } from '../files/index.js';
import { organizations } from '../org/index.js';

/**
 * The catalog (architecture §8 "Tables", M06).
 *
 * Categories, attributes and their values, products, SKUs as a variant matrix,
 * barcodes, a selling price with history, and images.
 *
 * ## The one thing this schema does not have
 *
 * **No purchase cost.** Not a `unit_cost_poisha`, not a `wac_poisha`, not a
 * "landed cost" for a margin badge on a product page. Invariant 5 puts cost in
 * supply, inventory and the ledger, and the catalog is the table set most likely
 * to acquire one by accident, because a product page is where somebody wants to
 * show margin. The reseller endpoint reads from here (§6's allow-list), so a
 * cost column added here reaches a reseller.
 *
 * `price_poisha` is the **selling** price and belongs here. The distinction is
 * enforced rather than trusted: `COST_FIELDS` in @elysium/contracts names every
 * cost-shaped column, `assertNoCostFields` checks every catalog response, and
 * `catalog.schema.test.ts` walks these table definitions and fails on a column
 * whose name matches a cost shape.
 *
 * Every foreign key between two tenant tables carries `org_id` on both sides
 * (D-047), against a `unique (org_id, id)` on the parent.
 */
export const catalog = pgSchema('catalog');

/** Kept in step with the domain's attribute kinds by a test. */
export const attributeKind = catalog.enum('attribute_kind', ['size', 'colour', 'custom']);

export const productStatus = catalog.enum('product_status', ['draft', 'active', 'archived']);

/** A SKU is archived, never deleted: M07's movements and M10's orders reference it. */
export const skuStatus = catalog.enum('sku_status', ['active', 'archived']);

/**
 * The per-org SKU counter and the org's SKU prefix.
 *
 * One row per org, and the reason it is a table rather than a Postgres sequence
 * is tenancy: a sequence is one global object, so the five brands would share a
 * numbering and `ELY-SHRT-0001` would exist in one brand and be skipped in
 * another. The counter is taken with a single `insert … on conflict do update …
 * returning`, never a select followed by an update — under concurrency the
 * read-then-write hands two products the same number and the second insert dies
 * on the unique index, which is a 500 on a product-create for no reason.
 *
 * `org_code` is the `{ORG}` segment of §8's pattern. It lives here rather than on
 * `org.organizations` because it is a catalog concern with catalog constraints
 * (upper-case, no separator) and because changing it must not silently renumber
 * anything — existing SKU codes are stored strings, not derived ones.
 */
export const skuSettings = catalog.table(
  'sku_settings',
  {
    orgId: uuid('org_id')
      .primaryKey()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    orgCode: text('org_code').notNull(),
    /** The highest sequence handed out so far. The next product takes this + 1. */
    lastSequence: integer('last_sequence').notNull().default(0),
    /**
     * The highest internal EAN-13 sequence handed out so far (M38a, D-603). A SKU created
     * without a supplier's barcode takes the next one, `2` + eleven digits + check digit.
     * Taken by the same one-statement upsert as `last_sequence`, never read then written.
     */
    lastBarcodeSequence: bigint('last_barcode_sequence', { mode: 'number' }).notNull().default(0),
    ...timestamps,
  },
  (table) => [
    index('sku_settings_org_idx').on(table.orgId),
    check('sku_settings_org_code_format', sql`${table.orgCode} ~ '^[A-Z0-9]{2,8}$'`),
    check('sku_settings_sequence_not_negative', sql`${table.lastSequence} >= 0`),
    check(
      'sku_settings_barcode_sequence_range',
      sql`${table.lastBarcodeSequence} between 0 and 99999999999`,
    ),
  ],
);

/**
 * The category tree.
 *
 * `parent_id` plus a materialised `path` of slugs. The path is redundant and
 * kept anyway: a breadcrumb and a "everything under Menswear" filter are both
 * recursive queries otherwise, on every product list render. A trigger maintains
 * it, and the same trigger refuses a cycle — a parent chain that loops turns any
 * recursive read into a hang rather than an error.
 *
 * `code` is the `{CAT}` segment of a SKU code (§8). Short, upper-case, no
 * separator, because it ends up inside a dash-delimited string.
 */
export const categories = catalog.table(
  'categories',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    parentId: uuid('parent_id'),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    /** The SKU code segment, e.g. `SHRT`. */
    code: text('code').notNull(),
    /** `/menswear/shirts`, maintained by a trigger. */
    path: text('path').notNull().default(''),
    depth: integer('depth').notNull().default(0),
    position: integer('position').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    /*
     * The website's fields (M33, D-501). `web_visible` is separate from `is_active`: a
     * category the desk still files products under can be left off the website's menu and
     * shop filters. `gender` drives the old site's men/women/kids shelves; `featured`, its
     * home-page category grid.
     */
    webVisible: boolean('web_visible').notNull().default(true),
    featured: boolean('featured').notNull().default(false),
    gender: text('gender'),
    description: text('description'),
    imageFileId: uuid('image_file_id'),
    ...timestamps,
  },
  (table) => [
    unique('categories_org_id_id_key').on(table.orgId, table.id),
    index('categories_org_idx').on(table.orgId),
    index('categories_org_parent_idx').on(table.orgId, table.parentId),
    index('categories_org_path_idx').on(table.orgId, table.path),
    // Siblings, not the whole org: two brands' "Shirts" under different parents
    // is ordinary, and forcing org-wide unique slugs would make a deep tree
    // unusable. `coalesce` because NULL parents do not compare equal in a
    // unique index, so a unique index on (org_id, parent_id, slug) would let
    // every root category share a slug.
    uniqueIndex('categories_org_parent_slug_idx').on(
      table.orgId,
      sql`coalesce(${table.parentId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
      table.slug,
    ),
    uniqueIndex('categories_org_code_idx').on(table.orgId, table.code),
    foreignKey({
      name: 'categories_org_id_parent_id_fk',
      columns: [table.orgId, table.parentId],
      foreignColumns: [table.orgId, table.id],
    }).onDelete('restrict'),
    check(
      'categories_not_self_parent',
      sql`${table.parentId} is null or ${table.parentId} <> ${table.id}`,
    ),
    check('categories_code_format', sql`${table.code} ~ '^[A-Z0-9]{1,8}$'`),
    check('categories_slug_format', sql`${table.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`),
    check('categories_name_length', sql`length(${table.name}) between 1 and 120`),
    // Four levels is deep enough for any fashion catalogue and shallow enough
    // that the path stays readable on a label.
    check('categories_depth_bounded', sql`${table.depth} between 0 and 3`),
    foreignKey({
      name: 'categories_org_id_image_file_id_fk',
      columns: [table.orgId, table.imageFileId],
      foreignColumns: [fileObjects.orgId, fileObjects.id],
    }).onDelete('restrict'),
    check(
      'categories_gender',
      sql`${table.gender} is null or ${table.gender} in ('men', 'women', 'kids', 'unisex')`,
    ),
    check(
      'categories_description_length',
      sql`${table.description} is null or length(${table.description}) <= 2000`,
    ),
  ],
);

/** An attribute: size, colour, or anything an org invents. */
export const attributes = catalog.table(
  'attributes',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    /** Stable, upper-case: referenced by CSV headers and by the console. */
    code: text('code').notNull(),
    name: text('name').notNull(),
    kind: attributeKind('kind').notNull().default('custom'),
    /**
     * Whether this attribute is an axis of the variant matrix.
     *
     * Not every attribute is: "fabric: cotton" describes a product and does not
     * multiply its SKUs. A non-variant attribute that silently became an axis
     * would turn one product into fifteen.
     */
    isVariant: boolean('is_variant').notNull().default(true),
    position: integer('position').notNull().default(0),
    /**
     * Archived lists are hidden from the new-product form and "Add sizes or colours" (M39a,
     * D-624); the variants that already carry one keep showing its name. A list nothing uses
     * is deleted instead.
     */
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps,
  },
  (table) => [
    unique('attributes_org_id_id_key').on(table.orgId, table.id),
    index('attributes_org_idx').on(table.orgId),
    uniqueIndex('attributes_org_code_idx').on(table.orgId, table.code),
    check('attributes_code_format', sql`${table.code} ~ '^[A-Z][A-Z0-9_]{0,31}$'`),
    check('attributes_name_length', sql`length(${table.name}) between 1 and 60`),
  ],
);

export const attributeValues = catalog.table(
  'attribute_values',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    attributeId: uuid('attribute_id').notNull(),
    /** The SKU code segment this value contributes, e.g. `RED`, `XXL`. */
    code: text('code').notNull(),
    label: text('label').notNull(),
    /**
     * Sort order. Sizes are the reason this is explicit rather than
     * alphabetical: S, M, L, XL sorts to L, M, S, XL, which is wrong on every
     * screen and every label sheet.
     */
    position: integer('position').notNull().default(0),
    /**
     * An archived value (a size no longer made) cannot go on a new variant; the variants that
     * carry it keep it, on screens and stickers (M39a, D-624).
     */
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps,
  },
  (table) => [
    unique('attribute_values_org_id_id_key').on(table.orgId, table.id),
    index('attribute_values_org_idx').on(table.orgId),
    index('attribute_values_org_attribute_idx').on(table.orgId, table.attributeId),
    uniqueIndex('attribute_values_org_attribute_code_idx').on(
      table.orgId,
      table.attributeId,
      table.code,
    ),
    foreignKey({
      name: 'attribute_values_org_id_attribute_id_fk',
      columns: [table.orgId, table.attributeId],
      foreignColumns: [attributes.orgId, attributes.id],
    }).onDelete('restrict'),
    check('attribute_values_code_format', sql`${table.code} ~ '^[A-Z0-9]{1,8}$'`),
    check('attribute_values_label_length', sql`length(${table.label}) between 1 and 60`),
  ],
);

export const products = catalog.table(
  'products',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    categoryId: uuid('category_id'),
    /**
     * The per-org sequence number in this product's SKU codes.
     *
     * Taken once, at creation, and never changed — the codes derived from it are
     * printed on labels and stored as strings, so renumbering the product would
     * make them disagree with the row. A trigger refuses an update.
     */
    sequence: integer('sequence').notNull(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    description: text('description'),
    status: productStatus('status').notNull().default('draft'),
    /*
     * The website's fields (M33, D-500).
     *
     * `web_visible` is separate from `status` on purpose: an active product can be sold at
     * the till and the desk without being on the website, and it is off until somebody
     * puts it there. The storefront shows a product only when it is both active and web
     * visible. `previous_slugs` is written by the M33 trigger whenever `slug` changes, never
     * by the service: an old address that answers a redirect is the one thing a rename
     * must not lose. `size_chart_id` points at `storefront.size_charts` through a composite
     * foreign key declared in the M33 migration (see that schema file for why not here).
     */
    webVisible: boolean('web_visible').notNull().default(false),
    featured: boolean('featured').notNull().default(false),
    newArrival: boolean('new_arrival').notNull().default(false),
    gender: text('gender'),
    material: text('material'),
    careInstructions: text('care_instructions'),
    tags: text('tags')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    sizeChartId: uuid('size_chart_id'),
    seoTitle: text('seo_title'),
    seoDescription: text('seo_description'),
    previousSlugs: text('previous_slugs')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /**
     * What `pg_trgm` searches: the name, the slug and every SKU code, joined.
     *
     * A column rather than an expression index, because the SKU codes are in
     * another table and a trigram index cannot span a join. Maintained by a
     * trigger on both tables, so it cannot fall behind a rename.
     */
    searchText: text('search_text').notNull().default(''),
    createdBy: text('created_by'),
    ...timestamps,
  },
  (table) => [
    unique('products_org_id_id_key').on(table.orgId, table.id),
    index('products_org_idx').on(table.orgId),
    index('products_org_status_idx').on(table.orgId, table.status),
    index('products_org_category_idx').on(table.orgId, table.categoryId),
    uniqueIndex('products_org_sequence_idx').on(table.orgId, table.sequence),
    uniqueIndex('products_org_slug_idx').on(table.orgId, table.slug),
    foreignKey({
      name: 'products_org_id_category_id_fk',
      columns: [table.orgId, table.categoryId],
      foreignColumns: [categories.orgId, categories.id],
    }).onDelete('restrict'),
    check('products_sequence_positive', sql`${table.sequence} >= 1`),
    check('products_name_length', sql`length(${table.name}) between 1 and 200`),
    check('products_slug_format', sql`${table.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`),
    // 20,000 since M33 (D-500): the old site's descriptions are long, plain text.
    check(
      'products_description_length',
      sql`${table.description} is null or length(${table.description}) <= 20000`,
    ),
    index('products_org_web_idx')
      .on(table.orgId, table.createdAt)
      .where(sql`${table.webVisible} and ${table.status} = 'active'`),
    index('products_previous_slugs_idx').using('gin', table.previousSlugs),
    index('products_tags_idx').using('gin', table.tags),
    check(
      'products_gender',
      sql`${table.gender} is null or ${table.gender} in ('men', 'women', 'kids', 'unisex')`,
    ),
    check(
      'products_material_length',
      sql`${table.material} is null or length(${table.material}) <= 200`,
    ),
    check(
      'products_care_length',
      sql`${table.careInstructions} is null or length(${table.careInstructions}) <= 2000`,
    ),
    check(
      'products_tags_bounded',
      sql`cardinality(${table.tags}) <= 30
        and array_to_string(${table.tags}, ',') = lower(array_to_string(${table.tags}, ','))`,
    ),
    check(
      'products_seo_length',
      sql`(${table.seoTitle} is null or length(${table.seoTitle}) <= 120)
        and (${table.seoDescription} is null or length(${table.seoDescription}) <= 320)`,
    ),
    check('products_previous_slugs_bounded', sql`cardinality(${table.previousSlugs}) <= 20`),
  ],
);

/**
 * One SKU: one cell of a product's variant matrix.
 *
 * `variant_key` is the canonical identity of the combination, built by
 * `variantKey()` in @elysium/domain — attribute/value pairs sorted by attribute
 * id. It is what makes check 1 enforceable by the database rather than only by
 * the service: unique per (org, product), so a second attempt to create a
 * variant that already exists is refused whoever makes it, and the matrix can
 * only ever be extended.
 */
export const skus = catalog.table(
  'skus',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    productId: uuid('product_id').notNull(),
    /** `ELY-SHRT-0001-RED-M`. Unique per org, never globally (D-002). */
    code: text('code').notNull(),
    variantKey: text('variant_key').notNull(),
    /**
     * What a scanner reads. An internal EAN-13 (`2…`) assigned when the SKU is created
     * (M38a, D-603), or a supplier's own barcode; null only on a SKU from before M38a that
     * the backfill could not number.
     */
    barcode: text('barcode'),
    /** The **selling** price. Never a cost (invariant 5). */
    pricePoisha: bigint('price_poisha', { mode: 'bigint' }).notNull(),
    status: skuStatus('status').notNull().default('active'),
    position: integer('position').notNull().default(0),
    ...timestamps,
  },
  (table) => [
    unique('skus_org_id_id_key').on(table.orgId, table.id),
    index('skus_org_idx').on(table.orgId),
    index('skus_org_product_idx').on(table.orgId, table.productId),
    uniqueIndex('skus_org_code_idx').on(table.orgId, table.code),
    uniqueIndex('skus_org_product_variant_idx').on(table.orgId, table.productId, table.variantKey),
    uniqueIndex('skus_org_barcode_idx')
      .on(table.orgId, table.barcode)
      .where(sql`${table.barcode} is not null`),
    foreignKey({
      name: 'skus_org_id_product_id_fk',
      columns: [table.orgId, table.productId],
      foreignColumns: [products.orgId, products.id],
    }).onDelete('restrict'),
    check(
      'skus_code_format',
      sql`${table.code} ~ '^[A-Z0-9]+(-[A-Z0-9]+)*$' and length(${table.code}) <= 64`,
    ),
    check('skus_price_positive', sql`${table.pricePoisha} > 0`),
    check('skus_price_bounded', sql`${table.pricePoisha} <= 9000000000000000`),
    check(
      'skus_barcode_printable_ascii',
      // `[ -~]` rather than `[\x20-\x7e]`: a literal range needs no escape
      // processing, so it means the same thing whatever the server's
      // `standard_conforming_strings` and regex flavour happen to be.
      sql`${table.barcode} is null or ${table.barcode} ~ '^[ -~]{1,48}$'`,
    ),
  ],
);

/** Which attribute value each SKU carries on each axis. */
export const skuValues = catalog.table(
  'sku_values',
  {
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    skuId: uuid('sku_id').notNull(),
    attributeId: uuid('attribute_id').notNull(),
    valueId: uuid('value_id').notNull(),
  },
  (table) => [
    // One value per axis per SKU, which is what makes the matrix a matrix.
    uniqueIndex('sku_values_pk').on(table.orgId, table.skuId, table.attributeId),
    index('sku_values_org_idx').on(table.orgId),
    index('sku_values_org_value_idx').on(table.orgId, table.valueId),
    foreignKey({
      name: 'sku_values_org_id_sku_id_fk',
      columns: [table.orgId, table.skuId],
      foreignColumns: [skus.orgId, skus.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'sku_values_org_id_attribute_id_fk',
      columns: [table.orgId, table.attributeId],
      foreignColumns: [attributes.orgId, attributes.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'sku_values_org_id_value_id_fk',
      columns: [table.orgId, table.valueId],
      foreignColumns: [attributeValues.orgId, attributeValues.id],
    }).onDelete('restrict'),
  ],
);

/**
 * Every selling price a SKU has ever had (M06: "a selling price per SKU, with
 * price history").
 *
 * Append-only, and written by a **trigger** on `skus` rather than by the service.
 * A service that writes both can forget one — and the row it forgets is the
 * evidence for "why is this shirt ৳300 cheaper than last week", which is asked
 * exactly when nobody remembers. The trigger means a price cannot change without
 * a history row, including from a repair script.
 */
export const skuPriceHistory = catalog.table(
  'sku_price_history',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    skuId: uuid('sku_id').notNull(),
    /** Null on the first row: there was no price before. */
    fromPoisha: bigint('from_poisha', { mode: 'bigint' }),
    toPoisha: bigint('to_poisha', { mode: 'bigint' }).notNull(),
    /** The Asia/Dhaka business date the change took effect (invariant 8). */
    changedBy: text('changed_by'),
    reason: text('reason'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    index('sku_price_history_org_idx').on(table.orgId),
    index('sku_price_history_org_sku_idx').on(table.orgId, table.skuId, table.createdAt),
    /*
     * Cascade since M39a (D-627): a SKU nothing else references (a variant added by mistake)
     * may be deleted, and its price history goes with it. `erp_app` still holds no DELETE on
     * this table, and the M39a policies migration's trigger refuses a history row's delete
     * while its SKU exists, so the cascade is the only way a row leaves.
     */
    foreignKey({
      name: 'sku_price_history_org_id_sku_id_fk',
      columns: [table.orgId, table.skuId],
      foreignColumns: [skus.orgId, skus.id],
    }).onDelete('cascade'),
    check('sku_price_history_to_positive', sql`${table.toPoisha} > 0`),
    check(
      'sku_price_history_changed',
      sql`${table.fromPoisha} is null or ${table.fromPoisha} <> ${table.toPoisha}`,
    ),
    check(
      'sku_price_history_reason_length',
      sql`${table.reason} is null or length(${table.reason}) <= 200`,
    ),
  ],
);

/**
 * A product's images, ordered.
 *
 * A row per (product, file) rather than an array on the product, because §22's
 * files are rows with their own lifecycle: a `pending` upload that never
 * completed must not appear on a product page, and that is a join, not a JSON
 * array. `position` carries the ordering the console drag-and-drop writes.
 */
export const productImages = catalog.table(
  'product_images',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    productId: uuid('product_id').notNull(),
    fileId: uuid('file_id').notNull(),
    position: integer('position').notNull().default(0),
    altText: text('alt_text'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    unique('product_images_org_id_id_key').on(table.orgId, table.id),
    index('product_images_org_idx').on(table.orgId),
    index('product_images_org_product_idx').on(table.orgId, table.productId, table.position),
    uniqueIndex('product_images_org_product_file_idx').on(
      table.orgId,
      table.productId,
      table.fileId,
    ),
    foreignKey({
      name: 'product_images_org_id_product_id_fk',
      columns: [table.orgId, table.productId],
      foreignColumns: [products.orgId, products.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'product_images_org_id_file_id_fk',
      columns: [table.orgId, table.fileId],
      foreignColumns: [fileObjects.orgId, fileObjects.id],
    }).onDelete('restrict'),
    check('product_images_position_not_negative', sql`${table.position} >= 0`),
    check(
      'product_images_alt_length',
      sql`${table.altText} is null or length(${table.altText}) <= 200`,
    ),
  ],
);
