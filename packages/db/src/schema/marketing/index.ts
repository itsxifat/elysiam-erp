import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  customType,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { primaryId, timestamps } from '../columns.js';
import { skus } from '../catalog/index.js';
import { orders } from '../orders/index.js';
import { organizations } from '../org/index.js';

/**
 * Campaigns, ad spend, leads and the Meta link (architecture §11, M18).
 *
 * Owned by the `marketing` module. Every table carries `org_id` with RLS ENABLE + FORCE
 * (migration 0082) and every tenant foreign key carries `org_id` on both sides (D-047).
 *
 * Three shapes worth knowing before the columns:
 *
 * 1. **One spend figure per campaign per day.** `ad_spend` is unique on
 *    `(org_id, campaign_id, spend_date)`, so an import that runs twice, or two imports
 *    whose ranges overlap, replace a day's figure rather than add to it (M18 check 2). A
 *    figure a person entered is marked `manual` and the import never overwrites it
 *    (D-252).
 * 2. **An external id names one campaign.** `campaign_refs` is unique per
 *    `(org_id, kind, value)`, so attribution (§11) can never find two campaigns for one
 *    Meta ad or one `utm_campaign`.
 * 3. **The Meta token is never readable.** `meta_connections.token` is AES-256-GCM
 *    ciphertext bound to the org, exactly as courier credentials are (§25, invariant 10);
 *    a 12-hex fingerprint lets an operator confirm which token is configured.
 */
export const marketing = pgSchema('marketing');

/** Ciphertext, as a column type (the courier schema's `encrypted`, for the same reason). */
const encrypted = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
  fromDriver: (value) => Buffer.from(value as unknown as Uint8Array),
  toDriver: (value) => value,
});

export const campaigns = marketing.table(
  'campaigns',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    platform: text('platform').notNull(),
    /** Catalog product ids the campaign promotes. Informational; attribution never reads it. */
    productIds: jsonb('product_ids').notNull().default([]),
    /** Asia/Dhaka calendar dates, both inclusive. */
    startsOn: date('starts_on', { mode: 'string' }),
    endsOn: date('ends_on', { mode: 'string' }),
    status: text('status').notNull().default('active'),
    /** A person made it, or the Meta import found a campaign it did not know (D-254). */
    origin: text('origin').notNull().default('manual'),
    createdBy: text('created_by').notNull(),
    ...timestamps,
  },
  (table) => [
    unique('campaigns_org_id_id_key').on(table.orgId, table.id),
    index('campaigns_org_idx').on(table.orgId),
    check('campaigns_name_length', sql`length(${table.name}) between 1 and 200`),
    check('campaigns_platform', sql`${table.platform} in ('meta', 'google', 'tiktok', 'other')`),
    check('campaigns_status', sql`${table.status} in ('active', 'archived')`),
    check('campaigns_origin', sql`${table.origin} in ('manual', 'meta_import')`),
    check(
      'campaigns_window',
      sql`${table.startsOn} is null or ${table.endsOn} is null or ${table.startsOn} <= ${table.endsOn}`,
    ),
  ],
);

export const campaignRefs = marketing.table(
  'campaign_refs',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    campaignId: uuid('campaign_id').notNull(),
    kind: text('kind').notNull(),
    /** Trimmed; a `utm_campaign` is also lower-cased, as attribution compares it. */
    value: text('value').notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    unique('campaign_refs_org_id_id_key').on(table.orgId, table.id),
    index('campaign_refs_org_idx').on(table.orgId),
    uniqueIndex('campaign_refs_org_kind_value_idx').on(table.orgId, table.kind, table.value),
    index('campaign_refs_org_campaign_idx').on(table.orgId, table.campaignId),
    foreignKey({
      name: 'campaign_refs_org_id_campaign_id_fk',
      columns: [table.orgId, table.campaignId],
      foreignColumns: [campaigns.orgId, campaigns.id],
    }).onDelete('restrict'),
    check('campaign_refs_kind', sql`${table.kind} in ('meta_campaign', 'meta_ad', 'utm_campaign')`),
    check(
      'campaign_refs_value',
      sql`length(${table.value}) between 1 and 120 and ${table.value} = btrim(${table.value})
        and (${table.kind} <> 'utm_campaign' or ${table.value} = lower(${table.value}))`,
    ),
  ],
);

export const adSpend = marketing.table(
  'ad_spend',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    campaignId: uuid('campaign_id').notNull(),
    /** Asia/Dhaka for a manual figure; the ad account's day for an imported one (D-254). */
    spendDate: date('spend_date', { mode: 'string' }).notNull(),
    amountPoisha: bigint('amount_poisha', { mode: 'bigint' }).notNull(),
    source: text('source').notNull(),
    note: text('note'),
    /** Who typed it, or the import's actor. */
    enteredBy: text('entered_by').notNull(),
    ...timestamps,
  },
  (table) => [
    unique('ad_spend_org_id_id_key').on(table.orgId, table.id),
    index('ad_spend_org_idx').on(table.orgId),
    uniqueIndex('ad_spend_org_campaign_date_idx').on(
      table.orgId,
      table.campaignId,
      table.spendDate,
    ),
    index('ad_spend_org_date_idx').on(table.orgId, table.spendDate),
    foreignKey({
      name: 'ad_spend_org_id_campaign_id_fk',
      columns: [table.orgId, table.campaignId],
      foreignColumns: [campaigns.orgId, campaigns.id],
    }).onDelete('restrict'),
    check('ad_spend_amount', sql`${table.amountPoisha} >= 0`),
    check('ad_spend_source', sql`${table.source} in ('manual', 'meta')`),
  ],
);

