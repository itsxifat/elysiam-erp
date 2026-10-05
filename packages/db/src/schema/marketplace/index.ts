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
import { orders } from '../orders/index.js';
import { locations, organizations } from '../org/index.js';

/**
 * The ncom.bd marketplace connector (M35b, D-553, D-556), the old site's `Settings.ncom`,
 * `NcomReservation`, the `ncom` block on its orders, `NcomOutbox` and `NcomEvent`.
 *
 * Every table is a tenant table (invariant 4): `org_id NOT NULL`, RLS ENABLE and FORCE in the
 * M35b policies migration, composite foreign keys to other tenant tables (D-047). Nothing here
 * is cost-shaped: ncom reads selling prices and stock counts, never a purchase cost.
 */
export const marketplace = pgSchema('marketplace');

/** AES-256-GCM ciphertext under `STOREFRONT_CREDENTIALS_KEY` (D-528's box), bound to its row. */
const sealedBytes = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
  fromDriver: (value) => Buffer.from(value as unknown as Uint8Array),
  toDriver: (value) => value,
});

/**
 * One brand's ncom link (D-553): what ncom may do (read the catalogue, hold stock, hand orders
 * over) and the credentials ncom issued. The four secrets are sealed and write-only; the two key
 * ids are not secrets (ncom sends them in the clear). Activity is written at most once a minute
 * per process, never per request: `/stock` is on every cart a shopper opens.
 */
export const ncomSettings = marketplace.table(
  'ncom_settings',
  {
    orgId: uuid('org_id')
      .primaryKey()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    enabled: boolean('enabled').notNull().default(false),
    acceptOrders: boolean('accept_orders').notNull().default(false),
    includeDrafts: boolean('include_drafts').notNull().default(true),
    allowSearch: boolean('allow_search').notNull().default(true),
    allowCategories: boolean('allow_categories').notNull().default(true),
    allowReserve: boolean('allow_reserve').notNull().default(true),
    defaultWeightGrams: integer('default_weight_grams').notNull().default(0),
    publicBaseUrl: text('public_base_url').notNull().default(''),
    baseUrl: text('base_url').notNull().default('https://ncom.bd/api/v1'),
    connectorKeyId: text('connector_key_id').notNull().default(''),
    orderKeyId: text('order_key_id').notNull().default(''),
    connectorSecretSealed: sealedBytes('connector_secret_sealed'),
    connectorSecretFingerprint: text('connector_secret_fingerprint'),
    orderSecretSealed: sealedBytes('order_secret_sealed'),
    orderSecretFingerprint: text('order_secret_fingerprint'),
    apiKeySealed: sealedBytes('api_key_sealed'),
    apiKeyFingerprint: text('api_key_fingerprint'),
    webhookSecretSealed: sealedBytes('webhook_secret_sealed'),
    webhookSecretFingerprint: text('webhook_secret_fingerprint'),
    /** The installation key the secrets were sealed under. */
    keyId: text('key_id'),
    lastRequestAt: timestamp('last_request_at', { withTimezone: true, mode: 'date' }),
    lastRequestKind: text('last_request_kind'),
    requestCounts: jsonb('request_counts').notNull().default({}),
    lastRefusalReason: text('last_refusal_reason'),
    lastRefusalAt: timestamp('last_refusal_at', { withTimezone: true, mode: 'date' }),
    lastOrderAt: timestamp('last_order_at', { withTimezone: true, mode: 'date' }),
    ordersReceived: integer('orders_received').notNull().default(0),
    lastWebhookAt: timestamp('last_webhook_at', { withTimezone: true, mode: 'date' }),
    updatedBy: text('updated_by').notNull(),
    ...timestamps,
  },
  (table) => [
    index('ncom_settings_org_idx').on(table.orgId),
    check('ncom_settings_weight', sql`${table.defaultWeightGrams} between 0 and 100000`),
    check(
      'ncom_settings_urls',
      sql`${table.baseUrl} ~ '^https://' and (${table.publicBaseUrl} = '' or ${table.publicBaseUrl} ~ '^https://')`,
    ),
    check(
      'ncom_settings_key_ids',
      sql`length(${table.connectorKeyId}) <= 120 and length(${table.orderKeyId}) <= 120`,
    ),
    check(
      'ncom_settings_secrets_complete',
      sql`(${table.connectorSecretSealed} is null) = (${table.connectorSecretFingerprint} is null)
          and (${table.orderSecretSealed} is null) = (${table.orderSecretFingerprint} is null)
          and (${table.apiKeySealed} is null) = (${table.apiKeyFingerprint} is null)
          and (${table.webhookSecretSealed} is null) = (${table.webhookSecretFingerprint} is null)
          and ((${table.connectorSecretSealed} is null and ${table.orderSecretSealed} is null
                and ${table.apiKeySealed} is null and ${table.webhookSecretSealed} is null)
               or ${table.keyId} is not null)`,
    ),
    check('ncom_settings_orders_received', sql`${table.ordersReceived} >= 0`),
  ],
);

