import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { primaryId, timestamps } from '../columns.js';
import { categories } from '../catalog/index.js';
import { fileObjects } from '../files/index.js';
import { locations, organizations } from '../org/index.js';

/**
 * The brand's website, run from its ERP (M33, architecture §31, D-500 to D-519).
 *
 * The website has no database of its own any more (D-469). What it shows that is not the
 * catalog lives here: one settings row per brand, the hero slides, the menu, the size
 * charts, the old site's ids, and the keys the website's server signs its reads with.
 *
 * Every table is a tenant table with the full treatment (invariant 4): `org_id NOT NULL`, RLS
 * ENABLE and FORCE from `tenantTableSql()` in the M33 policies migration, and every foreign
 * key to another tenant table carrying `org_id` on both sides (D-047).
 *
 * `catalog.products.size_chart_id` points at `size_charts` with a composite foreign key
 * declared in that migration rather than in the catalog's Drizzle file: this file imports
 * the catalog for the menu's categories, and a declaration there would make the two schema
 * files import each other.
 *
 * Nothing here is cost-shaped. The website reads the catalog's selling price and never a
 * purchase cost (invariant 5); the storefront API's allow-list is the second fence.
 */
export const storefront = pgSchema('storefront');

/**
 * One row per brand: the website's settings, by section (D-503).
 *
 * The sections are JSON documents because each is a small, fixed form the console edits as
 * a whole and the website reads as a whole; their shapes are `@elysium/contracts`'
 * `storefront.ts` schemas, checked on every write and parsed defensively on every read. A
 * column per field would be forty columns and a migration per new toggle. The two things
 * that point at other rows are columns, so they can carry foreign keys: the logo, and the
 * stock locations (`web_locations`).
 *
 * No row means the defaults: the website still answers, with the brand's name and the
 * brand's main warehouse.
 */
export const storefrontSettings = storefront.table(
  'settings',
  {
    orgId: uuid('org_id')
      .primaryKey()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    siteName: text('site_name').notNull(),
    logoFileId: uuid('logo_file_id'),
    siteInfo: jsonb('site_info').notNull().default({}),
    social: jsonb('social').notNull().default({}),
    announcement: jsonb('announcement').notNull().default({}),
    promoBanner: jsonb('promo_banner').notNull().default({}),
    testimonials: jsonb('testimonials').notNull().default([]),
    shipping: jsonb('shipping').notNull().default({}),
    payments: jsonb('payments').notNull().default({}),
    updatedBy: text('updated_by'),
    ...timestamps,
  },
  (table) => [
    index('storefront_settings_org_idx').on(table.orgId),
    foreignKey({
      name: 'storefront_settings_org_id_logo_file_id_fk',
      columns: [table.orgId, table.logoFileId],
      foreignColumns: [fileObjects.orgId, fileObjects.id],
    }).onDelete('restrict'),
    check('storefront_settings_site_name_length', sql`length(${table.siteName}) between 1 and 120`),
    check(
      'storefront_settings_shapes',
      sql`jsonb_typeof(${table.siteInfo}) = 'object' and jsonb_typeof(${table.social}) = 'object'
        and jsonb_typeof(${table.announcement}) = 'object' and jsonb_typeof(${table.promoBanner}) = 'object'
        and jsonb_typeof(${table.testimonials}) = 'array' and jsonb_typeof(${table.shipping}) = 'object'
        and jsonb_typeof(${table.payments}) = 'object'`,
    ),
    // Each section is a small form; anything near this size is not one.
    check(
      'storefront_settings_bounded',
      sql`pg_column_size(${table.siteInfo}) + pg_column_size(${table.social})
        + pg_column_size(${table.announcement}) + pg_column_size(${table.promoBanner})
        + pg_column_size(${table.testimonials}) + pg_column_size(${table.shipping})
        + pg_column_size(${table.payments}) < 65536`,
    ),
  ],
);

