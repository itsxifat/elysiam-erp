import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
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

import { skus } from '../catalog/index.js';
import { primaryId, timestamps } from '../columns.js';
import { fileObjects } from '../files/index.js';
import { campaigns } from '../marketing/index.js';
import { customers, orders } from '../orders/index.js';
import { organizations } from '../org/index.js';
import { posSales } from '../pos/index.js';

/**
 * Discounts, their redemption ledger, and flash sales (architecture §10; M16, M35a).
 *
 * The code carries its own count of uses, and a redemption takes one with a
 * conditional UPDATE (`used_count < total_limit`), exactly like a stock reservation
 * (invariant 3): two orders racing for the last use of a code cannot both get it,
 * and nothing reads the count and then writes it. A flash sale's units are claimed the
 * same way (`units_sold + qty <= unit_limit`).
 *
 * **`promo.codes` holds every discount (D-541).** M35a added automatic discounts (no code),
 * buy-X-get-Y, tiers, first-order-only, a minimum quantity, product scope, an instant window,
 * stacking and priority to the M16 table rather than moving codes to a new one: the orders,
 * the redemptions, the CRM's occasion greetings and M18's attribution all name a row here by
 * id, and a rename would have touched each of them for no change in behaviour. An M16 code is
 * a discount with the method `code` and every M35a column at its default.
 */
export const promo = pgSchema('promo');

