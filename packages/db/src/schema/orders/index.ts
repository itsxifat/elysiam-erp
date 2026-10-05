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
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { primaryId, timestamps } from '../columns.js';
import { skus } from '../catalog/index.js';
import { branches, locations, organizations } from '../org/index.js';
import { districts, thanas } from '../ref/index.js';

/**
 * Customers, delivery zones and orders (architecture §9, M10).
 *
 * The Postgres schema is `sales`, not `orders`: §3's module → schema map names it, and
 * it holds the buyer as well as the order. The folder is `orders` because that is the
 * module that owns it.
 *
 * Three shapes in here are load-bearing and worth reading before the columns:
 *
 * 1. **The shipping address is a snapshot, not a reference.** `orders` carries the
 *    name, phone, district, thana, area and address text as its own columns. A
 *    customer who moves house must not silently change where last month's parcels were
 *    sent — the invoice in the box, the courier's manifest and our own record have to
 *    keep agreeing after the edit, and a foreign key to a mutable address makes that
 *    impossible.
 * 2. **Totals are stored as well as computed.** `computeOrderTotals` in
 *    `@elysium/domain` is the only thing that produces them (invariant 11), and the
 *    result is written down because the price the customer agreed to is a fact about a
 *    moment, not a function of today's price list. The CHECK below re-derives the COD
 *    from the other four columns, so a row that was written by anything other than the
 *    domain is rejected by the database.
 * 3. **`dispatch_unit_cost_poisha` on the line.** The cost a unit left at, recorded at
 *    handover, because §7's delivery and return journals must credit goods in transit
 *    exactly what the handover debited it (see `handoverDraft`). It is cost information
 *    (invariant 5) and never appears in a response.
 *
 * Every table carries `org_id NOT NULL` with an index, RLS ENABLE + FORCE and the
 * standard policy from `tenantTableSql()` (migrations 0040), and every foreign key
 * between two tenant tables carries `org_id` on **both** sides against a
 * `unique (org_id, id)` on the parent (D-047).
 */
export const sales = pgSchema('sales');

/** §9's order channels, closed. The reseller channel is Beownz's portal (§13). */
export const orderChannel = sales.enum('order_channel', [
  'facebook',
  'whatsapp',
  'instagram',
  'tiktok',
  'landing_page',
  'website',
  'phone',
  'walk_in',
  'reseller',
  // M35b (D-556): orders the ncom.bd marketplace hands over.
  'marketplace',
]);

/**
 * §9's eleven statuses, kept in step with `ORDER_STATUSES` in @elysium/domain by a test.
 *
 * This package cannot import the domain, and two hand-maintained copies of a closed set
 * is exactly the shape that drifts — the same arrangement, and the same guard, as M07's
 * movement kinds. Adding a status needs an architecture §9 edit and a decisions row.
 */
export const orderStatus = sales.enum('order_status', [
  'pending',
  'confirmed',
  'on_hold',
  'packed',
  'shipped',
  'delivered',
  'partially_delivered',
  'return_in_transit',
  'returned',
  'cancelled',
  'exchange',
]);

/**
 * The couriers an org uses, as ledger parties (§7's `courier_receivable`).
 *
 * A small table with a large job: every delivery debits courier receivable with a
 * `party_id`, and without a row to name there is one receivable balance for every
 * courier — which makes "how much is Steadfast holding of ours", the question COD
 * reconciliation exists to answer, unanswerable.
 *
 * M10 owns the party row; M12 owns the adapter, the parcels and the settlements, and
 * adds those tables around this one rather than replacing it (D-171). `code` is what
 * `packages/integrations/couriers` resolves an adapter by, so it is constrained to the
 * shape an adapter key takes.
 */
export const couriers = sales.table(
  'couriers',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    /** `steadfast`, `pathao`, `redx`, or `own_rider` for a brand's own delivery. */
    code: text('code').notNull(),
    name: text('name').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps,
  },
  (table) => [
    unique('couriers_org_id_id_key').on(table.orgId, table.id),
    index('couriers_org_idx').on(table.orgId),
    uniqueIndex('couriers_org_code_idx').on(table.orgId, table.code),
    check('couriers_code_format', sql`${table.code} ~ '^[a-z][a-z0-9_]{1,31}$'`),
  ],
);

