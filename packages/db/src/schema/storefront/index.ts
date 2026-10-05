import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  customType,
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
import { orderAdvances } from '../advances/index.js';
import { customers, orders } from '../orders/index.js';
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

// --- M34: buying on the website ------------------------------------------------------------

/**
 * AES-256-GCM ciphertext (`[iv][tag][ciphertext]`), as the courier's credentials are kept
 * (§25). Sealed and opened only by the server's `sealed-box.ts` under
 * `STOREFRONT_CREDENTIALS_KEY` (D-528), bound to the row it belongs to.
 */
export const sealedBytes = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
  fromDriver: (value) => Buffer.from(value as unknown as Uint8Array),
  toDriver: (value) => value,
});

/**
 * A shopper's website account (D-522): one per email address per brand.
 *
 * Linked to the brand's buyer (`sales.customers`) by phone when it has one, so the desk sees
 * the account on the buyer's profile; the account's orders are the website orders placed
 * through it (`web_orders.account_id`), never the desk's orders for the same phone, which an
 * unverified phone number must not reveal.
 *
 * `password_hash` is bcrypt (cost 12; the old site's hashes are imported unchanged by the
 * optional customer import, D-531, so its shoppers keep their passwords) and null for an
 * account that signs in with Google only. `google_sub` is Google's stable id, set only for an
 * account whose email was verified (D-522).
 */
export const customerAccounts = storefront.table(
  'customer_accounts',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    /** Lower case, trimmed (`normaliseEmail`). */
    email: text('email').notNull(),
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true, mode: 'date' }),
    passwordHash: text('password_hash'),
    googleSub: text('google_sub'),
    name: text('name').notNull(),
    /** E.164, as `sales.customers` keys a buyer. */
    phoneE164: text('phone_e164'),
    customerId: uuid('customer_id'),
    locale: text('locale').notNull().default('bn'),
    /** Saved delivery addresses, `savedAddressSchema` each, at most ten. */
    addresses: jsonb('addresses').notNull().default([]),
    lastSignInAt: timestamp('last_sign_in_at', { withTimezone: true, mode: 'date' }),
    /** Where the account came from: `website`, `google` or `legacy_import` (D-531). */
    source: text('source').notNull().default('website'),
    ...timestamps,
  },
  (table) => [
    unique('customer_accounts_org_id_id_key').on(table.orgId, table.id),
    index('customer_accounts_org_idx').on(table.orgId),
    uniqueIndex('customer_accounts_org_email_idx').on(table.orgId, table.email),
    uniqueIndex('customer_accounts_org_google_idx')
      .on(table.orgId, table.googleSub)
      .where(sql`${table.googleSub} is not null`),
    index('customer_accounts_org_customer_idx').on(table.orgId, table.customerId),
    index('customer_accounts_org_phone_idx').on(table.orgId, table.phoneE164),
    foreignKey({
      name: 'customer_accounts_org_id_customer_id_fk',
      columns: [table.orgId, table.customerId],
      foreignColumns: [customers.orgId, customers.id],
    }).onDelete('restrict'),
    check(
      'customer_accounts_email_shape',
      sql`${table.email} = lower(btrim(${table.email}))
          and ${table.email} ~ '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$'
          and length(${table.email}) <= 254`,
    ),
    check(
      'customer_accounts_password_hash_shape',
      sql`${table.passwordHash} is null
          or ${table.passwordHash} ~ '^[$]2[aby][$][0-9]{2}[$][./A-Za-z0-9]{53}$'`,
    ),
    // Something to sign in with: a password, or a Google login. An account imported from the
    // old site without a password (a Google sign-up there) links Google on first use (D-531).
    check(
      'customer_accounts_can_sign_in',
      sql`${table.passwordHash} is not null or ${table.googleSub} is not null
          or ${table.source} = 'legacy_import'`,
    ),
    // Google is linked only to a verified address (D-522).
    check(
      'customer_accounts_google_verified',
      sql`${table.googleSub} is null or ${table.emailVerifiedAt} is not null`,
    ),
    check(
      'customer_accounts_phone_shape',
      sql`${table.phoneE164} is null or ${table.phoneE164} ~ '^[+]8801[3-9][0-9]{8}$'`,
    ),
    check('customer_accounts_name_length', sql`length(${table.name}) between 1 and 120`),
    check('customer_accounts_locale', sql`${table.locale} in ('bn', 'en')`),
    check(
      'customer_accounts_addresses_array',
      sql`jsonb_typeof(${table.addresses}) = 'array' and jsonb_array_length(${table.addresses}) <= 10`,
    ),
    check(
      'customer_accounts_source',
      sql`${table.source} in ('website', 'google', 'legacy_import')`,
    ),
  ],
);

