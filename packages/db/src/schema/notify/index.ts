import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
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
    bodyBn: text('body_bn').notNull(),
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
    check(
      'notify_templates_bodies',
      sql`length(${table.bodyBn}) between 1 and 1000 and length(${table.bodyEn}) between 1 and 1000`,
    ),
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
    locale: text('locale').notNull().default('bn'),
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
