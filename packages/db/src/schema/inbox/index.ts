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

import { products, skus } from '../catalog/index.js';
import { primaryId, timestamps } from '../columns.js';
import { users } from '../iam/index.js';
import { customers } from '../orders/index.js';
import { organizations } from '../org/index.js';
import { districts, thanas } from '../ref/index.js';

/**
 * The unified inbox (M42, D-730 to D-749): Messenger, Instagram and WhatsApp conversations, the
 * people in them, what was said, and what the brand knows about each person.
 *
 * Tenant tables with the full treatment (invariant 4): `org_id` with RLS ENABLE and FORCE
 * (migration `*_m42_inbox_policies`), and every tenant foreign key carries `org_id` on both
 * sides (D-047). Meta's secrets are AES-256-GCM ciphertext under the platform's sealed box
 * (D-733), bound to the brand, the row and the field, and shown only as a fingerprint.
 */
export const inbox = pgSchema('inbox');

/** AES-256-GCM ciphertext under `STOREFRONT_CREDENTIALS_KEY` (the platform's sealed box). */
const sealedBytes = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
  fromDriver: (value) => Buffer.from(value as unknown as Uint8Array),
  toDriver: (value) => value,
});

/**
 * The brand's Meta app (D-733): the app secret every webhook is signed with, and the verify
 * token Meta's subscription check echoes. One row per brand.
 */
export const inboxSettings = inbox.table(
  'settings',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    appSecretSealed: sealedBytes('app_secret_sealed'),
    appSecretKeyId: text('app_secret_key_id'),
    appSecretFingerprint: text('app_secret_fingerprint'),
    verifyTokenSealed: sealedBytes('verify_token_sealed'),
    verifyTokenKeyId: text('verify_token_key_id'),
    verifyTokenFingerprint: text('verify_token_fingerprint'),
    updatedBy: text('updated_by').notNull(),
    ...timestamps,
  },
  (table) => [
    unique('settings_org_id_id_key').on(table.orgId, table.id),
    uniqueIndex('settings_org_idx').on(table.orgId),
    check(
      'settings_app_secret_whole',
      sql`(${table.appSecretSealed} is null) = (${table.appSecretFingerprint} is null)`,
    ),
    check(
      'settings_verify_token_whole',
      sql`(${table.verifyTokenSealed} is null) = (${table.verifyTokenFingerprint} is null)`,
    ),
  ],
);

/**
 * One channel of a kind per brand (D-731): the Facebook Page (`messenger`, external id = the
 * Page id), the Instagram professional account linked to it (`instagram`, = the Instagram
 * account id; it sends with the Page's token) and the WhatsApp business number (`whatsapp`, =
 * the phone number id). The external id routes an incoming webhook to its channel.
 */
export const inboxChannels = inbox.table(
  'channels',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    kind: text('kind').notNull(),
    externalId: text('external_id').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    accessTokenSealed: sealedBytes('access_token_sealed'),
    accessTokenKeyId: text('access_token_key_id'),
    accessTokenFingerprint: text('access_token_fingerprint'),
    updatedBy: text('updated_by').notNull(),
    ...timestamps,
  },
  (table) => [
    unique('channels_org_id_id_key').on(table.orgId, table.id),
    uniqueIndex('channels_org_kind_idx').on(table.orgId, table.kind),
    index('channels_org_idx').on(table.orgId),
    check('channels_kind', sql`${table.kind} in ('messenger', 'instagram', 'whatsapp')`),
    check('channels_external_id', sql`${table.externalId} ~ '^[0-9]{1,30}$'`),
    check(
      'channels_token_whole',
      sql`(${table.accessTokenSealed} is null) = (${table.accessTokenFingerprint} is null)`,
    ),
  ],
);

/**
 * A person the brand talks to (D-738, D-739): their stage, the phone and address an agent saved,
 * the brand's customer with that phone, and tags. A person reached on two channels is two
 * contacts until someone merges them (a follow-up).
 */
