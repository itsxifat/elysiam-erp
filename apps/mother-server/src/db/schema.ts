import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  check,
  customType,
  date,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * The mother ERP's own database (D-480): who may sign in, which brands it reads, what it
 * pulled from them, and what was done here.
 *
 * Its own Postgres database (`elysium_mother`), its own roles (`mother_owner` owns,
 * `mother_app` serves) and its own migrations under `apps/mother-server/migrations`. It
 * shares nothing with a brand's database. There is no tenancy here — every person in it is
 * an owner who sees every brand — so there is no `org_id` and no row-level security; the
 * controls are the grants in the hand-written migration beside the generated ones.
 *
 * Money is integer poisha in `bigint` columns named `*_poisha` (invariant 1).
 */

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
};

// --- people (Better Auth's tables, D-487) ----------------------------------------------

export const auth = pgSchema('auth');

export const users = auth.table('users', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  twoFactorEnabled: boolean('two_factor_enabled').notNull().default(false),
  /** False once removed (D-489): the session hook refuses them, and their sessions are gone. */
  isActive: boolean('is_active').notNull().default(true),
  invitedBy: text('invited_by'),
  lastSignInAt: timestamp('last_sign_in_at', { withTimezone: true, mode: 'date' }),
  ...timestamps,
});

export const sessions = auth.table(
  'sessions',
  {
    id: text('id').primaryKey(),
    token: text('token').notNull().unique(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    ...timestamps,
  },
  (table) => [index('sessions_user_idx').on(table.userId)],
);

export const accounts = auth.table(
  'accounts',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    password: text('password'),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', {
      withTimezone: true,
      mode: 'date',
    }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', {
      withTimezone: true,
      mode: 'date',
    }),
    scope: text('scope'),
    ...timestamps,
  },
  (table) => [index('accounts_user_idx').on(table.userId)],
);

export const verifications = auth.table(
  'verifications',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    ...timestamps,
  },
  (table) => [index('verifications_identifier_idx').on(table.identifier)],
);

export const twoFactors = auth.table(
  'two_factors',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    secret: text('secret').notNull(),
    backupCodes: text('backup_codes').notNull(),
    verified: boolean('verified').notNull().default(false),
    failedVerificationCount: integer('failed_verification_count').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true, mode: 'date' }),
  },
  (table) => [index('two_factors_user_idx').on(table.userId)],
);

// --- the brands it reads (D-481, D-490) ---------------------------------------------------

export const mother = pgSchema('mother');

export const brands = mother.table(
  'brands',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** The brand ERP's `ERP_BRAND_SLUG`, its org's slug, and the owner link's audience. */
    slug: text('slug').notNull(),
    displayName: text('display_name').notNull(),
    /** The brand's staff console, where an owner link lands (`/owner-link#token=…`). */
    adminUrl: text('admin_url').notNull(),
    /** AES-256-GCM over the `erp_analytics` connection string, bound to this row (D-481). */
    readConnectionCipher: bytea('read_connection_cipher').notNull(),
    readConnectionKeyId: text('read_connection_key_id').notNull(),
    /** 12 hex characters of the connection's digest: which one is set, never what it is. */
    readConnectionFingerprint: text('read_connection_fingerprint').notNull(),
    /** The Ed25519 private key (PKCS#8 DER), sealed like the connection (D-490). */
    ownerLinkKeyCipher: bytea('owner_link_key_cipher'),
    ownerLinkKeyId: text('owner_link_key_id'),
    /** 16 hex characters of the public key's digest, to match against the brand's env. */
    ownerLinkKeyFingerprint: text('owner_link_key_fingerprint'),
    ownerLinkKeyCreatedAt: timestamp('owner_link_key_created_at', {
      withTimezone: true,
      mode: 'date',
    }),
    isActive: boolean('is_active').notNull().default(true),
    position: integer('position').notNull().default(0),

    /** The brand's org id in its own database, found at the first good pull. */
    brandOrgId: uuid('brand_org_id'),
    /** `ok`, `version_mismatch` or `unknown` (D-481, D-486). */
    schemaStatus: text('schema_status').notNull().default('unknown'),
    brandMigrations: integer('brand_migrations'),
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true, mode: 'date' }),
    /** When the figures held here were read: the age the screens show (D-486). */
    figuresAt: timestamp('figures_at', { withTimezone: true, mode: 'date' }),
    /** A short code (`unreachable`, `auth_failed`, …), never a message from the brand. */
    lastErrorCode: text('last_error_code'),
    lastErrorAt: timestamp('last_error_at', { withTimezone: true, mode: 'date' }),
    createdBy: text('created_by').notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('brands_slug_idx').on(table.slug),
    check('brands_slug_format', sql`${table.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`),
    check(
      'brands_schema_status',
      sql`${table.schemaStatus} in ('ok', 'version_mismatch', 'unknown')`,
    ),
    check(
      'brands_owner_link_key_whole',
      sql`(${table.ownerLinkKeyCipher} is null) = (${table.ownerLinkKeyFingerprint} is null)`,
    ),
  ],
);

