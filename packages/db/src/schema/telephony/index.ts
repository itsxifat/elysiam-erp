import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  customType,
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
import { fileObjects } from '../files/index.js';
import { users } from '../iam/index.js';
import { callAttempts, customers, orders } from '../orders/index.js';
import { organizations } from '../org/index.js';

/**
 * Phone calls through Envo (M47, D-830 to D-853): the brand's Envo connections, who has which
 * extension, every call with its recording, and Envo's webhook bodies as they arrived.
 *
 * Tenant tables with the full treatment (invariant 4): `org_id` with RLS ENABLE and FORCE
 * (migration `*_m47_telephony_policies`), and every tenant foreign key carries `org_id` on both
 * sides (D-047). The API key and the webhook secret are AES-256-GCM ciphertext under the
 * platform's sealed box (`STOREFRONT_CREDENTIALS_KEY`), bound to the brand, the connection and
 * the field, and shown only as a fingerprint. Phones are E.164 when they are a Bangladeshi
 * mobile, as the order desk keeps them, and masked in every log.
 */
export const telephony = pgSchema('telephony');

/** AES-256-GCM ciphertext under `STOREFRONT_CREDENTIALS_KEY` (the platform's sealed box). */
const sealedBytes = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
  fromDriver: (value) => Buffer.from(value as unknown as Uint8Array),
  toDriver: (value) => value,
});

/**
 * One Envo SIP server the brand calls through (D-830): its base URL (the only origin the ERP
 * calls or downloads from for it), its API key and webhook secret, the brand's retention for its
 * recordings, and what the ERP last heard from it (the Test, a webhook, a refused signature, the
 * sync).
 */
export const telephonyConnections = telephony.table(
  'connections',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    baseUrl: text('base_url').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    apiKeySealed: sealedBytes('api_key_sealed'),
    apiKeyKeyId: text('api_key_key_id'),
    apiKeyFingerprint: text('api_key_fingerprint'),
    webhookSecretSealed: sealedBytes('webhook_secret_sealed'),
    webhookSecretKeyId: text('webhook_secret_key_id'),
    webhookSecretFingerprint: text('webhook_secret_fingerprint'),
    recordingRetentionDays: integer('recording_retention_days').notNull().default(365),
    /** Envo's SIP server (tenant) id and name, as its `/ping` answered the last Test. */
    envoServerId: integer('envo_server_id'),
    envoServerName: text('envo_server_name'),
    lastTestedAt: timestamp('last_tested_at', { withTimezone: true, mode: 'date' }),
    lastTestOk: boolean('last_test_ok'),
    lastTestError: text('last_test_error'),
    lastWebhookAt: timestamp('last_webhook_at', { withTimezone: true, mode: 'date' }),
    lastWebhookEvent: text('last_webhook_event'),
    lastSignatureFailureAt: timestamp('last_signature_failure_at', {
      withTimezone: true,
      mode: 'date',
    }),
    lastSignatureFailureReason: text('last_signature_failure_reason'),
    /** The newest call start the sync has read (D-839). */
    syncCursor: timestamp('sync_cursor', { withTimezone: true, mode: 'date' }),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true, mode: 'date' }),
    lastSyncError: text('last_sync_error'),
    createdBy: text('created_by').notNull(),
    updatedBy: text('updated_by').notNull(),
    ...timestamps,
  },
  (table) => [
    unique('connections_org_id_id_key').on(table.orgId, table.id),
    index('connections_org_idx').on(table.orgId),
    uniqueIndex('connections_org_name_idx').on(table.orgId, table.name),
    check('connections_name', sql`char_length(${table.name}) between 1 and 60`),
    check(
      'connections_base_url',
      sql`char_length(${table.baseUrl}) <= 200 and ${table.baseUrl} ~ '^https?://[^/?#@ ]+$'`,
    ),
    check(
      'connections_api_key_whole',
      sql`(${table.apiKeySealed} is null) = (${table.apiKeyFingerprint} is null)`,
    ),
    check(
      'connections_webhook_secret_whole',
      sql`(${table.webhookSecretSealed} is null) = (${table.webhookSecretFingerprint} is null)`,
    ),
    check(
      'connections_retention',
      sql`${table.recordingRetentionDays} between 30 and 3650`,
    ),
    check('connections_server_name', sql`char_length(${table.envoServerName}) <= 80`),
    check('connections_test_error', sql`char_length(${table.lastTestError}) <= 300`),
    check('connections_webhook_event', sql`char_length(${table.lastWebhookEvent}) <= 40`),
    check(
      'connections_signature_reason',
      sql`char_length(${table.lastSignatureFailureReason}) <= 40`,
    ),
    check('connections_sync_error', sql`char_length(${table.lastSyncError}) <= 300`),
  ],
);