/**
 * Where the website's stock is sold from (D-503): one or more of the brand's locations.
 *
 * A table rather than an array on `settings`, so each entry is a composite foreign key to a
 * real location of this brand — an id typed into an array could name another brand's
 * warehouse and nothing would refuse it.
 */
export const webLocations = storefront.table(
  'web_locations',
  {
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    locationId: uuid('location_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: 'web_locations_pk', columns: [table.orgId, table.locationId] }),
    index('web_locations_org_idx').on(table.orgId),
    foreignKey({
      name: 'web_locations_org_id_location_id_fk',
      columns: [table.orgId, table.locationId],
      foreignColumns: [locations.orgId, locations.id],
    }).onDelete('restrict'),
  ],
);

/**
 * The home page's slides (D-504): a desktop image (1920×750 on the old site), an optional
 * mobile one (750×1000), where it leads, and its place.
 */
export const heroSlides = storefront.table(
  'hero_slides',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    desktopFileId: uuid('desktop_file_id').notNull(),
    mobileFileId: uuid('mobile_file_id'),
    link: text('link').notNull().default('/'),
    altText: text('alt_text'),
    position: integer('position').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps,
  },
  (table) => [
    unique('hero_slides_org_id_id_key').on(table.orgId, table.id),
    index('hero_slides_org_idx').on(table.orgId),
    index('hero_slides_org_position_idx').on(table.orgId, table.position),
    foreignKey({
      name: 'hero_slides_org_id_desktop_file_id_fk',
      columns: [table.orgId, table.desktopFileId],
      foreignColumns: [fileObjects.orgId, fileObjects.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'hero_slides_org_id_mobile_file_id_fk',
      columns: [table.orgId, table.mobileFileId],
      foreignColumns: [fileObjects.orgId, fileObjects.id],
    }).onDelete('restrict'),
    check('hero_slides_link_length', sql`length(${table.link}) between 1 and 500`),
    check(
      'hero_slides_alt_length',
      sql`${table.altText} is null or length(${table.altText}) <= 200`,
    ),
    check('hero_slides_position_bounded', sql`${table.position} between 0 and 999`),
  ],
);

/**
 * The website's menu (D-504): links, category entries and dropdowns, two levels deep.
 *
 * A category entry names a catalog category, and the website expands it into that
 * category's subcategories (the old site's menu); a dropdown holds its own items. Depth and
 * "only a dropdown holds items" are the domain's `navProblems`, checked by the service; the
 * database refuses the shapes that would corrupt a read (an entry its own parent, a category
 * entry with no category).
 */
export const navItems = storefront.table(
  'nav_items',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    parentId: uuid('parent_id'),
    kind: text('kind').notNull(),
    label: text('label'),
    href: text('href'),
    categoryId: uuid('category_id'),
    highlighted: boolean('highlighted').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    position: integer('position').notNull().default(0),
    ...timestamps,
  },
  (table) => [
    unique('nav_items_org_id_id_key').on(table.orgId, table.id),
    index('nav_items_org_idx').on(table.orgId),
    index('nav_items_org_parent_idx').on(table.orgId, table.parentId, table.position),
    foreignKey({
      name: 'nav_items_org_id_parent_id_fk',
      columns: [table.orgId, table.parentId],
      foreignColumns: [table.orgId, table.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'nav_items_org_id_category_id_fk',
      columns: [table.orgId, table.categoryId],
      foreignColumns: [categories.orgId, categories.id],
    }).onDelete('restrict'),
    check('nav_items_kind', sql`${table.kind} in ('link', 'category', 'dropdown')`),
    check(
      'nav_items_not_self_parent',
      sql`${table.parentId} is null or ${table.parentId} <> ${table.id}`,
    ),
    check(
      'nav_items_category_has_category',
      sql`(${table.kind} = 'category') = (${table.categoryId} is not null)`,
    ),
    check('nav_items_link_has_href', sql`${table.kind} <> 'link' or ${table.href} is not null`),
    check(
      'nav_items_label_length',
      sql`${table.label} is null or length(${table.label}) between 1 and 60`,
    ),
    check(
      'nav_items_href_length',
      sql`${table.href} is null or length(${table.href}) between 1 and 500`,
    ),
    check('nav_items_position_bounded', sql`${table.position} between 0 and 999`),
  ],
);

/**
 * A size chart (D-502): headings and a grid of short strings, as the old site kept them.
 * A product points at one (`catalog.products.size_chart_id`).
 */
export const sizeCharts = storefront.table(
  'size_charts',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    columns: text('columns').array().notNull(),
    rows: jsonb('rows').notNull().default([]),
    ...timestamps,
  },
  (table) => [
    unique('size_charts_org_id_id_key').on(table.orgId, table.id),
    index('size_charts_org_idx').on(table.orgId),
    uniqueIndex('size_charts_org_name_idx').on(table.orgId, table.name),
    check('size_charts_name_length', sql`length(${table.name}) between 1 and 120`),
    check('size_charts_columns_bounded', sql`cardinality(${table.columns}) between 1 and 12`),
    check(
      'size_charts_rows_shape',
      sql`jsonb_typeof(${table.rows}) = 'array' and jsonb_array_length(${table.rows}) <= 60`,
    ),
  ],
);