export const inboxContacts = inbox.table(
  'contacts',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    displayName: text('display_name'),
    stage: text('stage').notNull().default('visitor'),
    /** Who set the stage last: a person's id, or `system` when an order made them a customer. */
    stageSetBy: text('stage_set_by'),
    stageSetAt: timestamp('stage_set_at', { withTimezone: true, mode: 'date' }),
    /** E.164, as the order desk keys buyers. Masked in every log. */
    phoneE164: text('phone_e164'),
    customerId: uuid('customer_id'),
    districtId: integer('district_id').references(() => districts.id),
    thanaId: integer('thana_id').references(() => thanas.id),
    area: text('area'),
    addressLine: text('address_line'),
    tags: text('tags')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    ...timestamps,
  },
  (table) => [
    unique('contacts_org_id_id_key').on(table.orgId, table.id),
    index('contacts_org_idx').on(table.orgId),
    index('contacts_org_phone_idx').on(table.orgId, table.phoneE164),
    index('contacts_org_customer_idx').on(table.orgId, table.customerId),
    foreignKey({
      name: 'contacts_org_id_customer_id_fk',
      columns: [table.orgId, table.customerId],
      foreignColumns: [customers.orgId, customers.id],
    }).onDelete('restrict'),
    check(
      'contacts_stage',
      sql`${table.stage} in ('visitor', 'lead', 'customer', 'not_qualified', 'fraud')`,
    ),
    check(
      'contacts_phone',
      sql`${table.phoneE164} is null or ${table.phoneE164} ~ '^\\+8801[13-9][0-9]{8}$'`,
    ),
    check('contacts_display_name', sql`char_length(${table.displayName}) <= 200`),
    check('contacts_area', sql`char_length(${table.area}) <= 160`),
    check('contacts_address_line', sql`char_length(${table.addressLine}) <= 500`),
    check('contacts_tags', sql`cardinality(${table.tags}) <= 20`),
  ],
);