// --- what it pulled (D-484) -----------------------------------------------------------------

const orderMetrics = () => ({
  ordersPlaced: integer('orders_placed').notNull().default(0),
  ordersConfirmed: integer('orders_confirmed').notNull().default(0),
  ordersDelivered: integer('orders_delivered').notNull().default(0),
  ordersReturned: integer('orders_returned').notNull().default(0),
  ordersCancelled: integer('orders_cancelled').notNull().default(0),
  deliveredRevenuePoisha: bigint('delivered_revenue_poisha', { mode: 'bigint' })
    .notNull()
    .default(sql`0`),
  grossProfitPoisha: bigint('gross_profit_poisha', { mode: 'bigint' })
    .notNull()
    .default(sql`0`),
  deliveredOutsideDhaka: integer('delivered_outside_dhaka').notNull().default(0),
  returnedOutsideDhaka: integer('returned_outside_dhaka').notNull().default(0),
});

const brandRef = () =>
  uuid('brand_id')
    .notNull()
    .references(() => brands.id, { onDelete: 'cascade' });

/** A brand's `analytics.daily_org` row, as read at `pulled_at`. */
export const brandDaily = mother.table(
  'brand_daily',
  {
    brandId: brandRef(),
    businessDate: date('business_date', { mode: 'string' }).notNull(),
    ...orderMetrics(),
    spendPoisha: bigint('spend_poisha', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    pickupCount: integer('pickup_count').notNull().default(0),
    pickupSeconds: bigint('pickup_seconds', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    /** When the brand computed the day (its `computed_at`). */
    computedAt: timestamp('computed_at', { withTimezone: true, mode: 'date' }),
    pulledAt: timestamp('pulled_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.brandId, table.businessDate] })],
);

export const brandDailyChannel = mother.table(
  'brand_daily_channel',
  {
    brandId: brandRef(),
    businessDate: date('business_date', { mode: 'string' }).notNull(),
    channel: text('channel').notNull(),
    ...orderMetrics(),
    pulledAt: timestamp('pulled_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.brandId, table.businessDate, table.channel] })],
);

export const brandDailyCampaign = mother.table(
  'brand_daily_campaign',
  {
    brandId: brandRef(),
    businessDate: date('business_date', { mode: 'string' }).notNull(),
    /** The brand's campaign id, or `none` for orders no campaign claimed. */
    campaignKey: text('campaign_key').notNull(),
    campaignName: text('campaign_name'),
    spendPoisha: bigint('spend_poisha', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    ordersConfirmed: integer('orders_confirmed').notNull().default(0),
    ordersDelivered: integer('orders_delivered').notNull().default(0),
    ordersReturned: integer('orders_returned').notNull().default(0),
    deliveredRevenuePoisha: bigint('delivered_revenue_poisha', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    placedRevenuePoisha: bigint('placed_revenue_poisha', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    pulledAt: timestamp('pulled_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.brandId, table.businessDate, table.campaignKey] })],
);

/**
 * A brand's income and expense lines summed per business date and subtype (D-493): the
 * consolidated P&L over any range is a sum of these. Sums of posted journals, so they
 * change only when a journal dated that day is posted later; the window covers that.
 */
export const brandDailyLedger = mother.table(
  'brand_daily_ledger',
  {
    brandId: brandRef(),
    businessDate: date('business_date', { mode: 'string' }).notNull(),
    subtype: text('subtype').notNull(),
    accountClass: text('account_class').notNull(),
    debitPoisha: bigint('debit_poisha', { mode: 'bigint' }).notNull(),
    creditPoisha: bigint('credit_poisha', { mode: 'bigint' }).notNull(),
    pulledAt: timestamp('pulled_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.brandId, table.businessDate, table.accountClass, table.subtype] }),
    check('brand_daily_ledger_class', sql`${table.accountClass} in ('income', 'expense')`),
    check(
      'brand_daily_ledger_sides',
      sql`${table.debitPoisha} >= 0 and ${table.creditPoisha} >= 0`,
    ),
  ],
);

/** A brand's positions at a pull (D-485). Kept as history; the screens read the latest. */
export const brandSnapshots = mother.table(
  'brand_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    brandId: brandRef(),
    takenAt: timestamp('taken_at', { withTimezone: true, mode: 'date' }).notNull(),
    /** The Asia/Dhaka business date the ledger positions are as of (invariant 8). */
    asOf: date('as_of', { mode: 'string' }).notNull(),
    cashHandPoisha: bigint('cash_hand_poisha', { mode: 'bigint' }).notNull(),
    cashBankPoisha: bigint('cash_bank_poisha', { mode: 'bigint' }).notNull(),
    cashBkashPoisha: bigint('cash_bkash_poisha', { mode: 'bigint' }).notNull(),
    cashMfsOtherPoisha: bigint('cash_mfs_other_poisha', { mode: 'bigint' }).notNull(),
    stockValuePoisha: bigint('stock_value_poisha', { mode: 'bigint' }).notNull(),
    goodsInTransitPoisha: bigint('goods_in_transit_poisha', { mode: 'bigint' }).notNull(),
    codHeldPoisha: bigint('cod_held_poisha', { mode: 'bigint' }).notNull(),
    supplierPayablesPoisha: bigint('supplier_payables_poisha', { mode: 'bigint' }).notNull(),
    receivablesPoisha: bigint('receivables_poisha', { mode: 'bigint' }).notNull(),
    /** Open orders by status: counts, no money. */
    openOrders: jsonb('open_orders').notNull().default({}),
    staffHeadcount: integer('staff_headcount').notNull(),
    activeSkus: integer('active_skus').notNull(),
    lowStockSkus: integer('low_stock_skus').notNull(),
  },
  (table) => [index('brand_snapshots_brand_taken_idx').on(table.brandId, table.takenAt)],
);

/** One attempt to read a brand, for the brands screen and the activity log. */
export const pullRuns = mother.table(
  'pull_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    brandId: brandRef(),
    trigger: text('trigger').notNull(),
    isFull: boolean('is_full').notNull().default(false),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true, mode: 'date' }),
    /** `running`, `ok`, `failed`, `version_mismatch`. */
    status: text('status').notNull().default('running'),
    errorCode: text('error_code'),
    fromDate: date('from_date', { mode: 'string' }),
    toDate: date('to_date', { mode: 'string' }),
    days: integer('days'),
  },
  (table) => [
    index('pull_runs_brand_started_idx').on(table.brandId, table.startedAt),
    check('pull_runs_trigger', sql`${table.trigger} in ('schedule', 'nightly', 'owner', 'first')`),
    check(
      'pull_runs_status',
      sql`${table.status} in ('running', 'ok', 'failed', 'version_mismatch')`,
    ),
  ],
);

// --- what was done here ----------------------------------------------------------------------

/**
 * Every sign-in, owner link, brand change and people action (D-487). Append-only: the app
 * role holds INSERT and SELECT only, and a trigger refuses UPDATE and DELETE for everyone.
 */
export const auditLog = mother.table(
  'audit_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    actorUserId: text('actor_user_id'),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id'),
    detail: jsonb('detail').notNull().default({}),
    ipAddress: text('ip_address'),
    requestId: text('request_id'),
  },
  (table) => [
    index('audit_log_occurred_idx').on(table.occurredAt),
    index('audit_log_entity_idx').on(table.entityType, table.entityId),
  ],
);

/**
 * A request to clear another owner's second factor, which a third owner decides (D-488).
 * The database refuses a decision by the requester or by the person being reset.
 */
export const twoFactorResets = mother.table(
  'two_factor_resets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    targetUserId: text('target_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    requestedBy: text('requested_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    reason: text('reason').notNull(),
    status: text('status').notNull().default('pending'),
    decidedBy: text('decided_by').references(() => users.id, { onDelete: 'restrict' }),
    decidedAt: timestamp('decided_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    index('two_factor_resets_target_idx').on(table.targetUserId),
    uniqueIndex('two_factor_resets_one_pending_idx')
      .on(table.targetUserId)
      .where(sql`${table.status} = 'pending'`),
    check('two_factor_resets_status', sql`${table.status} in ('pending', 'approved', 'rejected')`),
    check('two_factor_resets_not_self', sql`${table.requestedBy} <> ${table.targetUserId}`),
    check(
      'two_factor_resets_decider',
      sql`${table.decidedBy} is null or (${table.decidedBy} <> ${table.requestedBy}
          and ${table.decidedBy} <> ${table.targetUserId})`,
    ),
    check(
      'two_factor_resets_decided_whole',
      sql`(${table.status} = 'pending') = (${table.decidedBy} is null and ${table.decidedAt} is null)`,
    ),
  ],
);