/**
 * One-time email codes and password-reset links (D-522), **hashed**.
 *
 * A six-digit code is stored as `HMAC-SHA256(server key, purpose:account:code)` — a plain hash
 * of a million possibilities is a lookup table — and a reset link's 32 random bytes as their
 * SHA-256. Fifteen minutes and five tries for a code, an hour for a link; a new one of a
 * purpose consumes the older ones. Kept, never deleted, so the resend limit can count them.
 */
export const accountCodes = storefront.table(
  'account_codes',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    accountId: uuid('account_id').notNull(),
    purpose: text('purpose').notNull(),
    codeHash: text('code_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    attempts: integer('attempts').notNull().default(0),
    consumedAt: timestamp('consumed_at', { withTimezone: true, mode: 'date' }),
    ...timestamps,
  },
  (table) => [
    unique('account_codes_org_id_id_key').on(table.orgId, table.id),
    index('account_codes_org_idx').on(table.orgId),
    index('account_codes_org_account_idx').on(table.orgId, table.accountId, table.purpose),
    uniqueIndex('account_codes_org_hash_idx').on(table.orgId, table.purpose, table.codeHash),
    foreignKey({
      name: 'account_codes_org_id_account_id_fk',
      columns: [table.orgId, table.accountId],
      foreignColumns: [customerAccounts.orgId, customerAccounts.id],
    }).onDelete('restrict'),
    check('account_codes_purpose', sql`${table.purpose} in ('verify_email', 'reset_password')`),
    check('account_codes_hash_shape', sql`${table.codeHash} ~ '^[0-9a-f]{64}$'`),
    check('account_codes_attempts', sql`${table.attempts} between 0 and 100`),
  ],
);

/**
 * The website's record of an order it placed (D-521, D-524): which account, which email to
 * write to, in which language, and how the shopper chose to pay. The order itself is the
 * orders module's (`channel = website`); this is the storefront's side of it.
 */