export const leads = marketing.table(
  'leads',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    /** E.164, the same normalisation as a buyer's (§10). Masked in every log. */
    phoneE164: text('phone_e164').notNull(),
    name: text('name'),
    channel: text('channel').notNull(),
    campaignId: uuid('campaign_id'),
    /** The SKU asked about; its product is the report's "product". */
    skuId: uuid('sku_id'),
    size: text('size'),
    ageBand: text('age_band'),
    profession: text('profession'),
    status: text('status').notNull().default('new'),
    notes: text('notes'),
    createdBy: text('created_by').notNull(),
    ...timestamps,
  },
  (table) => [
    unique('leads_org_id_id_key').on(table.orgId, table.id),
    index('leads_org_idx').on(table.orgId),
    index('leads_org_created_idx').on(table.orgId, table.createdAt),
    index('leads_org_phone_idx').on(table.orgId, table.phoneE164),
    foreignKey({
      name: 'leads_org_id_campaign_id_fk',
      columns: [table.orgId, table.campaignId],
      foreignColumns: [campaigns.orgId, campaigns.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'leads_org_id_sku_id_fk',
      columns: [table.orgId, table.skuId],
      foreignColumns: [skus.orgId, skus.id],
    }).onDelete('restrict'),
    check('leads_phone_shape', sql`${table.phoneE164} ~ '^\\+[0-9]{8,15}$'`),
    check(
      'leads_channel',
      sql`${table.channel} in ('facebook', 'whatsapp', 'instagram', 'tiktok', 'landing_page',
        'website', 'phone', 'walk_in', 'reseller')`,
    ),
    check(
      'leads_age_band',
      sql`${table.ageBand} is null or ${table.ageBand} in ('under_18', '18_24', '25_34', '35_44',
        '45_54', '55_plus')`,
    ),
    check('leads_status', sql`${table.status} in ('new', 'contacted', 'converted', 'lost')`),
  ],
);

export const metaConnections = marketing.table(
  'meta_connections',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    /** Digits only; the `act_` prefix is added when the request is built. */
    adAccountId: text('ad_account_id'),
    /** The pixel, which Meta now calls a dataset. */
    pixelId: text('pixel_id'),
    token: encrypted('token'),
    tokenKeyId: text('token_key_id'),
    tokenFingerprint: text('token_fingerprint'),
    spendImportEnabled: boolean('spend_import_enabled').notNull().default(false),
    capiEnabled: boolean('capi_enabled').notNull().default(false),
    /** The brand records consent for name and city at checkout (§11, D-256). */
    sendNameAndCity: boolean('send_name_and_city').notNull().default(false),
    /** Meta's Test Events code; events sent with it never count. */
    testEventCode: text('test_event_code'),
    lastImportAt: timestamp('last_import_at', { withTimezone: true, mode: 'date' }),
    lastImportStatus: text('last_import_status'),
    lastImportError: text('last_import_error'),
    updatedBy: text('updated_by').notNull(),
    ...timestamps,
  },
  (table) => [
    unique('meta_connections_org_id_id_key').on(table.orgId, table.id),
    uniqueIndex('meta_connections_org_idx').on(table.orgId),
    check(
      'meta_connections_ids',
      sql`(${table.adAccountId} is null or ${table.adAccountId} ~ '^[0-9]{1,30}$')
        and (${table.pixelId} is null or ${table.pixelId} ~ '^[0-9]{1,30}$')`,
    ),
    check(
      'meta_connections_token_sealed',
      sql`(${table.token} is null) = (${table.tokenKeyId} is null)
        and (${table.token} is null) = (${table.tokenFingerprint} is null)`,
    ),
    check(
      'meta_connections_import_status',
      sql`${table.lastImportStatus} is null or ${table.lastImportStatus} in ('ok', 'failed')`,
    ),
  ],
);

export const capiEvents = marketing.table(
  'capi_events',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    orderId: uuid('order_id').notNull(),
    eventName: text('event_name').notNull(),
    /** The order id: Meta's deduplication key (§11). */
    eventId: text('event_id').notNull(),
    status: text('status').notNull().default('queued'),
    attempts: integer('attempts').notNull().default(0),
    /** What was sent: hashed identifiers only, never a phone or a name (check 3). */
    payload: jsonb('payload'),
    valuePoisha: bigint('value_poisha', { mode: 'bigint' }),
    eventTime: timestamp('event_time', { withTimezone: true, mode: 'date' }),
    /** Meta's answer: events received, fbtrace id, error code and message. */
    response: jsonb('response'),
    lastError: text('last_error'),
    sentAt: timestamp('sent_at', { withTimezone: true, mode: 'date' }),
    ...timestamps,
  },
  (table) => [
    unique('capi_events_org_id_id_key').on(table.orgId, table.id),
    index('capi_events_org_idx').on(table.orgId),
    uniqueIndex('capi_events_org_order_event_idx').on(
      table.orgId,
      table.orderId,
      table.eventName,
    ),
    index('capi_events_org_created_idx').on(table.orgId, table.createdAt),
    foreignKey({
      name: 'capi_events_org_id_order_id_fk',
      columns: [table.orgId, table.orderId],
      foreignColumns: [orders.orgId, orders.id],
    }).onDelete('restrict'),
    check('capi_events_name', sql`${table.eventName} in ('Purchase')`),
    check('capi_events_status', sql`${table.status} in ('queued', 'sent', 'failed', 'skipped')`),
    check('capi_events_value', sql`${table.valuePoisha} is null or ${table.valuePoisha} >= 0`),
  ],
);
