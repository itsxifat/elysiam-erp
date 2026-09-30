import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
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
import { customers, orders } from '../orders/index.js';
import { organizations } from '../org/index.js';
import { posSales } from '../pos/index.js';

/**
 * Promo codes and their redemption ledger (architecture §10, M16).
 *
 * The code carries its own count of uses, and a redemption takes one with a
 * conditional UPDATE (`used_count < total_limit`), exactly like a stock reservation
 * (invariant 3): two orders racing for the last use of a code cannot both get it,
 * and nothing reads the count and then writes it.
 */
export const promo = pgSchema('promo');

export const promoCodes = promo.table(
  'codes',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    /** Stored upper-case and trimmed; people type codes however they like. */
    code: text('code').notNull(),
    kind: text('kind').notNull(),
    /** Percent codes: basis points. */
    valueBps: integer('value_bps').notNull().default(0),
    /** Flat codes: the amount off. */
    valuePoisha: bigint('value_poisha', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    minOrderPoisha: bigint('min_order_poisha', { mode: 'bigint' }),
    maxDiscountPoisha: bigint('max_discount_poisha', { mode: 'bigint' }),
    totalLimit: integer('total_limit'),
    perCustomerLimit: integer('per_customer_limit'),
    /** Uses applied and not released. Moved only by the conditional update. */
    usedCount: integer('used_count').notNull().default(0),
    /** Asia/Dhaka calendar dates, both inclusive. */
    validFrom: date('valid_from', { mode: 'string' }),
    validTo: date('valid_to', { mode: 'string' }),
    /** Empty arrays: every channel, the whole basket. */
    channels: jsonb('channels').notNull().default([]),
    skuIds: jsonb('sku_ids').notNull().default([]),
    categoryIds: jsonb('category_ids').notNull().default([]),
    /** A personal code: this buyer's and nobody else's. */
    customerId: uuid('customer_id'),
    /** M18 reads this; nothing does yet. */
    campaignId: uuid('campaign_id'),
    /** Why the code exists: made by a person, or issued by the occasions job. */
    origin: text('origin').notNull().default('manual'),
    status: text('status').notNull().default('active'),
    createdBy: text('created_by').notNull(),
    ...timestamps,
  },
  (table) => [
    unique('promo_codes_org_id_id_key').on(table.orgId, table.id),
    index('promo_codes_org_idx').on(table.orgId),
    uniqueIndex('promo_codes_org_code_idx').on(table.orgId, table.code),
    index('promo_codes_org_customer_idx').on(table.orgId, table.customerId),
    foreignKey({
      name: 'promo_codes_org_id_customer_id_fk',
      columns: [table.orgId, table.customerId],
      foreignColumns: [customers.orgId, customers.id],
    }).onDelete('restrict'),
    check('promo_codes_code_shape', sql`${table.code} ~ '^[A-Z0-9][A-Z0-9_-]{2,39}$'`),
    check('promo_codes_kind', sql`${table.kind} in ('percent', 'flat', 'free_delivery')`),
    check(
      'promo_codes_value',
      sql`(${table.kind} = 'percent' and ${table.valueBps} between 1 and 10000)
        or (${table.kind} = 'flat' and ${table.valuePoisha} > 0)
        or ${table.kind} = 'free_delivery'`,
    ),
    check(
      'promo_codes_amounts',
      sql`(${table.minOrderPoisha} is null or ${table.minOrderPoisha} >= 0)
        and (${table.maxDiscountPoisha} is null or ${table.maxDiscountPoisha} > 0)`,
    ),
    check(
      'promo_codes_limits',
      sql`(${table.totalLimit} is null or ${table.totalLimit} > 0)
        and (${table.perCustomerLimit} is null or ${table.perCustomerLimit} > 0)`,
    ),
    check(
      'promo_codes_used_within_limit',
      sql`${table.usedCount} >= 0 and (${table.totalLimit} is null or ${table.usedCount} <= ${table.totalLimit})`,
    ),
    check(
      'promo_codes_window',
      sql`${table.validFrom} is null or ${table.validTo} is null or ${table.validFrom} <= ${table.validTo}`,
    ),
    check('promo_codes_origin', sql`${table.origin} in ('manual', 'occasion')`),
    check('promo_codes_status', sql`${table.status} in ('active', 'paused', 'archived')`),
  ],
);

export const promoRedemptions = promo.table(
  'redemptions',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    codeId: uuid('code_id').notNull(),
    /** Exactly one of these: an order from the desk, or a sale at the till. */
    orderId: uuid('order_id'),
    posSaleId: uuid('pos_sale_id'),
    customerId: uuid('customer_id'),
    discountPoisha: bigint('discount_poisha', { mode: 'bigint' }).notNull(),
    deliveryDiscountPoisha: bigint('delivery_discount_poisha', { mode: 'bigint' }).notNull(),
    status: text('status').notNull().default('applied'),
    releasedAt: timestamp('released_at', { withTimezone: true, mode: 'date' }),
    ...timestamps,
  },
  (table) => [
    unique('promo_redemptions_org_id_id_key').on(table.orgId, table.id),
    index('promo_redemptions_org_idx').on(table.orgId),
    index('promo_redemptions_org_code_customer_idx').on(
      table.orgId,
      table.codeId,
      table.customerId,
    ),
    uniqueIndex('promo_redemptions_org_code_order_idx')
      .on(table.orgId, table.codeId, table.orderId)
      .where(sql`${table.orderId} is not null`),
    uniqueIndex('promo_redemptions_org_code_sale_idx')
      .on(table.orgId, table.codeId, table.posSaleId)
      .where(sql`${table.posSaleId} is not null`),
    foreignKey({
      name: 'promo_redemptions_org_id_code_id_fk',
      columns: [table.orgId, table.codeId],
      foreignColumns: [promoCodes.orgId, promoCodes.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'promo_redemptions_org_id_order_id_fk',
      columns: [table.orgId, table.orderId],
      foreignColumns: [orders.orgId, orders.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'promo_redemptions_org_id_pos_sale_id_fk',
      columns: [table.orgId, table.posSaleId],
      foreignColumns: [posSales.orgId, posSales.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'promo_redemptions_org_id_customer_id_fk',
      columns: [table.orgId, table.customerId],
      foreignColumns: [customers.orgId, customers.id],
    }).onDelete('restrict'),
    check(
      'promo_redemptions_one_target',
      sql`(${table.orderId} is null) <> (${table.posSaleId} is null)`,
    ),
    check(
      'promo_redemptions_amounts',
      sql`${table.discountPoisha} >= 0 and ${table.deliveryDiscountPoisha} >= 0
        and ${table.discountPoisha} + ${table.deliveryDiscountPoisha} > 0`,
    ),
    check('promo_redemptions_status', sql`${table.status} in ('applied', 'released')`),
    check(
      'promo_redemptions_release_complete',
      sql`(${table.status} = 'released') = (${table.releasedAt} is not null)`,
    ),
  ],
);
