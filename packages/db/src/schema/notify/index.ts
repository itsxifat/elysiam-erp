import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  customType,
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
import { organizations } from '../org/index.js';

/**
 * Notifications (architecture §10, M16): templates, the opt-out list, and the
 * delivery log.
 *
 * A message row is written in the transaction that decides to send it, and a job
 * does the sending (invariant 6: no external call inside a transaction). The row is
 * the log: what was sent to whom, when, through which provider id, or why not.
 *
 * The recipient's number is stored because it is the address. It stays in this
 * tenant table, is masked in every log line, and never leaves in an event payload
 * (invariant 10).
 */
export const notify = pgSchema('notify');

export const notifyTemplates = notify.table(
  'templates',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    /** What the template is for: `occasion.birthday`, `order.confirmed`. */
    key: text('key').notNull(),
    channel: text('channel').notNull().default('sms'),
    /** Decides quiet hours: only `otp` is sent between 21:00 and 09:00 Dhaka. */
    category: text('category').notNull(),
    /** The one body, in English (D-750); `body_bn` was dropped by D-755's migration. */
    bodyEn: text('body_en').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    updatedBy: text('updated_by').notNull(),
    ...timestamps,
  },
  (table) => [
    unique('notify_templates_org_id_id_key').on(table.orgId, table.id),
    index('notify_templates_org_idx').on(table.orgId),
    uniqueIndex('notify_templates_org_key_channel_idx').on(table.orgId, table.key, table.channel),
    check('notify_templates_key_shape', sql`${table.key} ~ '^[a-z][a-z0-9_.]{2,63}$'`),
    check('notify_templates_channel', sql`${table.channel} in ('sms')`),
    check(
      'notify_templates_category',
      sql`${table.category} in ('otp', 'transactional', 'marketing')`,
    ),
    check('notify_templates_bodies', sql`length(${table.bodyEn}) between 1 and 1000`),
  ],
);

export const notifyOptOuts = notify.table(
  'opt_outs',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    /** The 11-digit Bangladeshi mobile, as every other table stores it (D-170). */
    phone: text('phone').notNull(),
    channel: text('channel').notNull().default('sms'),
    reason: text('reason'),
    createdBy: text('created_by').notNull(),
    ...timestamps,
  },
  (table) => [
    unique('notify_opt_outs_org_id_id_key').on(table.orgId, table.id),
    index('notify_opt_outs_org_idx').on(table.orgId),
    uniqueIndex('notify_opt_outs_org_phone_channel_idx').on(
      table.orgId,
      table.phone,
      table.channel,
    ),
    check('notify_opt_outs_phone_shape', sql`${table.phone} ~ '^01[3-9][0-9]{8}$'`),
    check('notify_opt_outs_channel', sql`${table.channel} in ('sms')`),
  ],
);

export const notifyMessages = notify.table(
  'messages',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    templateKey: text('template_key').notNull(),
    channel: text('channel').notNull().default('sms'),
    category: text('category').notNull(),
    phone: text('phone').notNull(),
    locale: text('locale').notNull().default('en'),
    body: text('body').notNull(),
    state: text('state').notNull().default('queued'),
    /** Not before this instant: quiet hours move it to the next 09:00 Dhaka. */
    sendAfter: timestamp('send_after', { withTimezone: true, mode: 'date' }).notNull(),
    attempts: integer('attempts').notNull().default(0),
    provider: text('provider'),
    providerMessageId: text('provider_message_id'),
    error: text('error'),
    sentAt: timestamp('sent_at', { withTimezone: true, mode: 'date' }),
    /** What caused it: `occasion`, `order`. Ids only. */
    refType: text('ref_type'),
    refId: uuid('ref_id'),
    ...timestamps,
  },
  (table) => [
    unique('notify_messages_org_id_id_key').on(table.orgId, table.id),
    index('notify_messages_org_idx').on(table.orgId),
    index('notify_messages_org_state_idx').on(table.orgId, table.state, table.sendAfter),
    index('notify_messages_org_ref_idx').on(table.orgId, table.refType, table.refId),
    check('notify_messages_channel', sql`${table.channel} in ('sms')`),
    check(
      'notify_messages_category',
      sql`${table.category} in ('otp', 'transactional', 'marketing')`,
    ),
    check('notify_messages_locale', sql`${table.locale} in ('bn', 'en')`),
    check('notify_messages_phone_shape', sql`${table.phone} ~ '^01[3-9][0-9]{8}$'`),
    check(
      'notify_messages_state',
      sql`${table.state} in ('queued', 'sent', 'failed', 'suppressed')`,
    ),
    check(
      'notify_messages_sent_complete',
      sql`(${table.state} = 'sent') = (${table.sentAt} is not null)`,
    ),
  ],
);