export const promoCodes = promo.table(
  'codes',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    /** `code`: applies when typed. `automatic`: applies whenever it is eligible (M35a). */
    method: text('method').notNull().default('code'),
    /** Stored upper-case and trimmed; people type codes however they like. Null when automatic. */
    code: text('code'),
    /** What staff and shoppers see it called. M16's codes are titled with their own word. */
    title: text('title').notNull().default(''),
    description: text('description').notNull().default(''),
    kind: text('kind').notNull(),
    /** Percent codes: basis points. */
    valueBps: integer('value_bps').notNull().default(0),
    /** Flat codes: the amount off. */
    valuePoisha: bigint('value_poisha', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    /** Buy X get Y: in each group of `buy + get` units in scope, the `get` cheapest are discounted. */
    buyQuantity: integer('buy_quantity'),
    getQuantity: integer('get_quantity'),
    /** How much off each of those units, in basis points; 10,000 is free. */
    getDiscountBps: integer('get_discount_bps'),
    minOrderPoisha: bigint('min_order_poisha', { mode: 'bigint' }),
    /** Units in the whole basket. */
    minQuantity: integer('min_quantity'),
    firstOrderOnly: boolean('first_order_only').notNull().default(false),
    maxDiscountPoisha: bigint('max_discount_poisha', { mode: 'bigint' }),
    totalLimit: integer('total_limit'),
    perCustomerLimit: integer('per_customer_limit'),
    /** Uses applied and not released. Moved only by the conditional update. */
    usedCount: integer('used_count').notNull().default(0),
    /** Asia/Dhaka calendar dates, both inclusive. */
    validFrom: date('valid_from', { mode: 'string' }),
    validTo: date('valid_to', { mode: 'string' }),
    /** Instants, both inclusive (M35a): the old site's schedule. Either window, both or neither. */
    startsAt: timestamp('starts_at', { withTimezone: true, mode: 'date' }),
    endsAt: timestamp('ends_at', { withTimezone: true, mode: 'date' }),
    /** Empty arrays: every channel, the whole basket. */
    channels: jsonb('channels').notNull().default([]),
    skuIds: jsonb('sku_ids').notNull().default([]),
    /** M35a: a product covers every one of its SKUs. */
    productIds: jsonb('product_ids').notNull().default([]),
    /** A category covers its sub-categories (D-541). */
    categoryIds: jsonb('category_ids').notNull().default([]),
    /** A personal code: this buyer's and nobody else's. */
    customerId: uuid('customer_id'),
    /** The brand's own campaign the code promotes (M18): explicit attribution (D-251). */
    campaignId: uuid('campaign_id'),
    /** May combine with other stackable discounts (M35a). */
    allowStacking: boolean('allow_stacking').notNull().default(false),
    /** Higher wins a tie between equally good choices, and is applied first. */
    priority: integer('priority').notNull().default(0),
    /** Why the code exists: made by a person, or issued by the occasions job. */
    origin: text('origin').notNull().default('manual'),
    status: text('status').notNull().default('active'),
    createdBy: text('created_by').notNull(),
    ...timestamps,
  },
  (table) => [
    unique('promo_codes_org_id_id_key').on(table.orgId, table.id),
    index('promo_codes_org_idx').on(table.orgId),
    // Unique among codes; automatic discounts have none, and nulls never collide.
    uniqueIndex('promo_codes_org_code_idx').on(table.orgId, table.code),
    // The quote's candidate read: a brand's active automatic discounts.
    index('promo_codes_org_method_status_idx').on(table.orgId, table.method, table.status),
    index('promo_codes_org_customer_idx').on(table.orgId, table.customerId),
    foreignKey({
      name: 'promo_codes_org_id_customer_id_fk',
      columns: [table.orgId, table.customerId],
      foreignColumns: [customers.orgId, customers.id],
    }).onDelete('restrict'),
    // M18: a code names a campaign of its own brand, never another's (D-047, D-261).
    foreignKey({
      name: 'promo_codes_org_id_campaign_id_fk',
      columns: [table.orgId, table.campaignId],
      foreignColumns: [campaigns.orgId, campaigns.id],
    }).onDelete('restrict'),
    check('promo_codes_code_shape', sql`${table.code} ~ '^[A-Z0-9][A-Z0-9_-]{2,39}$'`),
    check('promo_codes_method', sql`${table.method} in ('code', 'automatic')`),
    // A code discount has its word; an automatic one has none and must have a title.
    check(
      'promo_codes_method_code',
      sql`(${table.method} = 'code') = (${table.code} is not null)
        and (${table.method} = 'code' or length(btrim(${table.title})) > 0)`,
    ),
    check(
      'promo_codes_kind',
      sql`${table.kind} in ('percent', 'flat', 'free_delivery', 'buy_x_get_y', 'tiered')`,
    ),
    check(
      'promo_codes_value',
      sql`(${table.kind} = 'percent' and ${table.valueBps} between 1 and 10000)
        or (${table.kind} = 'flat' and ${table.valuePoisha} > 0)
        or ${table.kind} = 'free_delivery'
        or (${table.kind} = 'buy_x_get_y' and ${table.buyQuantity} between 1 and 1000
            and ${table.getQuantity} between 1 and 1000
            and ${table.getDiscountBps} between 1 and 10000)
        or ${table.kind} = 'tiered'`,
    ),
    check(
      'promo_codes_min_quantity',
      sql`${table.minQuantity} is null or ${table.minQuantity} > 0`,
    ),
    check(
      'promo_codes_instant_window',
      sql`${table.startsAt} is null or ${table.endsAt} is null or ${table.startsAt} < ${table.endsAt}`,
    ),
    check('promo_codes_priority', sql`${table.priority} between -100 and 100`),
    // A personal code is typed by its buyer; there is no personal automatic discount.
    check(
      'promo_codes_personal_is_code',
      sql`${table.customerId} is null or ${table.method} = 'code'`,
    ),
    check(
      'promo_codes_text_lengths',
      sql`length(${table.title}) <= 120 and length(${table.description}) <= 1000`,
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

/**
 * The steps of a tiered discount (M35a, D-541).
 *
 * Rows, not a `jsonb` array, because each step carries money and money is a `bigint` column
 * (invariant 1). Written with the discount and never changed: a discount's terms are fixed
 * once it exists, as M16's codes were.
 */
export const promoDiscountTiers = promo.table(
  'discount_tiers',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    codeId: uuid('code_id').notNull(),
    position: integer('position').notNull(),
    /** On the whole basket. */
    minSubtotalPoisha: bigint('min_subtotal_poisha', { mode: 'bigint' }).notNull(),
    kind: text('kind').notNull(),
    valueBps: integer('value_bps').notNull().default(0),
    valuePoisha: bigint('value_poisha', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    ...timestamps,
  },
  (table) => [
    unique('promo_discount_tiers_org_id_id_key').on(table.orgId, table.id),
    index('promo_discount_tiers_org_idx').on(table.orgId),
    uniqueIndex('promo_discount_tiers_org_code_position_idx').on(
      table.orgId,
      table.codeId,
      table.position,
    ),
    foreignKey({
      name: 'promo_discount_tiers_org_id_code_id_fk',
      columns: [table.orgId, table.codeId],
      foreignColumns: [promoCodes.orgId, promoCodes.id],
    }).onDelete('restrict'),
    check('promo_discount_tiers_position', sql`${table.position} between 0 and 9`),
    check(
      'promo_discount_tiers_min',
      sql`${table.minSubtotalPoisha} >= 0 and ${table.minSubtotalPoisha} <= 9000000000000000`,
    ),
    check(
      'promo_discount_tiers_value',
      sql`(${table.kind} = 'percent' and ${table.valueBps} between 1 and 10000)
        or (${table.kind} = 'flat' and ${table.valuePoisha} > 0
            and ${table.valuePoisha} <= 9000000000000000)`,
    ),
  ],
);

/**
 * Flash sales (M35a, D-542; the old site's `models/FlashSale.js`).
 *
 * A time-limited campaign with its own page (`slug`), a banner, a place on the home page and
 * a priority for listing. Switched off is a draft; switched on, its window decides whether it
 * is scheduled, live or ended.
 */
export const flashSales = promo.table(
  'flash_sales',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    title: text('title').notNull(),
    subtitle: text('subtitle').notNull().default(''),
    description: text('description').notNull().default(''),
    /** The sale's page on the website, `/flash-sale/<slug>`. Unique per brand. */
    slug: text('slug').notNull(),
    /** A public `campaign-asset` file. */
    bannerFileId: uuid('banner_file_id'),
    enabled: boolean('enabled').notNull().default(false),
    showOnHome: boolean('show_on_home').notNull().default(true),
    /** Higher first wherever several sales are listed together. */
    priority: integer('priority').notNull().default(0),
    /** Null start: live as soon as it is switched on. Null end: no end. */
    startsAt: timestamp('starts_at', { withTimezone: true, mode: 'date' }),
    endsAt: timestamp('ends_at', { withTimezone: true, mode: 'date' }),
    createdBy: text('created_by').notNull(),
    ...timestamps,
  },
  (table) => [
    unique('flash_sales_org_id_id_key').on(table.orgId, table.id),
    index('flash_sales_org_idx').on(table.orgId),
    uniqueIndex('flash_sales_org_slug_idx').on(table.orgId, table.slug),
    index('flash_sales_org_enabled_idx').on(table.orgId, table.enabled),
    foreignKey({
      name: 'flash_sales_org_id_banner_file_id_fk',
      columns: [table.orgId, table.bannerFileId],
      foreignColumns: [fileObjects.orgId, fileObjects.id],
    }).onDelete('restrict'),
    check(
      'flash_sales_slug_shape',
      sql`${table.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(${table.slug}) <= 80`,
    ),
    check(
      'flash_sales_text_lengths',
      sql`length(btrim(${table.title})) between 1 and 120 and length(${table.subtitle}) <= 160
        and length(${table.description}) <= 1000`,
    ),
    check('flash_sales_priority', sql`${table.priority} between -100 and 100`),
    check(
      'flash_sales_window',
      sql`${table.startsAt} is null or ${table.endsAt} is null or ${table.startsAt} < ${table.endsAt}`,
    ),
  ],
);

/**
 * One SKU in a flash sale: its sale price and how many units sell at it (M35a, D-542).
 *
 * `unit_limit` null is the old site's "all stock": the shelf is the only cap. `units_sold`
 * moves only by the claim's conditional UPDATE and by releases, and never passes the limit;
 * the CHECK is the backstop for the UPDATE's own condition. A SKU taken off a sale is
 * switched off rather than deleted, because claims name it.
 */
export const flashSaleItems = promo.table(
  'flash_sale_items',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    flashSaleId: uuid('flash_sale_id').notNull(),
    skuId: uuid('sku_id').notNull(),
    salePricePoisha: bigint('sale_price_poisha', { mode: 'bigint' }).notNull(),
    unitLimit: integer('unit_limit'),
    unitsSold: integer('units_sold').notNull().default(0),
    enabled: boolean('enabled').notNull().default(true),
    ...timestamps,
  },
  (table) => [
    unique('flash_sale_items_org_id_id_key').on(table.orgId, table.id),
    index('flash_sale_items_org_idx').on(table.orgId),
    uniqueIndex('flash_sale_items_org_sale_sku_idx').on(
      table.orgId,
      table.flashSaleId,
      table.skuId,
    ),
    // The quote's read: every offer on these SKUs.
    index('flash_sale_items_org_sku_idx').on(table.orgId, table.skuId),
    foreignKey({
      name: 'flash_sale_items_org_id_flash_sale_id_fk',
      columns: [table.orgId, table.flashSaleId],
      foreignColumns: [flashSales.orgId, flashSales.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'flash_sale_items_org_id_sku_id_fk',
      columns: [table.orgId, table.skuId],
      foreignColumns: [skus.orgId, skus.id],
    }).onDelete('restrict'),
    check(
      'flash_sale_items_price',
      sql`${table.salePricePoisha} > 0 and ${table.salePricePoisha} <= 9000000000000000`,
    ),
    check(
      'flash_sale_items_sold_within_limit',
      sql`${table.unitsSold} >= 0 and (${table.unitLimit} is null
        or (${table.unitLimit} > 0 and ${table.unitsSold} <= ${table.unitLimit}))`,
    ),
  ],
);

/**
 * Which order claimed which flash units (M35a, D-542).
 *
 * The record that makes a release exact and once: a cancelled or returned order gives back
 * what it claimed, from these rows, and a row is released at most once (the integrity
 * migration's trigger refuses any other change). `sale_price_poisha` is the price the units
 * were claimed at.
 */
export const flashClaims = promo.table(
  'flash_claims',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    flashSaleItemId: uuid('flash_sale_item_id').notNull(),
    orderId: uuid('order_id').notNull(),
    skuId: uuid('sku_id').notNull(),
    qty: integer('qty').notNull(),
    salePricePoisha: bigint('sale_price_poisha', { mode: 'bigint' }).notNull(),
    /** Units given back: all of them on a cancel, the returned ones on a partial return. */
    releasedQty: integer('released_qty').notNull().default(0),
    status: text('status').notNull().default('claimed'),
    releasedAt: timestamp('released_at', { withTimezone: true, mode: 'date' }),
    ...timestamps,
  },
  (table) => [
    unique('flash_claims_org_id_id_key').on(table.orgId, table.id),
    index('flash_claims_org_idx').on(table.orgId),
    uniqueIndex('flash_claims_org_order_item_idx').on(
      table.orgId,
      table.orderId,
      table.flashSaleItemId,
    ),
    index('flash_claims_org_item_idx').on(table.orgId, table.flashSaleItemId),
    foreignKey({
      name: 'flash_claims_org_id_flash_sale_item_id_fk',
      columns: [table.orgId, table.flashSaleItemId],
      foreignColumns: [flashSaleItems.orgId, flashSaleItems.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'flash_claims_org_id_order_id_fk',
      columns: [table.orgId, table.orderId],
      foreignColumns: [orders.orgId, orders.id],
    }).onDelete('restrict'),
    check('flash_claims_qty', sql`${table.qty} > 0`),
    check(
      'flash_claims_price',
      sql`${table.salePricePoisha} > 0 and ${table.salePricePoisha} <= 9000000000000000`,
    ),
    check('flash_claims_status', sql`${table.status} in ('claimed', 'released')`),
    check(
      'flash_claims_release_shape',
      sql`(${table.status} = 'claimed' and ${table.releasedQty} = 0 and ${table.releasedAt} is null)
        or (${table.status} = 'released' and ${table.releasedQty} between 0 and ${table.qty}
            and ${table.releasedAt} is not null)`,
    ),
  ],
);