/**
 * One extension of a connection, given to one person of the brand (D-846): one person per
 * extension, one extension per person. Unassigning deletes the row (audited).
 */
export const telephonyExtensionAssignments = telephony.table(
  'extension_assignments',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    connectionId: uuid('connection_id').notNull(),
    extension: text('extension').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    assignedBy: text('assigned_by').notNull(),
    ...timestamps,
  },
  (table) => [
    unique('extension_assignments_org_id_id_key').on(table.orgId, table.id),
    index('extension_assignments_org_idx').on(table.orgId),
    uniqueIndex('extension_assignments_extension_idx').on(
      table.orgId,
      table.connectionId,
      table.extension,
    ),
    uniqueIndex('extension_assignments_user_idx').on(table.orgId, table.userId),
    foreignKey({
      name: 'extension_assignments_org_id_connection_id_fk',
      columns: [table.orgId, table.connectionId],
      foreignColumns: [telephonyConnections.orgId, telephonyConnections.id],
    }).onDelete('restrict'),
    check('extension_assignments_extension', sql`${table.extension} ~ '^[0-9]{2,8}$'`),
  ],
);

/**
 * One phone call through Envo (D-837): a person's click (`first_seen = 'click'`, Envo's call id
 * unknown until its first webhook names it, D-835) or a call Envo told us about (a webhook or
 * the sync). Unique per connection by Envo's call id. Its origin never changes; its progress
 * (status, answered, the numbers Envo learns, the links set once, the recording's path) moves
 * forward only, which the trigger in `*_m47_telephony_policies` enforces. Never deleted.
 */