/**
 * A delivery zone and what it costs (§9 "Delivery zones and charges", D-009).
 *
 * Per org, because each brand negotiates its own rates, and editable, because D-009's
 * figures are placeholders the client has yet to confirm. The charge lives here rather
 * than on the order type so a rate change applies to new orders only: existing orders
 * carry the charge they were priced at, which is why `orders.delivery_charge_poisha`
 * is a column and not a join.
 */
export const deliveryZones = sales.table(
  'delivery_zones',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    code: text('code').notNull(),
    nameEn: text('name_en').notNull(),
    /** Shown to customers, so it is Bangla (D-036). */
    nameBn: text('name_bn').notNull(),
    chargePoisha: bigint('charge_poisha', { mode: 'bigint' }).notNull(),
    /** Which courier this zone books with unless the desk chooses another (§9). */
    defaultCourierId: uuid('default_courier_id'),
    /** Ordering on the order-entry dropdown, cheapest-first by convention. */
    position: integer('position').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps,
  },
  (table) => [
    unique('delivery_zones_org_id_id_key').on(table.orgId, table.id),
    index('delivery_zones_org_idx').on(table.orgId),
    uniqueIndex('delivery_zones_org_code_idx').on(table.orgId, table.code),
    foreignKey({
      name: 'delivery_zones_org_id_default_courier_id_fk',
      columns: [table.orgId, table.defaultCourierId],
      foreignColumns: [couriers.orgId, couriers.id],
    }).onDelete('restrict'),
    check('delivery_zones_code_format', sql`${table.code} ~ '^[a-z][a-z0-9_]{1,31}$'`),
    // A zone may legitimately be free — a showroom pickup, an own-rider area inside the
    // city — but never negative, which would pay the customer to order.
    check('delivery_zones_charge_not_negative', sql`${table.chargePoisha} >= 0`),
    check('delivery_zones_charge_bounded', sql`${table.chargePoisha} <= 9000000000000000`),
  ],
);

/**
 * Which district and thana fall in which zone (§9: "seeded and editable").
 *
 * A row with a `thana_id` maps that thana; a row without one maps the whole district,
 * so an org can say "Outside Dhaka" once and then carve out the two thanas its own
 * rider covers. Lookup prefers the thana row — the more specific answer — and that
 * preference lives in the repository's one query rather than in the caller.
 *
 * NULLS NOT DISTINCT on the unique index is what makes "the whole district" a single
 * row: by default PostgreSQL treats every NULL as distinct, so a district could be
 * mapped to three different zones at once and every lookup would be a coin toss.
 *
 * It is declared in migration 0039 and **cannot** be declared here: drizzle-orm 0.45
 * puts `nullsNotDistinct()` on the unique *constraint* builder only, and its index
 * builder has no equivalent. Stating it in the index name would be decoration, so the
 * comment says it instead — and the integrator's note in the milestone report records
 * the one-line alternative (a unique constraint rather than a unique index) if the
 * schema-drift gate ever needs the two to be expressible from one place.
 */
export const deliveryZoneAreas = sales.table(
  'delivery_zone_areas',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    zoneId: uuid('zone_id').notNull(),
    districtId: integer('district_id')
      .notNull()
      .references(() => districts.id),
    thanaId: integer('thana_id').references(() => thanas.id),
    ...timestamps,
  },
  (table) => [
    unique('delivery_zone_areas_org_id_id_key').on(table.orgId, table.id),
    index('delivery_zone_areas_org_idx').on(table.orgId),
    index('delivery_zone_areas_org_zone_idx').on(table.orgId, table.zoneId),
    uniqueIndex('delivery_zone_areas_org_area_idx').on(
      table.orgId,
      table.districtId,
      table.thanaId,
    ),
    foreignKey({
      name: 'delivery_zone_areas_org_id_zone_id_fk',
      columns: [table.orgId, table.zoneId],
      foreignColumns: [deliveryZones.orgId, deliveryZones.id],
    }).onDelete('restrict'),
  ],
);

