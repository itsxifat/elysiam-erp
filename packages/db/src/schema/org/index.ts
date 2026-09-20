import {
  boolean,
  index,
  integer,
  jsonb,
  pgSchema,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { districts, thanas } from '../ref/index.js';
import { primaryId, timestamps } from '../columns.js';

/**
 * Organizations, branches, locations, settings and feature flags
 * (architecture §3, §5).
 *
 * Everything here except `organizations` is tenant-scoped: `org_id NOT NULL`,
 * an index on it, and RLS with ENABLE and FORCE. The policies are not written
 * in this file — Drizzle cannot express them — but in the migration, generated
 * by `tenantTableSql()` so every table gets an identical one.
 */
export const org = pgSchema('org');

export const branchKind = org.enum('branch_kind', ['hq', 'showroom', 'warehouse']);

/** §8 needs `damaged` and `in_transit` as real places stock can sit. */
export const locationKind = org.enum('location_kind', [
  'warehouse',
  'showroom',
  'damaged',
  'in_transit',
]);

/**
 * The five sister brands. Global by design (§5 exception 5): the org list is
 * not itself tenant data, and which orgs a user may see is a membership
 * question that `iam` answers from M02a.
 */
export const organizations = org.table('organizations', {
  id: primaryId,
  /** Stable natural key. The seed is idempotent on this, not on a uuid. */
  slug: text('slug').notNull().unique(),
  legalName: text('legal_name').notNull(),
  displayName: text('display_name').notNull(),
  /**
   * Per-org branding (D-034): logo, dark logo, accent hue and chroma, legal
   * name, address, VAT number, invoice footer. Read by the console, portal and
   * POS to theme themselves, and by every document template in §22.
   */
  brand: jsonb('brand').notNull().default({}),
  /** Business dates are Asia/Dhaka calendar dates (invariant 8). */
  timezone: text('timezone').notNull().default('Asia/Dhaka'),
  isActive: boolean('is_active').notNull().default(true),
  ...timestamps,
});

export const branches = org.table(
  'branches',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    /** Unique within the org, and what appears on an order number prefix. */
    code: text('code').notNull(),
    name: text('name').notNull(),
    kind: branchKind('kind').notNull(),
    addressLine: text('address_line'),
    districtId: integer('district_id').references(() => districts.id),
    thanaId: integer('thana_id').references(() => thanas.id),
    phone: text('phone'),
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('branches_org_code_idx').on(table.orgId, table.code),
    index('branches_org_idx').on(table.orgId),
  ],
);

/**
 * A place that holds stock. Inventory movements reference these from M07.
 *
 * Kept in `org` rather than `inventory`: a location is a fact about an org's
 * physical footprint, which inventory then uses. Architecture §8 referred to
 * `inventory.locations`; corrected by D-046.
 */
export const locations = org.table(
  'locations',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    branchId: uuid('branch_id').references(() => branches.id, { onDelete: 'restrict' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    kind: locationKind('kind').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('locations_org_code_idx').on(table.orgId, table.code),
    index('locations_org_idx').on(table.orgId),
    index('locations_branch_idx').on(table.branchId),
  ],
);

/** Per-org configuration: courier booking trigger, thresholds, policies. */
export const settings = org.table(
  'settings',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    key: text('key').notNull(),
    value: jsonb('value').notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('settings_org_key_idx').on(table.orgId, table.key),
    index('settings_org_idx').on(table.orgId),
  ],
);

/** Ships unfinished modules dark, per org (D-031). */
export const featureFlags = org.table(
  'feature_flags',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    key: text('key').notNull(),
    enabled: boolean('enabled').notNull().default(false),
    value: jsonb('value'),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('feature_flags_org_key_idx').on(table.orgId, table.key),
    index('feature_flags_org_idx').on(table.orgId),
  ],
);
