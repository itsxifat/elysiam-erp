import { sql } from 'drizzle-orm';
import {
  bigint,
  customType,
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
import { approvalRequests } from '../approvals/index.js';
import { skus } from '../catalog/index.js';
import { journals } from '../ledger/index.js';
import { branches, locations, organizations } from '../org/index.js';

/**
 * Stock levels, movements, reservations and costing (architecture §8, M07).
 *
 * Invariant 3 lives in this schema, and it is three separate claims that need
 * three separate mechanisms:
 *
 * 1. **Stock changes only through movements.** `stock_movements` is append-only —
 *    `erp_app` holds INSERT and SELECT and nothing else (migration 0032) — and
 *    `stock_levels` is a cache of Σ movements that the same transaction updates.
 *    The nightly job rebuilds the cache from the log and alerts on any drift, so
 *    a path that edited a level without writing a movement is found the next
 *    morning rather than at the next stock count.
 * 2. **`stock_levels` never goes negative.** Two CHECKs: `on_hand >= 0` and
 *    `reserved <= on_hand`. The second is the one people forget, and without it
 *    the last five units can be written off while five are reserved for a
 *    confirmed order — the order is then unfulfillable and nothing said so.
 * 3. **Reservation is one atomic conditional UPDATE.** Not expressible in a
 *    schema; it lives in `inventory.repository.ts` and is the reason
 *    `stock_levels` has a natural primary key rather than a surrogate id — the
 *    statement has to find exactly one row by (org, sku, location) with no
 *    preceding SELECT.
 *
 * Every table here carries `org_id NOT NULL` with an index, and every foreign key
 * between two tenant tables carries `org_id` on **both** sides against a
 * `unique (org_id, id)` on the parent (D-047). Cost columns are `*_poisha`
 * bigints (invariant 1) and reach a response only through `serializeFor`
 * (invariant 5).
 */
export const inventory = pgSchema('inventory');

/**
 * `xid8`: a 64-bit, epoch-extended transaction id that never wraps.
 *
 * Same custom type the ledger declares, for the same job. `stock_levels.on_hand`
 * may only change in a transaction that also inserted a movement for that SKU and
 * location, and this is what lets migration 0033's trigger ask "did *this*
 * transaction write one" rather than "does a movement exist somewhere".
 */
const xid8 = customType<{ data: string; driverData: string }>({
  dataType: () => 'xid8',
});

/**
 * §8's twelve movement kinds, closed.
 *
 * Kept in step with `MOVEMENT_KINDS` in @elysium/domain by a test — this package
 * cannot import the domain, and two hand-maintained copies of a closed set is
 * exactly the shape that drifts. Adding a kind needs an architecture §8 edit and
 * a decisions.md row (`.claude/rules/inventory.md`).
 */
export const movementKind = inventory.enum('movement_kind', [
  'opening_balance',
  'supply_receipt',
  'supplier_return',
  'dispatch',
  'customer_return',
  'pos_sale',
  'pos_return',
  'transfer_out',
  'transfer_in',
  'adjustment_gain',
  'adjustment_loss',
  'count_correction',
]);

/** Kinds that may only add stock, as SQL for the sign CHECK below. */
const INBOUND_KINDS = sql.raw(
  "('opening_balance', 'supply_receipt', 'customer_return', 'pos_return', 'transfer_in', 'adjustment_gain')",
);
/** Kinds that may only remove it. */
const OUTBOUND_KINDS = sql.raw(
  "('supplier_return', 'dispatch', 'pos_sale', 'transfer_out', 'adjustment_loss')",
);

export const reservationStatus = inventory.enum('reservation_status', [
  'active',
  'consumed',
  'released',
]);

export const transferStatus = inventory.enum('transfer_status', [
  'dispatched',
  'received',
  'cancelled',
]);

export const countStatus = inventory.enum('count_status', [
  'open',
  'submitted',
  'closed',
  'cancelled',
]);

export const adjustmentDirection = inventory.enum('adjustment_direction', ['loss', 'gain']);

export const adjustmentStatus = inventory.enum('adjustment_status', [
  'pending_approval',
  'posted',
  'rejected',
]);

/**
 * What is on a shelf, and what is already promised (§8).
 *
 * The primary key is `(org_id, sku_id, location_id)` and there is no surrogate id,
 * because the reservation statement has to be able to name the row it updates
 * without reading it first:
 *
 *     update inventory.stock_levels set reserved = reserved + $qty
 *     where org_id = $org and sku_id = $sku and location_id = $loc
 *       and on_hand - reserved >= $qty
 *
 * Under READ COMMITTED, two concurrent copies of that statement serialise on the
 * row lock and the loser re-evaluates the `where` against the committed row, so
 * the second one updates zero rows rather than overwriting the first — which is
 * the whole of M07 check 1 (50 parallel reservations for the last 10 units yield
 * exactly 10 successes). A surrogate key invites `select … then update`, and that
 * version loses units under concurrency in a way no single-threaded test finds.
 */
export const stockLevels = inventory.table(
  'stock_levels',
  {
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    skuId: uuid('sku_id').notNull(),
    locationId: uuid('location_id').notNull(),
    onHand: integer('on_hand').notNull().default(0),
    reserved: integer('reserved').notNull().default(0),
    /** §8 "Low stock": crossing this emits `stock.low`. Zero means no alert. */
    reorderLevel: integer('reorder_level').notNull().default(0),
    ...timestamps,
  },
  (table) => [
    primaryKey({
      name: 'stock_levels_pkey',
      columns: [table.orgId, table.skuId, table.locationId],
    }),
    index('stock_levels_org_idx').on(table.orgId),
    index('stock_levels_org_sku_idx').on(table.orgId, table.skuId),
    index('stock_levels_org_location_idx').on(table.orgId, table.locationId),
    foreignKey({
      name: 'stock_levels_org_id_sku_id_fk',
      columns: [table.orgId, table.skuId],
      foreignColumns: [skus.orgId, skus.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'stock_levels_org_id_location_id_fk',
      columns: [table.orgId, table.locationId],
      foreignColumns: [locations.orgId, locations.id],
    }).onDelete('restrict'),
    // Invariant 3, as arithmetic the database enforces.
    check('stock_levels_on_hand_not_negative', sql`${table.onHand} >= 0`),
    check('stock_levels_reserved_not_negative', sql`${table.reserved} >= 0`),
    check('stock_levels_reserved_within_on_hand', sql`${table.reserved} <= ${table.onHand}`),
    check('stock_levels_reorder_not_negative', sql`${table.reorderLevel} >= 0`),
  ],
);

/**
 * Every stock change that ever happened (§8, append-only).
 *
 * `dedupe_key` is what makes a movement safe to write from a retried job. §20's
 * queues are at-least-once, so "record the dispatch for this order line" will
 * sometimes arrive twice; without a unique key the second delivery ships the
 * stock again. Callers build it from the event's identity — `order:<id>:dispatch`
 * — and the unique index refuses the replay rather than trusting the worker to
 * have finished.
 *
 * `unit_cost_poisha` is cost information (invariant 5): it reaches a response only
 * through `serializeFor`, which strips it for a role without `read:cost`, and it
 * is in `COST_FIELDS` so forgetting is a test failure rather than a leak.
 */
export const stockMovements = inventory.table(
  'stock_movements',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    skuId: uuid('sku_id').notNull(),
    locationId: uuid('location_id').notNull(),
    kind: movementKind('kind').notNull(),
    /** Signed: positive adds, negative removes. The sign must match the kind. */
    qtyDelta: integer('qty_delta').notNull(),
    /**
     * What one unit was worth in this movement.
     *
     * On the way in it is the purchase price or the cost a return was dispatched
     * at; on the way out it is the weighted average **at that moment**, recorded
     * because §7's delivery journal has to credit goods in transit exactly what
     * the handover debited it. Null only where the movement genuinely has no
     * value — a transfer, which never changes cost.
     */
    unitCostPoisha: bigint('unit_cost_poisha', { mode: 'bigint' }),
    /** What caused it: `supply`, `order`, `transfer`, `count`, `adjustment`, `opening`. */
    refType: text('ref_type').notNull(),
    refId: uuid('ref_id'),
    /** Idempotency for a retried job or a double-clicked button. */
    dedupeKey: text('dedupe_key'),
    /** The Asia/Dhaka calendar date of the movement (invariant 8). */
    businessDate: date('business_date').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    memo: text('memo'),
    createdBy: text('created_by').notNull(),
    /**
     * The transaction that wrote this movement, stamped by a trigger (any
     * supplied value is overwritten).
     *
     * This is what makes invariant 3 checkable rather than merely stated.
     * `stock_levels.on_hand` is a cache, so the database cannot tell a legitimate
     * refresh from a hand-edited number by looking at the level alone — but it can
     * insist that any transaction changing `on_hand` also inserted a movement for
     * the same SKU and location. Migration 0033's trigger does exactly that, and
     * it is the reason there is no code path in this system that moves stock
     * without leaving a row saying so.
     */
    createdTxid: xid8('created_txid').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    unique('stock_movements_org_id_id_key').on(table.orgId, table.id),
    index('stock_movements_org_idx').on(table.orgId),
    index('stock_movements_org_sku_location_idx').on(table.orgId, table.skuId, table.locationId),
    index('stock_movements_org_date_idx').on(table.orgId, table.businessDate),
    index('stock_movements_org_ref_idx').on(table.orgId, table.refType, table.refId),
    uniqueIndex('stock_movements_org_dedupe_idx')
      .on(table.orgId, table.dedupeKey)
      .where(sql`${table.dedupeKey} is not null`),
    foreignKey({
      name: 'stock_movements_org_id_sku_id_fk',
      columns: [table.orgId, table.skuId],
      foreignColumns: [skus.orgId, skus.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'stock_movements_org_id_location_id_fk',
      columns: [table.orgId, table.locationId],
      foreignColumns: [locations.orgId, locations.id],
    }).onDelete('restrict'),
    /*
     * The sign follows from the kind, in the database.
     *
     * A `dispatch` with a positive delta would create stock, and the nightly
     * reconciliation would agree with it — levels are rebuilt from movements, so
     * a corrupt movement is a corrupt answer that reports itself as healthy. The
     * comparison is on `::text` so the CHECK does not depend on the enum's
     * ordering, which a later migration could change.
     */
    check(
      'stock_movements_sign_matches_kind',
      sql`(${table.kind}::text in ${INBOUND_KINDS} and ${table.qtyDelta} > 0)
          or (${table.kind}::text in ${OUTBOUND_KINDS} and ${table.qtyDelta} < 0)
          or (${table.kind}::text = 'count_correction' and ${table.qtyDelta} <> 0)`,
    ),
    check(
      'stock_movements_unit_cost_not_negative',
      sql`${table.unitCostPoisha} is null or ${table.unitCostPoisha} >= 0`,
    ),
    check(
      'stock_movements_unit_cost_bounded',
      sql`${table.unitCostPoisha} is null or ${table.unitCostPoisha} <= 9000000000000000`,
    ),
    check('stock_movements_ref_type_format', sql`${table.refType} ~ '^[a-z][a-z0-9_]{0,31}$'`),
    check(
      'stock_movements_memo_length',
      sql`${table.memo} is null or length(${table.memo}) <= 500`,
    ),
  ],
);

/**
 * Weighted average cost, one row per org and SKU (§8).
 *
 * Per org, not per location, so moving a carton between two warehouses cannot
 * change what the units cost. `qty_basis` is the org-wide on-hand the average is
 * based on, maintained by every movement that changes on-hand and checked against
 * Σ `stock_levels.on_hand` by the nightly reconciliation — a basis that has
 * drifted makes the *next* receipt's average wrong, which is a silent error that
 * compounds.
 */
export const skuCosts = inventory.table(
  'sku_costs',
  {
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    skuId: uuid('sku_id').notNull(),
    /*
     * No column default.
     *
     * `.default(0n)` is what a reader expects here and drizzle-kit cannot
     * serialise a BigInt into its snapshot, so it fails the generator outright.
     * Every write to this table is an upsert that computes both columns, so the
     * default would never be used anyway — and a cost column that can be
     * inserted without a value is one a future caller will insert without one.
     */
    wacPoisha: bigint('wac_poisha', { mode: 'bigint' }).notNull(),
    qtyBasis: integer('qty_basis').notNull().default(0),
    ...timestamps,
  },
  (table) => [
    primaryKey({ name: 'sku_costs_pkey', columns: [table.orgId, table.skuId] }),
    index('sku_costs_org_idx').on(table.orgId),
    foreignKey({
      name: 'sku_costs_org_id_sku_id_fk',
      columns: [table.orgId, table.skuId],
      foreignColumns: [skus.orgId, skus.id],
    }).onDelete('restrict'),
    check('sku_costs_wac_not_negative', sql`${table.wacPoisha} >= 0`),
    check('sku_costs_wac_bounded', sql`${table.wacPoisha} <= 9000000000000000`),
    check('sku_costs_basis_not_negative', sql`${table.qtyBasis} >= 0`),
  ],
);

/**
 * Stock held for something that has not shipped yet (§8).
 *
 * A reservation row is the *record* of a hold; the hold itself is the `reserved`
 * column on the level, because that is the only representation a single
 * conditional UPDATE can enforce. Both are written in one transaction, and the
 * partial unique index makes a hold idempotent per reference — an order desk that
 * confirms the same order twice does not reserve twice.
 */
export const reservations = inventory.table(
  'reservations',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    skuId: uuid('sku_id').notNull(),
    locationId: uuid('location_id').notNull(),
    qty: integer('qty').notNull(),
    refType: text('ref_type').notNull(),
    refId: uuid('ref_id').notNull(),
    status: reservationStatus('status').notNull().default('active'),
    createdBy: text('created_by').notNull(),
    ...timestamps,
  },
  (table) => [
    unique('reservations_org_id_id_key').on(table.orgId, table.id),
    index('reservations_org_idx').on(table.orgId),
    index('reservations_org_ref_idx').on(table.orgId, table.refType, table.refId),
    index('reservations_org_sku_idx').on(table.orgId, table.skuId, table.locationId),
    uniqueIndex('reservations_org_active_ref_idx')
      .on(table.orgId, table.refType, table.refId, table.skuId, table.locationId)
      .where(sql`${table.status} = 'active'`),
    foreignKey({
      name: 'reservations_org_id_sku_id_fk',
      columns: [table.orgId, table.skuId],
      foreignColumns: [skus.orgId, skus.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'reservations_org_id_location_id_fk',
      columns: [table.orgId, table.locationId],
      foreignColumns: [locations.orgId, locations.id],
    }).onDelete('restrict'),
    check('reservations_qty_positive', sql`${table.qty} > 0`),
    check('reservations_ref_type_format', sql`${table.refType} ~ '^[a-z][a-z0-9_]{0,31}$'`),
  ],
);

/**
 * A two-step transfer (§8): `transfer_out` to the in-transit location, then
 * `transfer_in` at the destination.
 *
 * The in-transit location is a real row in `org.locations` with kind
 * `in_transit`, not a null or a flag, so stock in a van is visible on the same
 * screens as stock on a shelf and is counted by the same reconciliation. A
 * transfer that vanished from every level between dispatch and receipt would be
 * stock nobody could find, and the difference between "in transit" and "lost" is
 * the entire reason for the second step.
 */
export const stockTransfers = inventory.table(
  'stock_transfers',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    fromLocationId: uuid('from_location_id').notNull(),
    toLocationId: uuid('to_location_id').notNull(),
    transitLocationId: uuid('transit_location_id').notNull(),
    status: transferStatus('status').notNull().default('dispatched'),
    memo: text('memo'),
    createdBy: text('created_by').notNull(),
    receivedBy: text('received_by'),
    dispatchedAt: timestamp('dispatched_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    receivedAt: timestamp('received_at', { withTimezone: true, mode: 'date' }),
    ...timestamps,
  },
  (table) => [
    unique('stock_transfers_org_id_id_key').on(table.orgId, table.id),
    index('stock_transfers_org_idx').on(table.orgId),
    index('stock_transfers_org_status_idx').on(table.orgId, table.status),
    foreignKey({
      name: 'stock_transfers_org_id_from_location_id_fk',
      columns: [table.orgId, table.fromLocationId],
      foreignColumns: [locations.orgId, locations.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'stock_transfers_org_id_to_location_id_fk',
      columns: [table.orgId, table.toLocationId],
      foreignColumns: [locations.orgId, locations.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'stock_transfers_org_id_transit_location_id_fk',
      columns: [table.orgId, table.transitLocationId],
      foreignColumns: [locations.orgId, locations.id],
    }).onDelete('restrict'),
    check(
      'stock_transfers_distinct_locations',
      sql`${table.fromLocationId} <> ${table.toLocationId}`,
    ),
    check(
      'stock_transfers_received_is_complete',
      sql`(${table.status} = 'received' and ${table.receivedAt} is not null and ${table.receivedBy} is not null)
          or (${table.status} <> 'received' and ${table.receivedAt} is null and ${table.receivedBy} is null)`,
    ),
    check(
      'stock_transfers_memo_length',
      sql`${table.memo} is null or length(${table.memo}) <= 500`,
    ),
  ],
);

export const stockTransferLines = inventory.table(
  'stock_transfer_lines',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    transferId: uuid('transfer_id').notNull(),
    skuId: uuid('sku_id').notNull(),
    qty: integer('qty').notNull(),
    ...timestamps,
  },
  (table) => [
    unique('stock_transfer_lines_org_id_id_key').on(table.orgId, table.id),
    index('stock_transfer_lines_org_idx').on(table.orgId),
    uniqueIndex('stock_transfer_lines_org_transfer_sku_idx').on(
      table.orgId,
      table.transferId,
      table.skuId,
    ),
    foreignKey({
      name: 'stock_transfer_lines_org_id_transfer_id_fk',
      columns: [table.orgId, table.transferId],
      foreignColumns: [stockTransfers.orgId, stockTransfers.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'stock_transfer_lines_org_id_sku_id_fk',
      columns: [table.orgId, table.skuId],
      foreignColumns: [skus.orgId, skus.id],
    }).onDelete('restrict'),
    check('stock_transfer_lines_qty_positive', sql`${table.qty} > 0`),
  ],
);

/**
 * A stock count (§8): the session freezes a snapshot, staff enter what they
 * found, and the variance becomes adjustments that need approval.
 *
 * `snapshot_qty` on each line is frozen at open and never recomputed. That is the
 * point of a session: a count compared against a level that moved while people
 * were counting produces a variance for every sale that happened during the
 * count, and the staff who did the counting get blamed for it.
 */
export const countSessions = inventory.table(
  'count_sessions',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    locationId: uuid('location_id').notNull(),
    /** Copied from the location, for §6's branch row scope. Held equal by a trigger. */
    branchId: uuid('branch_id'),
    status: countStatus('status').notNull().default('open'),
    memo: text('memo'),
    frozenAt: timestamp('frozen_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    closedAt: timestamp('closed_at', { withTimezone: true, mode: 'date' }),
    createdBy: text('created_by').notNull(),
    ...timestamps,
  },
  (table) => [
    unique('count_sessions_org_id_id_key').on(table.orgId, table.id),
    index('count_sessions_org_idx').on(table.orgId),
    index('count_sessions_org_branch_idx').on(table.orgId, table.branchId),
    // One open count per location: two concurrent sessions would each freeze a
    // snapshot and each post a variance against it, double-counting every
    // difference they both found.
    uniqueIndex('count_sessions_org_open_location_idx')
      .on(table.orgId, table.locationId)
      .where(sql`${table.status} in ('open', 'submitted')`),
    foreignKey({
      name: 'count_sessions_org_id_location_id_fk',
      columns: [table.orgId, table.locationId],
      foreignColumns: [locations.orgId, locations.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'count_sessions_org_id_branch_id_fk',
      columns: [table.orgId, table.branchId],
      foreignColumns: [branches.orgId, branches.id],
    }).onDelete('restrict'),
    check(
      'count_sessions_closed_is_complete',
      sql`(${table.status} in ('closed', 'cancelled')) = (${table.closedAt} is not null)`,
    ),
    check('count_sessions_memo_length', sql`${table.memo} is null or length(${table.memo}) <= 500`),
  ],
);

export const countLines = inventory.table(
  'count_lines',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    sessionId: uuid('session_id').notNull(),
    skuId: uuid('sku_id').notNull(),
    /** On-hand when the session opened. Never recomputed. */
    snapshotQty: integer('snapshot_qty').notNull(),
    /** Null until somebody counts this SKU. */
    countedQty: integer('counted_qty'),
    countedBy: text('counted_by'),
    ...timestamps,
  },
  (table) => [
    unique('count_lines_org_id_id_key').on(table.orgId, table.id),
    index('count_lines_org_idx').on(table.orgId),
    uniqueIndex('count_lines_org_session_sku_idx').on(table.orgId, table.sessionId, table.skuId),
    foreignKey({
      name: 'count_lines_org_id_session_id_fk',
      columns: [table.orgId, table.sessionId],
      foreignColumns: [countSessions.orgId, countSessions.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'count_lines_org_id_sku_id_fk',
      columns: [table.orgId, table.skuId],
      foreignColumns: [skus.orgId, skus.id],
    }).onDelete('restrict'),
    check('count_lines_snapshot_not_negative', sql`${table.snapshotQty} >= 0`),
    check(
      'count_lines_counted_not_negative',
      sql`${table.countedQty} is null or ${table.countedQty} >= 0`,
    ),
    check(
      'count_lines_counted_is_complete',
      sql`(${table.countedQty} is null) = (${table.countedBy} is null)`,
    ),
  ],
);

/**
 * A stock write-off or gain, waiting for a second person (§7, §8).
 *
 * `value_poisha` is **frozen when the request is raised** and is what the journal
 * posts. The weighted average can move between the request and the decision, and
 * posting today's value would mean the checker approved one number and the ledger
 * recorded another — which is the thing an approval exists to prevent. D-078 says
 * the executor reads the approval's amount and nothing else; this column is the
 * row's copy of that same figure, held equal by the executor.
 *
 * There is no DELETE grant. A rejected write-off is evidence: "who tried to write
 * off forty thousand taka of stock and who said no" is a question that gets asked
 * exactly once, and only after something has gone wrong.
 */
export const adjustments = inventory.table(
  'adjustments',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    locationId: uuid('location_id').notNull(),
    /** Copied from the location for §6's branch row scope. Held equal by a trigger. */
    branchId: uuid('branch_id'),
    direction: adjustmentDirection('direction').notNull(),
    status: adjustmentStatus('status').notNull().default('pending_approval'),
    /** Set when the adjustment came out of a count session's variance. */
    countSessionId: uuid('count_session_id'),
    /** Σ qty × WAC at the moment the request was raised. */
    valuePoisha: bigint('value_poisha', { mode: 'bigint' }).notNull(),
    reason: text('reason').notNull(),
    approvalRequestId: uuid('approval_request_id'),
    journalId: uuid('journal_id'),
    businessDate: date('business_date').notNull(),
    createdBy: text('created_by').notNull(),
    ...timestamps,
  },
  (table) => [
    unique('adjustments_org_id_id_key').on(table.orgId, table.id),
    index('adjustments_org_idx').on(table.orgId),
    index('adjustments_org_status_idx').on(table.orgId, table.status),
    index('adjustments_org_branch_idx').on(table.orgId, table.branchId),
    index('adjustments_org_session_idx').on(table.orgId, table.countSessionId),
    foreignKey({
      name: 'adjustments_org_id_location_id_fk',
      columns: [table.orgId, table.locationId],
      foreignColumns: [locations.orgId, locations.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'adjustments_org_id_branch_id_fk',
      columns: [table.orgId, table.branchId],
      foreignColumns: [branches.orgId, branches.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'adjustments_org_id_count_session_id_fk',
      columns: [table.orgId, table.countSessionId],
      foreignColumns: [countSessions.orgId, countSessions.id],
    }).onDelete('restrict'),
    /*
     * The approval and the journal, referenced the same way M08's cash entries
     * reference theirs — composite, so the reference can only be satisfied from
     * within this org (D-047).
     *
     * Migration 0034's trigger already checks far more than existence: the approval's
     * type, branch and amount have to match the stock this row would adjust. The
     * foreign key is still worth having, because a trigger checks what was true at
     * write time and a key keeps it true — neither an approval nor a journal can be
     * deleted out from under a posted write-off, which is what makes "who approved
     * this, and what did it post" answerable a year later.
     */
    foreignKey({
      name: 'adjustments_org_id_approval_request_id_fk',
      columns: [table.orgId, table.approvalRequestId],
      foreignColumns: [approvalRequests.orgId, approvalRequests.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'adjustments_org_id_journal_id_fk',
      columns: [table.orgId, table.journalId],
      foreignColumns: [journals.orgId, journals.id],
    }).onDelete('restrict'),
    check('adjustments_value_not_negative', sql`${table.valuePoisha} >= 0`),
    check('adjustments_reason_length', sql`length(${table.reason}) between 1 and 500`),
    /*
     * The same shape M08's cash entries use: a status that says "posted" with no
     * journal, or "waiting" with no approval, is a state nothing produces on
     * purpose and a partial update produces easily.
     */
    check(
      'adjustments_status_journal',
      sql`case ${table.status}
            when 'posted' then ${table.journalId} is not null and ${table.approvalRequestId} is not null
            when 'pending_approval' then ${table.journalId} is null and ${table.approvalRequestId} is not null
            else ${table.journalId} is null
          end`,
    ),
  ],
);

export const adjustmentLines = inventory.table(
  'adjustment_lines',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    adjustmentId: uuid('adjustment_id').notNull(),
    skuId: uuid('sku_id').notNull(),
    /** Units, always positive. The direction is on the header. */
    qty: integer('qty').notNull(),
    /** The weighted average when the request was raised. */
    unitCostPoisha: bigint('unit_cost_poisha', { mode: 'bigint' }).notNull(),
    ...timestamps,
  },
  (table) => [
    unique('adjustment_lines_org_id_id_key').on(table.orgId, table.id),
    index('adjustment_lines_org_idx').on(table.orgId),
    uniqueIndex('adjustment_lines_org_adjustment_sku_idx').on(
      table.orgId,
      table.adjustmentId,
      table.skuId,
    ),
    foreignKey({
      name: 'adjustment_lines_org_id_adjustment_id_fk',
      columns: [table.orgId, table.adjustmentId],
      foreignColumns: [adjustments.orgId, adjustments.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'adjustment_lines_org_id_sku_id_fk',
      columns: [table.orgId, table.skuId],
      foreignColumns: [skus.orgId, skus.id],
    }).onDelete('restrict'),
    check('adjustment_lines_qty_positive', sql`${table.qty} > 0`),
    check('adjustment_lines_unit_cost_not_negative', sql`${table.unitCostPoisha} >= 0`),
  ],
);

/**
 * What the nightly reconciliation found (§8, §26).
 *
 * A row per run, per org, whether or not anything was wrong. Recording the clean
 * runs is what makes the table useful: "no drift reported" and "the job has not
 * run since Tuesday" are the same silence otherwise, and the second one is the
 * emergency.
 *
 * `details` holds the drifting keys and both numbers — never a cost, because this
 * table is read by whoever is investigating and the value of the drift is
 * derivable from the SKU's WAC if they hold `read:cost`.
 */
export const reconciliations = inventory.table(
  'reconciliations',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    businessDate: date('business_date').notNull(),
    levelsChecked: integer('levels_checked').notNull(),
    driftCount: integer('drift_count').notNull(),
    costDriftCount: integer('cost_drift_count').notNull().default(0),
    details: jsonb('details').notNull().default([]),
    ranAt: timestamp('ran_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    unique('reconciliations_org_id_id_key').on(table.orgId, table.id),
    index('reconciliations_org_idx').on(table.orgId),
    index('reconciliations_org_date_idx').on(table.orgId, table.businessDate),
    check(
      'reconciliations_counts_not_negative',
      sql`${table.levelsChecked} >= 0 and ${table.driftCount} >= 0`,
    ),
  ],
);