/**
 * A buyer (§9 "Customers").
 *
 * Keyed by `phone_e164`, normalised by `normalizeBdPhone` in @elysium/domain, and
 * unique per org. The unique index is the whole point: if `01712345678` and
 * `+8801712345678` could both exist, the same person would have two order histories and
 * a delivery ratio computed from half the evidence.
 *
 * "The same person appears as separate rows in different orgs" (§9). Deliberate: the
 * five brands are separate companies.
 *
 * The counters are maintained from order transitions rather than computed on read. A
 * `count(*)` over a buyer's orders is the honest version and it is also the one that
 * makes the order desk's buyer lookup a scan of every order that buyer ever placed.
 */
export const customers = sales.table(
  'customers',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    /** E.164, always `+8801XXXXXXXXX`. Masked in logs and audit rows (invariant 10). */
    phoneE164: text('phone_e164').notNull(),
    name: text('name').notNull(),
    /** Optional, and all of it is §9's list. Occasions drive M14's greeting job. */
    birthday: date('birthday'),
    anniversary: date('anniversary'),
    gender: text('gender'),
    ageBand: text('age_band'),
    profession: text('profession'),
    tags: jsonb('tags').notNull().default([]),
    notes: text('notes'),
    /** Buyer stats, maintained by order transitions. */
    ordersTotal: integer('orders_total').notNull().default(0),
    deliveredCount: integer('delivered_count').notNull().default(0),
    returnedCount: integer('returned_count').notNull().default(0),
    cancelledCount: integer('cancelled_count').notNull().default(0),
    /**
     * Lifetime value: Σ net revenue recognised. A selling figure, never a cost.
     *
     * The default is written as a SQL expression rather than `.default(0n)`.
     * The DDL carries `DEFAULT 0` and the schema has to say so or the drift
     * check sees a difference — but drizzle-kit cannot serialise a BigInt into
     * its snapshot and fails the generator outright when it meets one, which is
     * why `inventory`'s costing table carries no default at all. A SQL default
     * says the same thing and survives generation. Every other `*_poisha`
     * default in this file is written the same way for the same reason.
     */
    ltvPoisha: bigint('ltv_poisha', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    firstOrderAt: timestamp('first_order_at', { withTimezone: true, mode: 'date' }),
    lastOrderAt: timestamp('last_order_at', { withTimezone: true, mode: 'date' }),
    ...timestamps,
  },
  (table) => [
    unique('customers_org_id_id_key').on(table.orgId, table.id),
    index('customers_org_idx').on(table.orgId),
    uniqueIndex('customers_org_phone_idx').on(table.orgId, table.phoneE164),
    index('customers_org_last_order_idx').on(table.orgId, table.lastOrderAt),
    /*
     * The E.164 shape, in the database.
     *
     * The domain already refuses anything else, and this is the backstop that makes the
     * unique index mean what it claims: an import script or a repair query that wrote
     * `01712345678` would create the second identity the index exists to prevent, and
     * it would look like a perfectly good row.
     */
    check('customers_phone_e164', sql`${table.phoneE164} ~ '^\\+8801[13456789][0-9]{8}$'`),
    check('customers_name_length', sql`length(${table.name}) between 1 and 200`),
    check(
      'customers_counters_not_negative',
      sql`${table.ordersTotal} >= 0 and ${table.deliveredCount} >= 0
          and ${table.returnedCount} >= 0 and ${table.cancelledCount} >= 0`,
    ),
    check('customers_ltv_not_negative', sql`${table.ltvPoisha} >= 0`),
  ],
);