/**
 * A hold ncom asked for (`POST …/reserve`, D-553): its order reference, the units held at one
 * web location through the inventory reservation (`ref_type = 'ncom_hold'`, `ref_id = id`), and
 * what became of it. `released` gives back exactly what the reservation held, once;
 * `converted` is a hold an order handed over by ncom took over. The reference is unique per
 * brand, so a retried reserve finds the hold it already made.
 */
export const ncomHolds = marketplace.table(
  'ncom_holds',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    orderRef: text('order_ref').notNull(),
    state: text('state').notNull().default('held'),
    locationId: uuid('location_id').notNull(),
    /** `[{ skuId, variantId, qty }]`: what was held, as ncom named it. */
    lines: jsonb('lines').notNull().default([]),
    heldAt: timestamp('held_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    releasedAt: timestamp('released_at', { withTimezone: true, mode: 'date' }),
    convertedOrderId: uuid('converted_order_id'),
    ...timestamps,
  },
  (table) => [
    unique('ncom_holds_org_id_id_key').on(table.orgId, table.id),
    index('ncom_holds_org_idx').on(table.orgId),
    uniqueIndex('ncom_holds_org_ref_idx').on(table.orgId, table.orderRef),
    index('ncom_holds_org_state_idx').on(table.orgId, table.state, table.heldAt),
    foreignKey({
      name: 'ncom_holds_org_id_location_id_fk',
      columns: [table.orgId, table.locationId],
      foreignColumns: [locations.orgId, locations.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'ncom_holds_org_id_converted_order_id_fk',
      columns: [table.orgId, table.convertedOrderId],
      foreignColumns: [orders.orgId, orders.id],
    }).onDelete('restrict'),
    check('ncom_holds_order_ref_shape', sql`${table.orderRef} ~ '^[!-~]{1,128}$'`),
    check('ncom_holds_state', sql`${table.state} in ('held', 'released', 'converted')`),
    check(
      'ncom_holds_state_complete',
      sql`(${table.state} = 'held' and ${table.releasedAt} is null and ${table.convertedOrderId} is null)
          or (${table.state} = 'released' and ${table.releasedAt} is not null)
          or (${table.state} = 'converted' and ${table.releasedAt} is not null and ${table.convertedOrderId} is not null)`,
    ),
    check('ncom_holds_lines_bounded', sql`pg_column_size(${table.lines}) < 65536`),
  ],
);

/**
 * An order ncom handed over (D-556): the ERP order it became, ncom's own id and number, the
 * idempotency key it came with, the revision both sides count, what ncom's page sold it as,
 * the lines for products ncom stores itself (recorded, never picked from stock) and anything a
 * person should check. ncom's prices were taken as they are (`foreign_poisha` is what ncom's
 * total carried beyond the brand's own goods and delivery).
 */
export const ncomOrders = marketplace.table(
  'ncom_orders',
  {
    orderId: uuid('order_id').notNull(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    ncomOrderId: text('ncom_order_id').notNull(),
    ncomOrderNumber: text('ncom_order_number').notNull().default(''),
    idempotencyKey: text('idempotency_key').notNull(),
    revision: integer('revision').notNull().default(0),
    lastInboundKey: text('last_inbound_key'),
    storeName: text('store_name').notNull().default(''),
    storeUrl: text('store_url').notNull().default(''),
    pageTitle: text('page_title').notNull().default(''),
    pageUrl: text('page_url').notNull().default(''),
    offerKey: text('offer_key').notNull().default(''),
    offerLabel: text('offer_label').notNull().default(''),
    offerPricePoisha: bigint('offer_price_poisha', { mode: 'bigint' }),
    regularPricePoisha: bigint('regular_price_poisha', { mode: 'bigint' }),
    discountCode: text('discount_code').notNull().default(''),
    foreignItems: jsonb('foreign_items').notNull().default([]),
    foreignPoisha: bigint('foreign_poisha', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    warnings: jsonb('warnings').notNull().default([]),
    stockHeld: boolean('stock_held').notNull().default(false),
    receivedAt: timestamp('received_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    ...timestamps,
  },
  (table) => [
    primaryKey({ name: 'ncom_orders_pkey', columns: [table.orgId, table.orderId] }),
    index('ncom_orders_org_idx').on(table.orgId),
    uniqueIndex('ncom_orders_org_ncom_id_idx').on(table.orgId, table.ncomOrderId),
    uniqueIndex('ncom_orders_org_key_idx').on(table.orgId, table.idempotencyKey),
    foreignKey({
      name: 'ncom_orders_org_id_order_id_fk',
      columns: [table.orgId, table.orderId],
      foreignColumns: [orders.orgId, orders.id],
    }).onDelete('restrict'),
    check(
      'ncom_orders_ids_shape',
      sql`${table.ncomOrderId} ~ '^[!-~]{1,128}$'
      and ${table.idempotencyKey} ~ '^[!-~]{1,255}$'`,
    ),
    check('ncom_orders_revision', sql`${table.revision} >= 0`),
    check(
      'ncom_orders_money',
      sql`${table.foreignPoisha} >= 0 and coalesce(${table.offerPricePoisha}, 0) >= 0
          and coalesce(${table.regularPricePoisha}, 0) >= 0`,
    ),
    check(
      'ncom_orders_sections_bounded',
      sql`pg_column_size(${table.foreignItems}) + pg_column_size(${table.warnings}) < 65536`,
    ),
  ],
);

/**
 * What the ERP tells ncom about an order it handed over (D-556): one row per change, sent in
 * order per order by `marketplace.ncom_send` with the old backoff, never more than once
 * delivered (ncom deduplicates on the idempotency key, one per revision). The body is sealed
 * while it waits (it names the shopper and the address) and cleared once it is delivered or
 * given up on.
 */
export const ncomOutbox = marketplace.table(
  'ncom_outbox',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    orderId: uuid('order_id').notNull(),
    topic: text('topic').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    /** The outbox event that queued it: a redelivered event queues nothing twice. */
    sourceEventId: uuid('source_event_id'),
    baseRevision: integer('base_revision').notNull(),
    revision: integer('revision').notNull(),
    payloadSealed: sealedBytes('payload_sealed'),
    keyId: text('key_id'),
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true, mode: 'date' }),
    statusCode: integer('status_code'),
    error: text('error'),
    deliveredAt: timestamp('delivered_at', { withTimezone: true, mode: 'date' }),
    ...timestamps,
  },
  (table) => [
    unique('ncom_outbox_org_id_id_key').on(table.orgId, table.id),
    index('ncom_outbox_org_idx').on(table.orgId),
    uniqueIndex('ncom_outbox_org_key_idx').on(table.orgId, table.idempotencyKey),
    uniqueIndex('ncom_outbox_org_event_idx')
      .on(table.orgId, table.sourceEventId)
      .where(sql`${table.sourceEventId} is not null`),
    index('ncom_outbox_org_order_idx').on(table.orgId, table.orderId, table.revision),
    index('ncom_outbox_due_idx').on(table.status, table.nextAttemptAt),
    foreignKey({
      name: 'ncom_outbox_org_id_order_id_fk',
      columns: [table.orgId, table.orderId],
      foreignColumns: [ncomOrders.orgId, ncomOrders.orderId],
    }).onDelete('restrict'),
    check('ncom_outbox_topic', sql`${table.topic} in ('order.updated', 'order.cancelled')`),
    check(
      'ncom_outbox_status',
      sql`${table.status} in ('pending', 'delivered', 'refused', 'failed')`,
    ),
    check('ncom_outbox_revision', sql`${table.revision} = ${table.baseRevision} + 1`),
    check('ncom_outbox_attempts', sql`${table.attempts} between 0 and 8`),
    check(
      'ncom_outbox_payload_only_while_pending',
      sql`(${table.payloadSealed} is null or ${table.status} = 'pending')
          and (${table.status} <> 'pending' or (${table.payloadSealed} is not null and ${table.keyId} is not null))`,
    ),
    check(
      'ncom_outbox_delivered_complete',
      sql`(${table.status} = 'delivered') = (${table.deliveredAt} is not null)`,
    ),
  ],
);

/** A webhook ncom delivered (D-556): claimed by its event id, so a retry is answered once. */
export const ncomEvents = marketplace.table(
  'ncom_events',
  {
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    eventId: text('event_id').notNull(),
    topic: text('topic').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ name: 'ncom_events_pkey', columns: [table.orgId, table.eventId] }),
    index('ncom_events_org_idx').on(table.orgId),
    index('ncom_events_org_received_idx').on(table.orgId, table.receivedAt),
    check('ncom_events_event_id_shape', sql`${table.eventId} ~ '^[!-~]{1,128}$'`),
    check('ncom_events_topic_shape', sql`${table.topic} ~ '^[a-z_]{1,40}([.][a-z_]{1,40})?$'`),
  ],
);