/** A contact's id on one channel: a PSID (Messenger), an IGSID (Instagram) or a wa_id. */
export const inboxIdentities = inbox.table(
  'identities',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    contactId: uuid('contact_id').notNull(),
    channelId: uuid('channel_id').notNull(),
    externalUserId: text('external_user_id').notNull(),
    /** The name Meta sent with the message (WhatsApp's `profile.name`), when it sent one. */
    profileName: text('profile_name'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    unique('identities_org_id_id_key').on(table.orgId, table.id),
    index('identities_org_idx').on(table.orgId),
    uniqueIndex('identities_org_channel_user_idx').on(
      table.orgId,
      table.channelId,
      table.externalUserId,
    ),
    index('identities_org_contact_idx').on(table.orgId, table.contactId),
    foreignKey({
      name: 'identities_org_id_contact_id_fk',
      columns: [table.orgId, table.contactId],
      foreignColumns: [inboxContacts.orgId, inboxContacts.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'identities_org_id_channel_id_fk',
      columns: [table.orgId, table.channelId],
      foreignColumns: [inboxChannels.orgId, inboxChannels.id],
    }).onDelete('restrict'),
    check(
      'identities_external_user_id',
      sql`char_length(${table.externalUserId}) between 1 and 64`,
    ),
  ],
);

/**
 * One thread per identity (D-737): who owns it, whether it is open, and what the list shows.
 * `last_inbound_at` is the start of the reply window (D-734).
 */
export const inboxConversations = inbox.table(
  'conversations',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    channelId: uuid('channel_id').notNull(),
    contactId: uuid('contact_id').notNull(),
    identityId: uuid('identity_id').notNull(),
    assignedTo: text('assigned_to').references(() => users.id, { onDelete: 'restrict' }),
    assignedAt: timestamp('assigned_at', { withTimezone: true, mode: 'date' }),
    status: text('status').notNull().default('open'),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    lastInboundAt: timestamp('last_inbound_at', { withTimezone: true, mode: 'date' }),
    lastPreview: text('last_preview'),
    lastDirection: text('last_direction'),
    unreadCount: integer('unread_count').notNull().default(0),
    ...timestamps,
  },
  (table) => [
    unique('conversations_org_id_id_key').on(table.orgId, table.id),
    index('conversations_org_idx').on(table.orgId),
    uniqueIndex('conversations_org_identity_idx').on(table.orgId, table.identityId),
    index('conversations_org_last_idx').on(table.orgId, table.lastMessageAt),
    index('conversations_org_assignee_idx').on(table.orgId, table.assignedTo),
    index('conversations_org_contact_idx').on(table.orgId, table.contactId),
    foreignKey({
      name: 'conversations_org_id_channel_id_fk',
      columns: [table.orgId, table.channelId],
      foreignColumns: [inboxChannels.orgId, inboxChannels.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'conversations_org_id_contact_id_fk',
      columns: [table.orgId, table.contactId],
      foreignColumns: [inboxContacts.orgId, inboxContacts.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'conversations_org_id_identity_id_fk',
      columns: [table.orgId, table.identityId],
      foreignColumns: [inboxIdentities.orgId, inboxIdentities.id],
    }).onDelete('restrict'),
    check('conversations_status', sql`${table.status} in ('open', 'closed')`),
    check(
      'conversations_last_direction',
      sql`${table.lastDirection} is null or ${table.lastDirection} in ('inbound', 'outbound')`,
    ),
    check('conversations_unread', sql`${table.unreadCount} >= 0`),
    check(
      'conversations_assignment_whole',
      sql`(${table.assignedTo} is null) = (${table.assignedAt} is null)`,
    ),
  ],
);

/**
 * A conversation offered to one person (D-748), answered once, like M41's order offers
 * (`sales.order_offers`, D-717): offered, then accepted, declined, expired or withdrawn. One live
 * offer per conversation and one per person (two partial unique indexes); the policies
 * migration refuses any other change to an offer with a trigger and grants no DELETE, so who
 * declined what stays, which is what keeps a conversation from going round the same person.
 */
export const inboxConversationOffers = inbox.table(
  'conversation_offers',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    conversationId: uuid('conversation_id').notNull(),
    /** `iam.users.id`, text like `assigned_to`. */
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    status: text('status').notNull().default('offered'),
    offeredAt: timestamp('offered_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    respondedAt: timestamp('responded_at', { withTimezone: true, mode: 'date' }),
    ...timestamps,
  },
  (table) => [
    unique('conversation_offers_org_id_id_key').on(table.orgId, table.id),
    index('conversation_offers_org_idx').on(table.orgId),
    index('conversation_offers_org_conversation_idx').on(table.orgId, table.conversationId),
    index('conversation_offers_org_user_idx').on(table.orgId, table.userId, table.offeredAt),
    uniqueIndex('conversation_offers_live_conversation_idx')
      .on(table.orgId, table.conversationId)
      .where(sql`${table.status} = 'offered'`),
    uniqueIndex('conversation_offers_live_user_idx')
      .on(table.orgId, table.userId)
      .where(sql`${table.status} = 'offered'`),
    foreignKey({
      name: 'conversation_offers_org_id_conversation_id_fk',
      columns: [table.orgId, table.conversationId],
      foreignColumns: [inboxConversations.orgId, inboxConversations.id],
    }).onDelete('restrict'),
    check(
      'conversation_offers_status',
      sql`${table.status} in ('offered', 'accepted', 'declined', 'expired', 'withdrawn')`,
    ),
    check(
      'conversation_offers_answered',
      sql`(${table.status} = 'offered') = (${table.respondedAt} is null)`,
    ),
    check('conversation_offers_expiry', sql`${table.expiresAt} > ${table.offeredAt}`),
  ],
);

/**
 * What was said (D-735, D-744, D-746). An inbound message is keyed by Meta's id (`mid`,
 * `wamid`), unique per brand, so a retried webhook threads it once. An outbound one is written
 * `queued` with the reply, before the job sends it, and gets Meta's id when Meta accepts it.
 * Attachments are their metadata only: type, Meta's URL or media id, MIME type, caption.
 */
export const inboxMessages = inbox.table(
  'messages',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    conversationId: uuid('conversation_id').notNull(),
    direction: text('direction').notNull(),
    body: text('body'),
    attachments: jsonb('attachments').notNull().default([]),
    providerMessageId: text('provider_message_id'),
    status: text('status').notNull(),
    /** Set on an outbound message: the person who wrote it, or null for one sent from Meta's own inbox. */
    sentBy: text('sent_by').references(() => users.id, { onDelete: 'restrict' }),
    /** When it happened by Meta's clock (inbound), or when we wrote it (outbound). */
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' }).notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true, mode: 'date' }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true, mode: 'date' }),
    readAt: timestamp('read_at', { withTimezone: true, mode: 'date' }),
    failedAt: timestamp('failed_at', { withTimezone: true, mode: 'date' }),
    /** Why it failed: Meta's error code, or ours (`window_closed`, `channel_not_ready`). Never a token. */
    errorCode: text('error_code'),
    errorDetail: text('error_detail'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    unique('messages_org_id_id_key').on(table.orgId, table.id),
    index('messages_org_idx').on(table.orgId),
    uniqueIndex('messages_org_provider_idx')
      .on(table.orgId, table.providerMessageId)
      .where(sql`${table.providerMessageId} is not null`),
    index('messages_org_conversation_idx').on(table.orgId, table.conversationId, table.occurredAt),
    foreignKey({
      name: 'messages_org_id_conversation_id_fk',
      columns: [table.orgId, table.conversationId],
      foreignColumns: [inboxConversations.orgId, inboxConversations.id],
    }).onDelete('restrict'),
    check('messages_direction', sql`${table.direction} in ('inbound', 'outbound')`),
    check(
      'messages_status',
      sql`(${table.direction} = 'inbound' and ${table.status} = 'received')
        or (${table.direction} = 'outbound'
            and ${table.status} in ('queued', 'sent', 'delivered', 'read', 'failed'))`,
    ),
    check('messages_body', sql`char_length(${table.body}) <= 4096`),
    check('messages_provider_id', sql`char_length(${table.providerMessageId}) <= 256`),
    check('messages_error_detail', sql`char_length(${table.errorDetail}) <= 500`),
  ],
);

/** "What we talked about today" (D-738): dated, by whom, never edited. */
export const inboxNotes = inbox.table(
  'notes',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    contactId: uuid('contact_id').notNull(),
    body: text('body').notNull(),
    authorUserId: text('author_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    unique('notes_org_id_id_key').on(table.orgId, table.id),
    index('notes_org_idx').on(table.orgId),
    index('notes_org_contact_idx').on(table.orgId, table.contactId, table.createdAt),
    foreignKey({
      name: 'notes_org_id_contact_id_fk',
      columns: [table.orgId, table.contactId],
      foreignColumns: [inboxContacts.orgId, inboxContacts.id],
    }).onDelete('restrict'),
    check('notes_body', sql`char_length(${table.body}) between 1 and 2000`),
  ],
);

/** A product a contact asked about (D-741), and optionally the size or colour. */
export const inboxInterests = inbox.table(
  'interests',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    contactId: uuid('contact_id').notNull(),
    productId: uuid('product_id').notNull(),
    skuId: uuid('sku_id'),
    addedBy: text('added_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    unique('interests_org_id_id_key').on(table.orgId, table.id),
    index('interests_org_idx').on(table.orgId),
    uniqueIndex('interests_org_contact_product_idx').on(
      table.orgId,
      table.contactId,
      table.productId,
    ),
    foreignKey({
      name: 'interests_org_id_contact_id_fk',
      columns: [table.orgId, table.contactId],
      foreignColumns: [inboxContacts.orgId, inboxContacts.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'interests_org_id_product_id_fk',
      columns: [table.orgId, table.productId],
      foreignColumns: [products.orgId, products.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'interests_org_id_sku_id_fk',
      columns: [table.orgId, table.skuId],
      foreignColumns: [skus.orgId, skus.id],
    }).onDelete('restrict'),
  ],
);

/**
 * Every signed webhook body, stored before it is processed (D-732; the integration rules: store
 * the raw payload first, process in a job). Unique per brand by its SHA-256, so Meta's retry of
 * the same body is recognised at once. The body is cleared once processed; the hash stays.
 */
export const inboxWebhookEvents = inbox.table(
  'webhook_events',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    /** Meta's `object`: `page`, `instagram` or `whatsapp_business_account`. */
    object: text('object').notNull(),
    bodySha256: text('body_sha256').notNull(),
    body: jsonb('body'),
    receivedAt: timestamp('received_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true, mode: 'date' }),
    /** What processing found: messages threaded, receipts applied, entries skipped. */
    outcome: jsonb('outcome'),
  },
  (table) => [
    unique('webhook_events_org_id_id_key').on(table.orgId, table.id),
    index('webhook_events_org_idx').on(table.orgId),
    uniqueIndex('webhook_events_org_sha_idx').on(table.orgId, table.bodySha256),
    check(
      'webhook_events_object',
      sql`${table.object} in ('page', 'instagram', 'whatsapp_business_account')`,
    ),
    check('webhook_events_sha', sql`${table.bodySha256} ~ '^[0-9a-f]{64}$'`),
  ],
);