export const webOrders = storefront.table(
  'web_orders',
  {
    orderId: uuid('order_id').notNull(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    accountId: uuid('account_id'),
    /** The address the checkout gave (normalised), for its emails and for claiming. */
    email: text('email'),
    locale: text('locale').notNull().default('bn'),
    paymentMethod: text('payment_method').notNull(),
    /** For claiming by phone, without reading the orders module's table (invariant 12). */
    phoneE164: text('phone_e164').notNull(),
    ...timestamps,
  },
  (table) => [
    primaryKey({ name: 'web_orders_pkey', columns: [table.orgId, table.orderId] }),
    index('web_orders_org_idx').on(table.orgId),
    index('web_orders_org_account_idx').on(table.orgId, table.accountId, table.createdAt),
    index('web_orders_org_email_idx').on(table.orgId, table.email),
    index('web_orders_org_phone_idx').on(table.orgId, table.phoneE164),
    foreignKey({
      name: 'web_orders_org_id_order_id_fk',
      columns: [table.orgId, table.orderId],
      foreignColumns: [orders.orgId, orders.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'web_orders_org_id_account_id_fk',
      columns: [table.orgId, table.accountId],
      foreignColumns: [customerAccounts.orgId, customerAccounts.id],
    }).onDelete('restrict'),
    check('web_orders_payment_method', sql`${table.paymentMethod} in ('cod', 'sslcommerz')`),
    check('web_orders_locale', sql`${table.locale} in ('bn', 'en')`),
    check('web_orders_phone_shape', sql`${table.phoneE164} ~ '^[+]8801[3-9][0-9]{8}$'`),
  ],
);

/**
 * Order view tokens (D-524): 32 random bytes the shopper's link carries, stored as their
 * SHA-256. One from the checkout for the confirmation page, one per order email. Read-only
 * access to the shopper's view of one order and nothing else.
 */
export const orderViewTokens = storefront.table(
  'order_view_tokens',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    orderId: uuid('order_id').notNull(),
    tokenSha256: text('token_sha256').notNull(),
    purpose: text('purpose').notNull(),
    ...timestamps,
  },
  (table) => [
    unique('order_view_tokens_org_id_id_key').on(table.orgId, table.id),
    index('order_view_tokens_org_idx').on(table.orgId),
    uniqueIndex('order_view_tokens_org_hash_idx').on(table.orgId, table.tokenSha256),
    index('order_view_tokens_org_order_idx').on(table.orgId, table.orderId),
    foreignKey({
      name: 'order_view_tokens_org_id_order_id_fk',
      columns: [table.orgId, table.orderId],
      foreignColumns: [webOrders.orgId, webOrders.orderId],
    }).onDelete('restrict'),
    check('order_view_tokens_hash_shape', sql`${table.tokenSha256} ~ '^[0-9a-f]{64}$'`),
    check('order_view_tokens_purpose', sql`${table.purpose} in ('confirmation', 'email')`),
  ],
);

/**
 * A checkout's idempotency key (D-521): written first in the checkout's own transaction, so a
 * second copy of the same request waits on the unique index and then finds the first one's
 * order; a checkout that fails rolls its key back with it.
 */
export const checkoutSubmissions = storefront.table(
  'checkout_submissions',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    siteKeyId: uuid('site_key_id').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    requestSha256: text('request_sha256').notNull(),
    orderId: uuid('order_id'),
    ...timestamps,
  },
  (table) => [
    unique('checkout_submissions_org_id_id_key').on(table.orgId, table.id),
    index('checkout_submissions_org_idx').on(table.orgId),
    uniqueIndex('checkout_submissions_org_key_idx').on(
      table.orgId,
      table.siteKeyId,
      table.idempotencyKey,
    ),
    foreignKey({
      name: 'checkout_submissions_org_id_site_key_id_fk',
      columns: [table.orgId, table.siteKeyId],
      foreignColumns: [storefrontSiteKeys.orgId, storefrontSiteKeys.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'checkout_submissions_org_id_order_id_fk',
      columns: [table.orgId, table.orderId],
      foreignColumns: [orders.orgId, orders.id],
    }).onDelete('restrict'),
    check('checkout_submissions_key_shape', sql`${table.idempotencyKey} ~ '^[!-~]{8,255}$'`),
    check('checkout_submissions_sha_shape', sql`${table.requestSha256} ~ '^[0-9a-f]{64}$'`),
  ],
);

/**
 * The brand's SSLCommerz account (D-528): the store id in the clear (it is printed on the
 * gateway's pages), the store password sealed. One row per brand; switched off, not deleted.
 */
export const gatewaySettings = storefront.table(
  'gateway_settings',
  {
    orgId: uuid('org_id')
      .primaryKey()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    provider: text('provider').notNull().default('sslcommerz'),
    enabled: boolean('enabled').notNull().default(false),
    mode: text('mode').notNull().default('sandbox'),
    storeId: text('store_id').notNull(),
    passwordSealed: sealedBytes('password_sealed').notNull(),
    keyId: text('key_id').notNull(),
    /** First 12 hex of the password's SHA-256: "is this the one I set", never the secret. */
    fingerprint: text('fingerprint').notNull(),
    updatedBy: text('updated_by').notNull(),
    ...timestamps,
  },
  (table) => [
    index('gateway_settings_org_idx').on(table.orgId),
    check('gateway_settings_provider', sql`${table.provider} in ('sslcommerz')`),
    check('gateway_settings_mode', sql`${table.mode} in ('sandbox', 'live')`),
    check('gateway_settings_store_id_length', sql`length(${table.storeId}) between 1 and 30`),
    check('gateway_settings_fingerprint_shape', sql`${table.fingerprint} ~ '^[0-9a-f]{12}$'`),
  ],
);

/**
 * One SSLCommerz session for an order (D-525, D-527).
 *
 * `initiating` while the worker opens it, `ready` with the gateway page, `failed` when the
 * gateway refused; `validating` once a return or the IPN named a `val_id`; then `paid`
 * (validated and booked as an advance), `refused` (validated but not acceptable: the amount,
 * the currency, the transaction — logged, for a person), `cancelled` (the shopper backed out or
 * it failed) or `expired` (unpaid at sixty minutes). `tran_id` is ours, random and unguessable;
 * `val_id` is SSLCommerz's, unique once paid.
 */
export const paymentSessions = storefront.table(
  'payment_sessions',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    orderId: uuid('order_id').notNull(),
    provider: text('provider').notNull().default('sslcommerz'),
    mode: text('mode').notNull(),
    tranId: text('tran_id').notNull(),
    amountPoisha: bigint('amount_poisha', { mode: 'bigint' }).notNull(),
    status: text('status').notNull().default('initiating'),
    gatewayUrl: text('gateway_url'),
    sessionKey: text('session_key'),
    valId: text('val_id'),
    validatedAmountPoisha: bigint('validated_amount_poisha', { mode: 'bigint' }),
    cardType: text('card_type'),
    bankTranId: text('bank_tran_id'),
    risky: boolean('risky').notNull().default(false),
    /** Why it failed or was refused, as a token (`amount_mismatch`), never the gateway's prose. */
    failureReason: text('failure_reason'),
    advanceId: uuid('advance_id'),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    settledAt: timestamp('settled_at', { withTimezone: true, mode: 'date' }),
    ...timestamps,
  },
  (table) => [
    unique('payment_sessions_org_id_id_key').on(table.orgId, table.id),
    index('payment_sessions_org_idx').on(table.orgId),
    index('payment_sessions_org_order_idx').on(table.orgId, table.orderId),
    uniqueIndex('payment_sessions_tran_id_idx').on(table.tranId),
    uniqueIndex('payment_sessions_org_val_id_idx')
      .on(table.orgId, table.valId)
      .where(sql`${table.status} = 'paid'`),
    foreignKey({
      name: 'payment_sessions_org_id_order_id_fk',
      columns: [table.orgId, table.orderId],
      foreignColumns: [webOrders.orgId, webOrders.orderId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'payment_sessions_org_id_advance_id_fk',
      columns: [table.orgId, table.advanceId],
      foreignColumns: [orderAdvances.orgId, orderAdvances.id],
    }).onDelete('restrict'),
    check('payment_sessions_provider', sql`${table.provider} in ('sslcommerz')`),
    check('payment_sessions_mode', sql`${table.mode} in ('sandbox', 'live')`),
    check('payment_sessions_tran_id_shape', sql`${table.tranId} ~ '^[A-Z0-9]{20,30}$'`),
    check(
      'payment_sessions_amount',
      sql`${table.amountPoisha} > 0 and ${table.amountPoisha} <= 9000000000000000`,
    ),
    check(
      'payment_sessions_status',
      sql`${table.status} in ('initiating', 'ready', 'failed', 'validating', 'paid', 'refused', 'cancelled', 'expired')`,
    ),
    // Paid means validated, for the session's amount, and booked as an advance.
    check(
      'payment_sessions_paid_complete',
      sql`(${table.status} = 'paid') = (${table.advanceId} is not null)
          and (${table.status} <> 'paid' or (${table.valId} is not null
               and ${table.validatedAmountPoisha} = ${table.amountPoisha}))`,
    ),
  ],
);