/** A buyer's saved addresses, on §9's district/thana reference data. */
export const customerAddresses = sales.table(
  'customer_addresses',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    customerId: uuid('customer_id').notNull(),
    /** `home`, `office`, or whatever the buyer called it. */
    label: text('label'),
    districtId: integer('district_id')
      .notNull()
      .references(() => districts.id),
    thanaId: integer('thana_id')
      .notNull()
      .references(() => thanas.id),
    /** The neighbourhood: "Dhanmondi 27", "Sector 10". */
    area: text('area'),
    /** House, road, landmark — what a rider actually reads. */
    addressLine: text('address_line').notNull(),
    isDefault: boolean('is_default').notNull().default(false),
    ...timestamps,
  },
  (table) => [
    unique('customer_addresses_org_id_id_key').on(table.orgId, table.id),
    index('customer_addresses_org_idx').on(table.orgId),
    index('customer_addresses_org_customer_idx').on(table.orgId, table.customerId),
    // One default per buyer. A partial unique index rather than application discipline:
    // two defaults means order entry picks one at random, which is how a parcel goes to
    // the address the customer moved out of.
    uniqueIndex('customer_addresses_org_default_idx')
      .on(table.orgId, table.customerId)
      .where(sql`${table.isDefault}`),
    foreignKey({
      name: 'customer_addresses_org_id_customer_id_fk',
      columns: [table.orgId, table.customerId],
      foreignColumns: [customers.orgId, customers.id],
    }).onDelete('restrict'),
    check('customer_addresses_line_length', sql`length(${table.addressLine}) between 3 and 500`),
  ],
);

/**
 * The per-org, per-month order number counter (§9).
 *
 * One row per `(org_id, period)`, incremented by a single
 * `insert … on conflict do update set last_no = last_no + 1 returning last_no`. The
 * statement is the concurrency control, exactly as M07's reservation UPDATE is: two
 * agents confirming orders in the same second serialise on the row lock and get
 * different numbers, where a `select max(order_no)` version gives them the same one and
 * the unique index turns a busy afternoon into failed confirmations.
 */
export const orderCounters = sales.table(
  'order_counters',
  {
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    /** `YYMM` in Asia/Dhaka (invariant 8). */
    period: text('period').notNull(),
    lastNo: integer('last_no').notNull().default(0),
    ...timestamps,
  },
  (table) => [
    primaryKey({ name: 'order_counters_pkey', columns: [table.orgId, table.period] }),
    index('order_counters_org_idx').on(table.orgId),
    check('order_counters_period_format', sql`${table.period} ~ '^[0-9]{4}$'`),
    check('order_counters_last_no_not_negative', sql`${table.lastNo} >= 0`),
  ],
);