// --- M34: email (D-529) ----------------------------------------------------------------------

/** AES-256-GCM ciphertext, sealed and opened only by the server's `sealed-box.ts` (D-528). */
const sealedBytes = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
  fromDriver: (value) => Buffer.from(value as unknown as Uint8Array),
  toDriver: (value) => value,
});

/**
 * The brand's email server (D-529): the website's codes, password links and order news go out
 * through it. One row per brand; the password sealed under `STOREFRONT_CREDENTIALS_KEY`
 * (D-528), never readable from a response, a log or a backup.
 */
export const notifyEmailSettings = notify.table(
  'email_settings',
  {
    orgId: uuid('org_id')
      .primaryKey()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    enabled: boolean('enabled').notNull().default(false),
    host: text('host').notNull(),
    port: integer('port').notNull(),
    /** TLS from the first byte (465); otherwise STARTTLS is required. */
    secure: boolean('secure').notNull(),
    username: text('username').notNull().default(''),
    passwordSealed: sealedBytes('password_sealed'),
    keyId: text('key_id'),
    fingerprint: text('fingerprint'),
    fromName: text('from_name').notNull(),
    fromEmail: text('from_email').notNull(),
    updatedBy: text('updated_by').notNull(),
    ...timestamps,
  },
  (table) => [
    index('notify_email_settings_org_idx').on(table.orgId),
    check('notify_email_settings_port', sql`${table.port} between 1 and 65535`),
    check('notify_email_settings_host', sql`${table.host} ~ '^[A-Za-z0-9.-]{1,253}$'`),
    check(
      'notify_email_settings_from_email',
      sql`${table.fromEmail} ~ '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$'`,
    ),
    check(
      'notify_email_settings_password_complete',
      sql`(${table.passwordSealed} is null) = (${table.keyId} is null)
          and (${table.keyId} is null) = (${table.fingerprint} is null)`,
    ),
  ],
);

/**
 * The email outbox and delivery log (D-529), as `messages` is for SMS.
 *
 * Written in the transaction that decides to send it, sent by the `notify.send_email` job with
 * no transaction open (invariant 6). The rendered body can carry a one-time code or a link, so
 * it is kept **sealed** and cleared once the email is sent or has failed for good: the row then
 * says what was sent to whom and when, and nothing a reader could reuse. `dedupe_key` makes an
 * order's status email once per order and status however often the event is delivered.
 */
export const notifyEmails = notify.table(
  'emails',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    templateKey: text('template_key').notNull(),
    locale: text('locale').notNull().default('en'),
    toEmail: text('to_email').notNull(),
    subject: text('subject').notNull(),
    bodySealed: sealedBytes('body_sealed'),
    state: text('state').notNull().default('queued'),
    attempts: integer('attempts').notNull().default(0),
    providerMessageId: text('provider_message_id'),
    error: text('error'),
    sentAt: timestamp('sent_at', { withTimezone: true, mode: 'date' }),
    refType: text('ref_type'),
    refId: uuid('ref_id'),
    dedupeKey: text('dedupe_key'),
    ...timestamps,
  },
  (table) => [
    unique('notify_emails_org_id_id_key').on(table.orgId, table.id),
    index('notify_emails_org_idx').on(table.orgId),
    index('notify_emails_org_state_idx').on(table.orgId, table.state, table.createdAt),
    index('notify_emails_org_ref_idx').on(table.orgId, table.refType, table.refId),
    uniqueIndex('notify_emails_org_dedupe_idx')
      .on(table.orgId, table.dedupeKey)
      .where(sql`${table.dedupeKey} is not null`),
    check('notify_emails_state', sql`${table.state} in ('queued', 'sent', 'failed', 'skipped')`),
    check('notify_emails_locale', sql`${table.locale} in ('bn', 'en')`),
    check('notify_emails_template_key', sql`${table.templateKey} ~ '^[a-z][a-z0-9_.]{2,63}$'`),
    check(
      'notify_emails_sent_complete',
      sql`(${table.state} = 'sent') = (${table.sentAt} is not null)`,
    ),
    // A body is held only while the email can still be sent.
    check(
      'notify_emails_body_only_while_queued',
      sql`${table.bodySealed} is null or ${table.state} = 'queued'`,
    ),
  ],
);
