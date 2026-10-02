import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  date,
  index,
  integer,
  pgSchema,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { primaryId } from '../columns.js';
import { organizations } from '../org/index.js';

/**
 * The analytics rollups and the narrative cache (architecture §18; M24).
 *
 * Owned by the `analytics` module. Every table is a tenant table: `org_id`, RLS ENABLE and
 * FORCE (migration 0093), written only inside `withOrg()` by the rollup job.
 *
 * - **A rollup is a cache, never a record.** Each `daily_*` row is rebuilt from the owning
 *   modules' interfaces by deleting an org's day and inserting it again in one
 *   transaction (D-320), so `erp_app` holds DELETE and nothing here is evidence of
 *   anything. Ids of branches, campaigns and agents are copied, not referenced: a rollup
 *   must survive the campaign it names being archived.
 * - **Cross-org reads are opt-in** (D-049, D-329). Only `daily_org` is readable by
 *   `erp_analytics` across every org — the leaderboard, the group medians and the
 *   consolidated dashboard read it through `withAnalytics()`. The other rollups and
 *   `narratives` are single-brand.
 * - **Gross profit is the one cost-derived column** (`gross_profit_poisha`, in
 *   `COST_FIELDS`). No column holds purchase cost itself (invariant 5), but revenue minus
 *   gross profit is the cost of goods, so a cross-brand read for anyone but Super Admin
 *   leaves the column out.
 */
export const analytics = pgSchema('analytics');