export const orders = sales.table(
  'orders',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    /** Null for an org-level online order; set for a showroom or branch-owned one. */
    branchId: uuid('branch_id'),
    /** `OUR-2609-00042` (§9). Unique per org. */
    orderNo: text('order_no').notNull(),

    channel: orderChannel('channel').notNull(),
    /** §9: page id, campaign id, ad id, UTMs, landing page id, Chatwoot conversation id. */
    source: jsonb('source').notNull().default({}),

    customerId: uuid('customer_id').notNull(),
    /*
     * The shipping address, snapshotted.
     *
     * Copied from the customer's address at order entry rather than referenced, so
     * editing a buyer's address never rewrites where a past parcel was sent. The
     * courier manifest, the printed invoice and this row have to keep agreeing after
     * that edit, and a foreign key cannot give that.
     */
    shipName: text('ship_name').notNull(),
    shipPhoneE164: text('ship_phone_e164').notNull(),
    shipDistrictId: integer('ship_district_id')
      .notNull()
      .references(() => districts.id),
    shipThanaId: integer('ship_thana_id')
      .notNull()
      .references(() => thanas.id),
    shipArea: text('ship_area'),
    shipAddressLine: text('ship_address_line').notNull(),
    deliveryZoneId: uuid('delivery_zone_id'),
    /** The courier the parcel goes with; needed to name the receivable party (§7). */
    courierId: uuid('courier_id'),
    /**
     * Where the units are reserved and dispatched from (D-172).
     *
     * Named on the order rather than derived at each step. M07 reserves against a
     * location, and re-deriving it at handover could pick a different one than confirm
     * reserved from — which releases nothing, consumes nothing, and leaves units held
     * for an order that already shipped.
     */
    locationId: uuid('location_id'),
    /**
     * When the order's units were reserved as it was placed (M34, D-532).
     *
     * A website checkout holds the stock at once, at `location_id`, so a shopper is never sold
     * a unit somebody else has just paid for; every other order reserves on confirm. The state
     * machine reads it (`stockHeld`): confirming a held order reserves nothing more, and
     * cancelling it while still pending releases what the checkout held. Written at insert only.
     */
    stockHeldAt: timestamp('stock_held_at', { withTimezone: true, mode: 'date' }),

    itemsPoisha: bigint('items_poisha', { mode: 'bigint' }).notNull(),
    discountPoisha: bigint('discount_poisha', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    deliveryChargePoisha: bigint('delivery_charge_poisha', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    advancePaidPoisha: bigint('advance_paid_poisha', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    codAmountPoisha: bigint('cod_amount_poisha', { mode: 'bigint' }).notNull(),
    /**
     * The promo code applied, if any (M16). Its foreign key to `promo.codes` is in
     * migration 0077 rather than here: `promo` already imports this file, and a
     * declaration in both directions would be an import cycle.
     */
    promoCodeId: uuid('promo_code_id'),

    status: orderStatus('status').notNull().default('pending'),
    holdReason: text('hold_reason'),

    /** `iam.users.id` is text, so these are text. Null means the unassigned queue (§6). */
    assignedTo: text('assigned_to'),
    createdBy: text('created_by').notNull(),

    confirmedBy: text('confirmed_by'),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true, mode: 'date' }),
    packedAt: timestamp('packed_at', { withTimezone: true, mode: 'date' }),
    handedOverAt: timestamp('handed_over_at', { withTimezone: true, mode: 'date' }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true, mode: 'date' }),
    returnedAt: timestamp('returned_at', { withTimezone: true, mode: 'date' }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true, mode: 'date' }),
    cancelReason: text('cancel_reason'),

    /** §13's reseller, when the order came from the Beownz portal. */
    resellerId: uuid('reseller_id'),
    /** The order this one replaces (§9's `delivered → exchange`). */
    exchangeOfOrderId: uuid('exchange_of_order_id'),
    notes: text('notes'),
    ...timestamps,
  },
  (table) => [
    unique('orders_org_id_id_key').on(table.orgId, table.id),
    index('orders_org_idx').on(table.orgId),
    uniqueIndex('orders_org_no_idx').on(table.orgId, table.orderNo),
    index('orders_org_status_idx').on(table.orgId, table.status),
    index('orders_org_customer_idx').on(table.orgId, table.customerId),
    index('orders_org_assigned_idx').on(table.orgId, table.assignedTo),
    index('orders_org_created_idx').on(table.orgId, table.createdAt),
    // The unassigned queue is the COD workflow's front door (§6), and it is read every
    // few seconds by every agent on shift. A partial index keeps that read proportional
    // to the queue rather than to the order table.
    index('orders_org_unassigned_idx')
      .on(table.orgId, table.createdAt)
      .where(sql`${table.assignedTo} is null`),
    // M11's duplicate warning asks "has this number ordered in the last 24 hours" on every
    // desk entry. The trigram index on the phone answers fragments, not equality over a
    // time window, and without this the check reads every order the number ever placed.
    index('orders_org_phone_created_idx').on(table.orgId, table.shipPhoneE164, table.createdAt),
    // The order list's channel filter and the buyer list's, both bounded by a date range.
    index('orders_org_channel_created_idx').on(table.orgId, table.channel, table.createdAt),
    foreignKey({
      name: 'orders_org_id_branch_id_fk',
      columns: [table.orgId, table.branchId],
      foreignColumns: [branches.orgId, branches.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'orders_org_id_customer_id_fk',
      columns: [table.orgId, table.customerId],
      foreignColumns: [customers.orgId, customers.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'orders_org_id_delivery_zone_id_fk',
      columns: [table.orgId, table.deliveryZoneId],
      foreignColumns: [deliveryZones.orgId, deliveryZones.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'orders_org_id_courier_id_fk',
      columns: [table.orgId, table.courierId],
      foreignColumns: [couriers.orgId, couriers.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'orders_org_id_location_id_fk',
      columns: [table.orgId, table.locationId],
      foreignColumns: [locations.orgId, locations.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'orders_org_id_exchange_of_order_id_fk',
      columns: [table.orgId, table.exchangeOfOrderId],
      foreignColumns: [table.orgId, table.id],
    }).onDelete('restrict'),
    check('orders_no_format', sql`${table.orderNo} ~ '^[A-Z][A-Z0-9]{1,5}-[0-9]{4}-[0-9]{5,}$'`),
    check('orders_ship_phone_e164', sql`${table.shipPhoneE164} ~ '^\\+8801[13456789][0-9]{8}$'`),
    check(
      'orders_amounts_not_negative',
      sql`${table.itemsPoisha} >= 0 and ${table.discountPoisha} >= 0
          and ${table.deliveryChargePoisha} >= 0 and ${table.advancePaidPoisha} >= 0
          and ${table.codAmountPoisha} >= 0`,
    ),
    check(
      'orders_amounts_bounded',
      sql`${table.itemsPoisha} <= 9000000000000000 and ${table.codAmountPoisha} <= 9000000000000000`,
    ),
    /*
     * §9's formula, enforced by the database.
     *
     * The domain computes it and this re-derives it, which is not redundancy: the COD is
     * the number a rider collects and a customer disputes, and the only way to be sure
     * every row satisfies the formula is to make a row that does not satisfy it
     * impossible to write. An import, a data repair or a future service that set the
     * columns individually is refused here rather than discovered by a customer.
     */
    check(
      'orders_cod_matches_formula',
      sql`${table.codAmountPoisha} = ${table.itemsPoisha} - ${table.discountPoisha}
          + ${table.deliveryChargePoisha} - ${table.advancePaidPoisha}`,
    ),
    check('orders_discount_within_items', sql`${table.discountPoisha} <= ${table.itemsPoisha}`),
    // An exchange order points at another order; a normal one does not point at itself.
    check(
      'orders_exchange_not_self',
      sql`${table.exchangeOfOrderId} is null or ${table.exchangeOfOrderId} <> ${table.id}`,
    ),
    // A held order holds its stock somewhere (D-532): the location it was reserved at.
    check(
      'orders_stock_held_has_location',
      sql`${table.stockHeldAt} is null or ${table.locationId} is not null`,
    ),
  ],
);

/**
 * One SKU on an order (§9 "Order lines").
 *
 * The SKU code and product name are snapshotted beside the reference for the same
 * reason the address is: a product renamed next season must not rewrite the invoice in
 * a box that shipped in September.
 *
 * `delivered_qty` and `returned_qty` are what make partial delivery expressible, and
 * the CHECK that keeps their sum inside `qty` is what stops a courier webhook from
 * reporting four of three units delivered and posting revenue for the fourth.
 */
export const orderLines = sales.table(
  'order_lines',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    orderId: uuid('order_id').notNull(),
    skuId: uuid('sku_id').notNull(),
    /** Snapshots, for documents and for a line whose SKU was later archived. */
    skuCode: text('sku_code').notNull(),
    productName: text('product_name').notNull(),
    qty: integer('qty').notNull(),
    /** The selling price, or a reseller's customer price (§9). Never a cost. */
    unitPricePoisha: bigint('unit_price_poisha', { mode: 'bigint' }).notNull(),
    discountPoisha: bigint('discount_poisha', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    deliveredQty: integer('delivered_qty').notNull().default(0),
    returnedQty: integer('returned_qty').notNull().default(0),
    /** §13: what the reseller themselves pays. Their margin is the difference. */
    resellerPricePoisha: bigint('reseller_price_poisha', { mode: 'bigint' }),
    /**
     * The weighted average this unit left at, recorded at handover (invariant 5, §7).
     *
     * Cost information: it is in `COST_FIELDS`, it never appears in a response, and it
     * exists so the delivery and return journals credit goods in transit exactly what
     * the handover debited it. Null until the order ships.
     */
    dispatchUnitCostPoisha: bigint('dispatch_unit_cost_poisha', { mode: 'bigint' }),
    position: integer('position').notNull().default(0),
    ...timestamps,
  },
  (table) => [
    unique('order_lines_org_id_id_key').on(table.orgId, table.id),
    // M35a: what a flash claim names, so a claim is for a whole line of its own order, of
    // its own SKU, charged at the sale price (D-542). Redundant with the primary key as a
    // constraint; it exists to be the target of `promo.flash_claims`' composite foreign key.
    unique('order_lines_flash_claim_key').on(
      table.orgId,
      table.orderId,
      table.id,
      table.skuId,
      table.qty,
      table.unitPricePoisha,
    ),
    index('order_lines_org_idx').on(table.orgId),
    index('order_lines_org_order_idx').on(table.orgId, table.orderId),
    index('order_lines_org_sku_idx').on(table.orgId, table.skuId),
    // One line per SKU per order. Two rows for the same SKU would reserve twice, ship
    // once and make the delivered quantities impossible to reconcile against movements.
    uniqueIndex('order_lines_org_order_sku_idx').on(table.orgId, table.orderId, table.skuId),
    foreignKey({
      name: 'order_lines_org_id_order_id_fk',
      columns: [table.orgId, table.orderId],
      foreignColumns: [orders.orgId, orders.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'order_lines_org_id_sku_id_fk',
      columns: [table.orgId, table.skuId],
      foreignColumns: [skus.orgId, skus.id],
    }).onDelete('restrict'),
    check('order_lines_qty_positive', sql`${table.qty} > 0`),
    check('order_lines_price_not_negative', sql`${table.unitPricePoisha} >= 0`),
    check('order_lines_price_bounded', sql`${table.unitPricePoisha} <= 9000000000000000`),
    check(
      'order_lines_discount_within_line',
      sql`${table.discountPoisha} >= 0
          and ${table.discountPoisha} <= ${table.unitPricePoisha} * ${table.qty}`,
    ),
    check(
      'order_lines_fulfilled_within_qty',
      sql`${table.deliveredQty} >= 0 and ${table.returnedQty} >= 0
          and ${table.deliveredQty} + ${table.returnedQty} <= ${table.qty}`,
    ),
    check(
      'order_lines_dispatch_cost_not_negative',
      sql`${table.dispatchUnitCostPoisha} is null or ${table.dispatchUnitCostPoisha} >= 0`,
    ),
  ],
);

/**
 * Every status change an order ever made (§9: "Every transition writes an outbox event
 * and an audit row"), append-only.
 *
 * The audit log records that a mutation happened; this records the order's own history
 * in the order's own terms, which is what the desk timeline shows, what a dispute is
 * argued from, and what M12's courier sync writes when it moves an order without a
 * person involved. Append-only because a timeline that can be edited answers "when did
 * this go on hold, and who did it" differently on different days.
 */
export const orderEvents = sales.table(
  'order_events',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    orderId: uuid('order_id').notNull(),
    /** Null on the row that records the order being created. */
    fromStatus: orderStatus('from_status'),
    toStatus: orderStatus('to_status').notNull(),
    /** The domain trigger, or `created`. */
    trigger: text('trigger').notNull(),
    reason: text('reason'),
    /** Null when a courier webhook or a job made the move rather than a person. */
    actorUserId: text('actor_user_id'),
    /** The Asia/Dhaka calendar date (invariant 8), so a day's moves group correctly. */
    businessDate: date('business_date').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    unique('order_events_org_id_id_key').on(table.orgId, table.id),
    index('order_events_org_idx').on(table.orgId),
    index('order_events_org_order_idx').on(table.orgId, table.orderId, table.occurredAt),
    index('order_events_org_date_idx').on(table.orgId, table.businessDate),
    foreignKey({
      name: 'order_events_org_id_order_id_fk',
      columns: [table.orgId, table.orderId],
      foreignColumns: [orders.orgId, orders.id],
    }).onDelete('cascade'),
    check('order_events_trigger_format', sql`${table.trigger} ~ '^[a-z][a-z0-9_]{0,31}$'`),
    check(
      'order_events_reason_length',
      sql`${table.reason} is null or length(${table.reason}) <= 500`,
    ),
  ],
);