export const telephonyCalls = telephony.table(
  'calls',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    connectionId: uuid('connection_id').notNull(),
    /** Envo's id (Asterisk's `linkedid`), once Envo has named the call. */
    envoCallId: text('envo_call_id'),
    firstSeen: text('first_seen').notNull(),
    direction: text('direction').notNull().default('unknown'),
    status: text('status').notNull(),
    /** As the ERP stores phones: E.164 for a Bangladeshi mobile, else as Envo sent it. */
    fromNumber: text('from_number'),
    toNumber: text('to_number'),
    /** The customer's side of the call, E.164. */
    customerPhoneE164: text('customer_phone_e164'),
    extension: text('extension'),
    /** The person on the call: who clicked, the extension's person, or who answered (D-836). */
    userId: text('user_id').references(() => users.id, { onDelete: 'restrict' }),
    customerId: uuid('customer_id'),
    /** The buyer's name when the call was linked, for the lists (no cross-module read). */
    customerName: text('customer_name'),
    orderId: uuid('order_id'),
    /** The order's number when the call was linked (an order number never changes). */
    orderNo: text('order_no'),
    /** The order's owner when the call was linked to it: who else hears it (D-841). */
    orderOwnerUserId: text('order_owner_user_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
    answered: boolean('answered').notNull().default(false),
    disposition: text('disposition'),
    talkSeconds: integer('talk_seconds'),
    durationSeconds: integer('duration_seconds'),
    /** When it happened, for the lists: the click, or Envo's start. Fixed. */
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' }).notNull(),
    requestedAt: timestamp('requested_at', { withTimezone: true, mode: 'date' }),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }),
    answeredAt: timestamp('answered_at', { withTimezone: true, mode: 'date' }),
    endedAt: timestamp('ended_at', { withTimezone: true, mode: 'date' }),
    /** Why a click failed (`envo_refused`, `envo_unreachable`, `not_connected`). */
    errorCode: text('error_code'),
    /** What Envo said, masked. Never a key, a secret or a whole phone. */
    errorDetail: text('error_detail'),
    recordingStatus: text('recording_status').notNull().default('none'),
    recordingUrl: text('recording_url'),
    recordingFileId: uuid('recording_file_id'),
    recordingBytes: integer('recording_bytes'),
    recordingAttempts: integer('recording_attempts').notNull().default(0),
    recordingError: text('recording_error'),
    /** M41's verification attempt recorded for this call (D-838), once. */
    outcomeAttemptId: uuid('outcome_attempt_id'),
    outcome: text('outcome'),
    lastEvent: text('last_event'),
    lastEventAt: timestamp('last_event_at', { withTimezone: true, mode: 'date' }),
    ...timestamps,
  },
  (table) => [
    unique('calls_org_id_id_key').on(table.orgId, table.id),
    index('calls_org_idx').on(table.orgId),
    uniqueIndex('calls_org_envo_idx')
      .on(table.orgId, table.connectionId, table.envoCallId)
      .where(sql`${table.envoCallId} is not null`),
    index('calls_org_occurred_idx').on(table.orgId, table.occurredAt),
    index('calls_org_user_idx').on(table.orgId, table.userId, table.occurredAt),
    index('calls_org_order_idx').on(table.orgId, table.orderId),
    index('calls_org_customer_idx').on(table.orgId, table.customerId),
    index('calls_org_phone_idx').on(table.orgId, table.customerPhoneE164),
    index('calls_org_pending_clicks_idx')
      .on(table.orgId, table.connectionId, table.requestedAt)
      .where(sql`${table.envoCallId} is null and ${table.status} in ('requested', 'dialing')`),
    index('calls_org_recording_idx')
      .on(table.orgId, table.endedAt)
      .where(sql`${table.recordingStatus} = 'stored'`),
    foreignKey({
      name: 'calls_org_id_connection_id_fk',
      columns: [table.orgId, table.connectionId],
      foreignColumns: [telephonyConnections.orgId, telephonyConnections.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'calls_org_id_customer_id_fk',
      columns: [table.orgId, table.customerId],
      foreignColumns: [customers.orgId, customers.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'calls_org_id_order_id_fk',
      columns: [table.orgId, table.orderId],
      foreignColumns: [orders.orgId, orders.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'calls_org_id_recording_file_id_fk',
      columns: [table.orgId, table.recordingFileId],
      foreignColumns: [fileObjects.orgId, fileObjects.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'calls_org_id_outcome_attempt_id_fk',
      columns: [table.orgId, table.outcomeAttemptId],
      foreignColumns: [callAttempts.orgId, callAttempts.id],
    }).onDelete('restrict'),
    check('calls_first_seen', sql`${table.firstSeen} in ('click', 'webhook', 'sync')`),
    check(
      'calls_direction',
      sql`${table.direction} in ('inbound', 'outbound', 'internal', 'unknown')`,
    ),
    check(
      'calls_status',
      sql`${table.status} in ('requested', 'dialing', 'failed', 'ringing', 'answered', 'ended')`,
    ),
    check(
      'calls_envo_call_id',
      sql`${table.envoCallId} is null or ${table.envoCallId} ~ '^[0-9]{1,20}([.][0-9]{1,10})?$'`,
    ),
    check(
      'calls_click_or_envo',
      sql`${table.firstSeen} = 'click' or ${table.envoCallId} is not null`,
    ),
    check(
      'calls_numbers',
      sql`char_length(${table.fromNumber}) <= 40 and char_length(${table.toNumber}) <= 40`,
    ),
    check(
      'calls_customer_phone',
      sql`${table.customerPhoneE164} is null or ${table.customerPhoneE164} ~ '^[+]8801[13-9][0-9]{8}$'`,
    ),
    check(
      'calls_extension',
      sql`${table.extension} is null or ${table.extension} ~ '^[0-9]{2,8}$'`,
    ),
    check(
      'calls_disposition',
      sql`${table.disposition} is null or ${table.disposition} in ('answered', 'no_answer', 'busy', 'failed', 'congestion', 'unknown')`,
    ),
    check(
      'calls_seconds',
      sql`(${table.talkSeconds} is null or ${table.talkSeconds} >= 0) and (${table.durationSeconds} is null or ${table.durationSeconds} >= 0)`,
    ),
    check('calls_error_code', sql`char_length(${table.errorCode}) <= 40`),
    check('calls_error_detail', sql`char_length(${table.errorDetail}) <= 300`),
    check(
      'calls_recording_status',
      sql`${table.recordingStatus} in ('none', 'pending', 'stored', 'failed', 'expired')`,
    ),
    check(
      'calls_recording_stored_has_file',
      sql`(${table.recordingStatus} = 'stored') = (${table.recordingFileId} is not null)`,
    ),
    check('calls_recording_url', sql`char_length(${table.recordingUrl}) <= 500`),
    check('calls_recording_error', sql`char_length(${table.recordingError}) <= 40`),
    check(
      'calls_outcome',
      sql`${table.outcome} is null or ${table.outcome} in ('reached', 'no_answer', 'busy', 'wrong_number', 'call_back')`,
    ),
    check(
      'calls_outcome_whole',
      sql`(${table.outcome} is null) = (${table.outcomeAttemptId} is null)`,
    ),
    check('calls_last_event', sql`char_length(${table.lastEvent}) <= 20`),
    check('calls_customer_name', sql`char_length(${table.customerName}) <= 120`),
    check('calls_order_no', sql`char_length(${table.orderNo}) <= 40`),
    check('calls_order_whole', sql`(${table.orderId} is null) = (${table.orderNo} is null)`),
  ],
);

/**
 * Envo's webhook bodies as they arrived (D-832), stored before anything is done with them and
 * threaded into `calls` by `telephony.process_webhook`. One row per connection, call and event:
 * a repeated delivery (Envo retries after a timeout, a second webhook pointing here) is stored
 * once. Only `processed_at` and `outcome` ever change.
 */
export const telephonyWebhookEvents = telephony.table(
  'webhook_events',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    connectionId: uuid('connection_id').notNull(),
    event: text('event').notNull(),
    envoCallId: text('envo_call_id').notNull(),
    /** `X-Envo-Delivery`, when Envo sent one. */
    deliveryId: text('delivery_id'),
    body: jsonb('body').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true, mode: 'date' }),
    outcome: text('outcome'),
    ...timestamps,
  },
  (table) => [
    unique('webhook_events_org_id_id_key').on(table.orgId, table.id),
    index('webhook_events_org_idx').on(table.orgId),
    uniqueIndex('webhook_events_org_call_event_idx').on(
      table.orgId,
      table.connectionId,
      table.envoCallId,
      table.event,
    ),
    index('webhook_events_org_unprocessed_idx')
      .on(table.orgId, table.receivedAt)
      .where(sql`${table.processedAt} is null`),
    foreignKey({
      name: 'webhook_events_org_id_connection_id_fk',
      columns: [table.orgId, table.connectionId],
      foreignColumns: [telephonyConnections.orgId, telephonyConnections.id],
    }).onDelete('restrict'),
    check(
      'webhook_events_event',
      sql`${table.event} in ('call.started', 'call.answered', 'call.ended')`,
    ),
    check(
      'webhook_events_envo_call_id',
      sql`${table.envoCallId} ~ '^[0-9]{1,20}([.][0-9]{1,10})?$'`,
    ),
    check('webhook_events_delivery_id', sql`char_length(${table.deliveryId}) <= 64`),
    check('webhook_events_outcome', sql`char_length(${table.outcome}) <= 40`),
  ],
);