const orgIdColumn = () =>
  uuid('org_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'restrict' });

/** One rollup row's order figures (D-321): each counted on the Dhaka day it happened. */
const orderMetricColumns = () => ({
  ordersPlaced: integer('orders_placed').notNull().default(0),
  ordersConfirmed: integer('orders_confirmed').notNull().default(0),
  ordersDelivered: integer('orders_delivered').notNull().default(0),
  ordersReturned: integer('orders_returned').notNull().default(0),
  /** Cancelled after confirmation only. */
  ordersCancelled: integer('orders_cancelled').notNull().default(0),
  deliveredRevenuePoisha: bigint('delivered_revenue_poisha', { mode: 'bigint' })
    .notNull()
    .default(sql`0`),
  /** Delivered revenue less the dispatch cost of the delivered units. Cost roles only. */
  grossProfitPoisha: bigint('gross_profit_poisha', { mode: 'bigint' })
    .notNull()
    .default(sql`0`),
  deliveredOutsideDhaka: integer('delivered_outside_dhaka').notNull().default(0),
  returnedOutsideDhaka: integer('returned_outside_dhaka').notNull().default(0),
});

interface OrderMetricTable {
  ordersPlaced: unknown;
  ordersConfirmed: unknown;
  ordersDelivered: unknown;
  ordersReturned: unknown;
  ordersCancelled: unknown;
  deliveredRevenuePoisha: unknown;
  deliveredOutsideDhaka: unknown;
  returnedOutsideDhaka: unknown;
}

/** Counts are never negative; revenue is never negative. Gross profit may be (a loss). */
const orderMetricChecks = (name: string, table: OrderMetricTable) =>
  check(
    `${name}_metrics_not_negative`,
    sql`${table.ordersPlaced} >= 0 and ${table.ordersConfirmed} >= 0
        and ${table.ordersDelivered} >= 0 and ${table.ordersReturned} >= 0
        and ${table.ordersCancelled} >= 0 and ${table.deliveredRevenuePoisha} >= 0
        and ${table.deliveredOutsideDhaka} >= 0 and ${table.returnedOutsideDhaka} >= 0`,
  );

/** One row per org per Dhaka day, every day a recompute covered, quiet days included. */
export const dailyOrg = analytics.table(
  'daily_org',
  {
    id: primaryId,
    orgId: orgIdColumn(),
    businessDate: date('business_date', { mode: 'string' }).notNull(),
    ...orderMetricColumns(),
    spendPoisha: bigint('spend_poisha', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    pickupCount: integer('pickup_count').notNull().default(0),
    pickupSeconds: bigint('pickup_seconds', { mode: 'number' }).notNull().default(0),
    computedAt: timestamp('computed_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('daily_org_org_idx').on(table.orgId),
    unique('daily_org_org_date_key').on(table.orgId, table.businessDate),
    orderMetricChecks('daily_org', table),
    check(
      'daily_org_spend_pickups_not_negative',
      sql`${table.spendPoisha} >= 0 and ${table.pickupCount} >= 0 and ${table.pickupSeconds} >= 0`,
    ),
  ],
);

/** Orders a branch took (a showroom's), per branch per day. */
export const dailyBranch = analytics.table(
  'daily_branch',
  {
    id: primaryId,
    orgId: orgIdColumn(),
    businessDate: date('business_date', { mode: 'string' }).notNull(),
    branchId: uuid('branch_id').notNull(),
    ...orderMetricColumns(),
  },
  (table) => [
    index('daily_branch_org_idx').on(table.orgId),
    unique('daily_branch_org_date_branch_key').on(table.orgId, table.businessDate, table.branchId),
    orderMetricChecks('daily_branch', table),
  ],
);

/** Every order, per §9 channel per day. */
export const dailyChannel = analytics.table(
  'daily_channel',
  {
    id: primaryId,
    orgId: orgIdColumn(),
    businessDate: date('business_date', { mode: 'string' }).notNull(),
    channel: text('channel').notNull(),
    ...orderMetricColumns(),
  },
  (table) => [
    index('daily_channel_org_idx').on(table.orgId),
    unique('daily_channel_org_date_channel_key').on(table.orgId, table.businessDate, table.channel),
    orderMetricChecks('daily_channel', table),
  ],
);

/**
 * §11's inputs per campaign per day, attributed when the rollup ran (D-250, D-321). A null
 * campaign is the orders no campaign claims; it carries no spend.
 */
export const dailyCampaign = analytics.table(
  'daily_campaign',
  {
    id: primaryId,
    orgId: orgIdColumn(),
    businessDate: date('business_date', { mode: 'string' }).notNull(),
    campaignId: uuid('campaign_id'),
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
  },
  (table) => [
    index('daily_campaign_org_idx').on(table.orgId),
    unique('daily_campaign_org_date_campaign_key')
      .on(table.orgId, table.businessDate, table.campaignId)
      .nullsNotDistinct(),
    check(
      'daily_campaign_not_negative',
      sql`${table.spendPoisha} >= 0 and ${table.ordersConfirmed} >= 0
          and ${table.ordersDelivered} >= 0 and ${table.ordersReturned} >= 0
          and ${table.deliveredRevenuePoisha} >= 0 and ${table.placedRevenuePoisha} >= 0`,
    ),
  ],
);

/** Per agent per day: the orders they confirmed (D-272) and their desk pickups (D-276). */
export const dailyAgent = analytics.table(
  'daily_agent',
  {
    id: primaryId,
    orgId: orgIdColumn(),
    businessDate: date('business_date', { mode: 'string' }).notNull(),
    userId: text('user_id').notNull(),
    ordersConfirmed: integer('orders_confirmed').notNull().default(0),
    ordersDelivered: integer('orders_delivered').notNull().default(0),
    deliveredRevenuePoisha: bigint('delivered_revenue_poisha', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    pickupCount: integer('pickup_count').notNull().default(0),
    pickupSeconds: bigint('pickup_seconds', { mode: 'number' }).notNull().default(0),
  },
  (table) => [
    index('daily_agent_org_idx').on(table.orgId),
    unique('daily_agent_org_date_user_key').on(table.orgId, table.businessDate, table.userId),
    check(
      'daily_agent_not_negative',
      sql`${table.ordersConfirmed} >= 0 and ${table.ordersDelivered} >= 0
          and ${table.deliveredRevenuePoisha} >= 0 and ${table.pickupCount} >= 0
          and ${table.pickupSeconds} >= 0`,
    ),
  ],
);

/**
 * The LLM narrative, cached once per org per month per Dhaka day (§18, D-327). The text a
 * provider returned from a payload that carried no personal data; the payload's hash says
 * which figures it was written from.
 */
export const narratives = analytics.table(
  'narratives',
  {
    id: primaryId,
    orgId: orgIdColumn(),
    month: text('month').notNull(),
    generatedOn: date('generated_on', { mode: 'string' }).notNull(),
    provider: text('provider').notNull(),
    payloadSha256: text('payload_sha256').notNull(),
    body: text('body').notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    index('narratives_org_idx').on(table.orgId),
    unique('narratives_org_month_day_key').on(table.orgId, table.month, table.generatedOn),
    check('narratives_month_format', sql`${table.month} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`),
    check('narratives_hash_format', sql`${table.payloadSha256} ~ '^[0-9a-f]{64}$'`),
    check('narratives_body_bounded', sql`length(${table.body}) between 1 and 8000`),
  ],
);
