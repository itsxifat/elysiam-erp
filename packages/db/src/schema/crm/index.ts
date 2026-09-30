import { sql } from 'drizzle-orm';
import {
  check,
  date,
  foreignKey,
  index,
  integer,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { primaryId, timestamps } from '../columns.js';
import { notifyMessages } from '../notify/index.js';
import { customers, sales } from '../orders/index.js';
import { organizations } from '../org/index.js';
import { promoCodes } from '../promo/index.js';

/**
 * What the brand knows about its buyers beyond their orders (architecture §10, M16).
 *
 * In the `sales` schema, beside `customers`, because they describe customers; their
 * own file because they arrive with M16 and the orders schema file is M10's.
 */

/** Each buyer's RFM scores, recomputed nightly. One row per buyer, replaced. */
export const customerSegments = sales.table(
  'customer_segments',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    customerId: uuid('customer_id').notNull(),
    recency: smallint('recency').notNull(),
    frequency: smallint('frequency').notNull(),
    monetary: smallint('monetary').notNull(),
    segment: text('segment').notNull(),
    /** The Asia/Dhaka date the scores were computed for. */
    computedOn: date('computed_on', { mode: 'string' }).notNull(),
    ...timestamps,
  },
  (table) => [
    unique('customer_segments_org_id_id_key').on(table.orgId, table.id),
    index('customer_segments_org_idx').on(table.orgId),
    uniqueIndex('customer_segments_org_customer_idx').on(table.orgId, table.customerId),
    index('customer_segments_org_segment_idx').on(table.orgId, table.segment),
    foreignKey({
      name: 'customer_segments_org_id_customer_id_fk',
      columns: [table.orgId, table.customerId],
      foreignColumns: [customers.orgId, customers.id],
    }).onDelete('restrict'),
    check(
      'customer_segments_scores',
      sql`${table.recency} between 0 and 5 and ${table.frequency} between 0 and 5 and ${table.monetary} between 0 and 5`,
    ),
    check(
      'customer_segments_segment',
      sql`${table.segment} in ('champions', 'loyal', 'new', 'promising', 'at_risk', 'hibernating', 'needs_attention', 'prospect')`,
    ),
  ],
);

/**
 * Every birthday or anniversary greeting issued (M16 check 2).
 *
 * Unique per buyer, occasion and year, in the database: a second run of the daily
 * job, or two workers running it at once, finds the row and issues nothing. The
 * code and the message are written in the same transaction as this row.
 */
export const occasionIssues = sales.table(
  'occasion_issues',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    customerId: uuid('customer_id').notNull(),
    occasion: text('occasion').notNull(),
    year: integer('year').notNull(),
    promoCodeId: uuid('promo_code_id'),
    messageId: uuid('message_id'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    unique('occasion_issues_org_id_id_key').on(table.orgId, table.id),
    index('occasion_issues_org_idx').on(table.orgId),
    uniqueIndex('occasion_issues_org_customer_occasion_year_idx').on(
      table.orgId,
      table.customerId,
      table.occasion,
      table.year,
    ),
    foreignKey({
      name: 'occasion_issues_org_id_customer_id_fk',
      columns: [table.orgId, table.customerId],
      foreignColumns: [customers.orgId, customers.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'occasion_issues_org_id_promo_code_id_fk',
      columns: [table.orgId, table.promoCodeId],
      foreignColumns: [promoCodes.orgId, promoCodes.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'occasion_issues_org_id_message_id_fk',
      columns: [table.orgId, table.messageId],
      foreignColumns: [notifyMessages.orgId, notifyMessages.id],
    }).onDelete('restrict'),
    check('occasion_issues_occasion', sql`${table.occasion} in ('birthday', 'anniversary')`),
    check('occasion_issues_year', sql`${table.year} between 2000 and 2999`),
  ],
);