/**
 * The old website's ids, against what they became here (D-505).
 *
 * Filled once by M36's importer and read by the redirects (an old product URL by Mongo id)
 * and by the marketplace connector (M35), which addresses variants by the old site's ids.
 * `erp_id` names a row in whichever table `kind` says, so it carries no foreign key; the
 * importer writes it in the transaction that creates that row.
 */
export const legacyIds = storefront.table(
  'legacy_ids',
  {
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    kind: text('kind').notNull(),
    legacyId: text('legacy_id').notNull(),
    erpId: uuid('erp_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: 'legacy_ids_pk', columns: [table.orgId, table.kind, table.legacyId] }),
    index('legacy_ids_org_idx').on(table.orgId),
    index('legacy_ids_org_erp_idx').on(table.orgId, table.kind, table.erpId),
    check(
      'legacy_ids_kind',
      sql`${table.kind} in ('product', 'variant', 'category', 'size_chart', 'customer', 'order',
        'discount', 'flash_sale', 'landing_page', 'custom_link')`,
    ),
    check('legacy_ids_legacy_id_shape', sql`${table.legacyId} ~ '^[!-~]{1,64}$'`),
  ],
);

/**
 * The keys the brand's website signs its reads with (D-506).
 *
 * The intake's site-key scheme (M11), with its own table and its own derivation label so a
 * website key cannot post a landing-page order and a landing page's key cannot read the
 * catalog. No secret is stored: the secret is `HMAC(master key, label + key id)`, recomputed
 * per request, and `secret_sha256` only notices a changed master key. Revoked, never
 * deleted.
 */
export const storefrontSiteKeys = storefront.table(
  'site_keys',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    label: text('label').notNull(),
    keyId: text('key_id').notNull(),
    secretSha256: text('secret_sha256').notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true, mode: 'date' }),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
    revokedBy: text('revoked_by'),
    createdBy: text('created_by').notNull(),
    ...timestamps,
  },
  (table) => [
    unique('storefront_site_keys_org_id_id_key').on(table.orgId, table.id),
    index('storefront_site_keys_org_idx').on(table.orgId),
    uniqueIndex('storefront_site_keys_key_id_idx').on(table.keyId),
    check('storefront_site_keys_label_length', sql`length(${table.label}) between 1 and 120`),
    check(
      'storefront_site_keys_key_id_format',
      sql`${table.keyId} ~ '^pk_[0-9a-f]{32}_[a-z2-7]{20}$'`,
    ),
    check(
      'storefront_site_keys_secret_sha256_format',
      sql`${table.secretSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'storefront_site_keys_revocation_complete',
      sql`(${table.revokedAt} is null) = (${table.revokedBy} is null)`,
    ),
  ],
);
