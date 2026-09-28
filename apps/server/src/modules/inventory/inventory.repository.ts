import type { Tx } from '@elysium/db';
import { sql, type SQL } from 'drizzle-orm';

/**
 * Every SQL statement the inventory module runs (tenancy rules: raw SQL lives in
 * repositories, parameterised, never built by string interpolation).
 *
 * All of it runs inside a caller's `withOrg()` transaction. Two statements here
 * carry invariant 3 and are worth reading before anything else:
 *
 * * `reserveStock` is §8's conditional UPDATE, verbatim. There is no SELECT in
 *   front of it, by design: under READ COMMITTED two concurrent copies serialise
 *   on the row lock and the loser re-evaluates `on_hand - reserved >= $qty`
 *   against the committed row, so it updates zero rows instead of overwriting the
 *   winner. Zero rows is `STOCK_INSUFFICIENT`. The read-then-write version passes
 *   every single-threaded test and oversells the last unit in production.
 * * `applyLevelDelta` is the only writer of `on_hand`, and migration 0033's
 *   trigger refuses it unless the same transaction also inserted a movement for
 *   the same SKU and location. So "stock changes only through movements" is a
 *   property of the database rather than of this file's discipline.
 */

// --- locations ----------------------------------------------------------------

export interface LocationRow extends Record<string, unknown> {
  readonly id: string;
  readonly branch_id: string | null;
  readonly code: string;
  readonly name: string;
  readonly kind: string;
  readonly is_active: boolean;
}

const LOCATION_COLUMNS = sql`l.id, l.branch_id, l.code, l.name, l.kind::text as kind, l.is_active`;

export async function listLocations(
  tx: Tx,
  orgId: string,
  filters: { readonly scope: SQL; readonly includeInactive: boolean },
): Promise<LocationRow[]> {
  const rows = await tx.execute<LocationRow>(sql`
    select ${LOCATION_COLUMNS}
    from org.locations l
    where l.org_id = ${orgId}
      and ${filters.scope}
      and ${filters.includeInactive ? sql`true` : sql`l.is_active`}
    order by l.code
  `);
  return [...rows];
}

export async function locationById(
  tx: Tx,
  orgId: string,
  id: string,
): Promise<LocationRow | undefined> {
  const rows = await tx.execute<LocationRow>(sql`
    select ${LOCATION_COLUMNS} from org.locations l where l.org_id = ${orgId} and l.id = ${id}
  `);
  return rows[0];
}

export async function locationByCode(
  tx: Tx,
  orgId: string,
  code: string,
): Promise<LocationRow | undefined> {
  const rows = await tx.execute<LocationRow>(sql`
    select ${LOCATION_COLUMNS} from org.locations l where l.org_id = ${orgId} and l.code = ${code}
  `);
  return rows[0];
}

export async function insertLocation(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly branchId: string | null;
    readonly code: string;
    readonly name: string;
    readonly kind: string;
  },
): Promise<string> {
  const rows = await tx.execute<{ id: string }>(sql`
    insert into org.locations (org_id, branch_id, code, name, kind)
    values (${input.orgId}, ${input.branchId}::uuid, ${input.code}, ${input.name},
            ${input.kind}::org.location_kind)
    returning id
  `);
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('inserting a location returned no id');
  return id;
}

export async function updateLocation(
  tx: Tx,
  orgId: string,
  id: string,
  patch: { readonly name?: string; readonly isActive?: boolean },
): Promise<void> {
  await tx.execute(sql`
    update org.locations
    set name = ${patch.name === undefined ? sql`name` : sql`${patch.name}`},
        is_active = ${patch.isActive === undefined ? sql`is_active` : sql`${patch.isActive}`},
        updated_at = now()
    where org_id = ${orgId} and id = ${id}
  `);
}

/**
 * The org's first `in_transit` location, which a transfer parks stock in.
 *
 * Looked up rather than configured, because there is nothing to choose between:
 * §8 gives an org one in-transit location and a transfer that could pick among
 * several would make "where is the stock that left on Tuesday" a search.
 */
export async function inTransitLocation(tx: Tx, orgId: string): Promise<LocationRow | undefined> {
  const rows = await tx.execute<LocationRow>(sql`
    select ${LOCATION_COLUMNS}
    from org.locations l
    where l.org_id = ${orgId} and l.kind = 'in_transit' and l.is_active
    order by l.code
    limit 1
  `);
  return rows[0];
}

// --- levels -------------------------------------------------------------------

export interface LevelRow extends Record<string, unknown> {
  readonly sku_id: string;
  readonly location_id: string;
  readonly on_hand: number;
  readonly reserved: number;
  readonly reorder_level: number;
}

/**
 * Add `delta` to one level, creating the row if the SKU has never been at this
 * location.
 *
 * Two statements, not one, and the split is forced by PostgreSQL rather than chosen.
 * `insert … on conflict do update` evaluates the proposed tuple's CHECK constraints
 * *before* it detects the conflict, so an outbound movement — whose proposed tuple
 * carries a negative `on_hand` — is refused by `stock_levels_on_hand_not_negative`
 * even when a row already exists and the update would have been perfectly valid. The
 * upsert is therefore used only for stock arriving, where the proposed tuple is
 * positive and legal.
 *
 * Stock leaving is a plain UPDATE, and the two ways it can fail say different things:
 *
 * * **no row matched** — the SKU has never been at this location, so there is nothing
 *   to take;
 * * **the CHECK fired** — there is a row and it does not hold enough, or what it
 *   holds is reserved for confirmed orders. `databaseStockCode` turns
 *   `stock_levels_on_hand_not_negative` and `stock_levels_reserved_within_on_hand`
 *   into `STOCK_INSUFFICIENT` with messages that distinguish an empty shelf from a
 *   promised one.
 *
 * Guarding the shortfall here with `and on_hand + $delta >= 0` was the other option
 * and is worse: it collapses both failures into "zero rows updated", so the caller
 * cannot tell a missing level from a promised one and the user is told the wrong
 * thing about a full shelf.
 */
export async function applyLevelDelta(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly skuId: string;
    readonly locationId: string;
    readonly delta: number;
  },
): Promise<LevelRow | undefined> {
  if (input.delta > 0) {
    const rows = await tx.execute<LevelRow>(sql`
      insert into inventory.stock_levels (org_id, sku_id, location_id, on_hand)
      values (${input.orgId}, ${input.skuId}, ${input.locationId}, ${input.delta})
      on conflict (org_id, sku_id, location_id) do update
        set on_hand = inventory.stock_levels.on_hand + ${input.delta},
            updated_at = now()
      returning sku_id, location_id, on_hand, reserved, reorder_level
    `);
    const row = rows[0];
    if (row === undefined) throw new Error('applying a level delta returned no row');
    return row;
  }

  const rows = await tx.execute<LevelRow>(sql`
    update inventory.stock_levels
    set on_hand = on_hand + ${input.delta}, updated_at = now()
    where org_id = ${input.orgId}
      and sku_id = ${input.skuId}
      and location_id = ${input.locationId}
    returning sku_id, location_id, on_hand, reserved, reorder_level
  `);
  return rows[0];
}

/**
 * §8's reservation statement, unchanged.
 *
 * Returns the row when it took the units and `undefined` when it did not. Nothing
 * else distinguishes the two cases, and nothing else needs to: a missing level and
 * an exhausted one are the same answer to "can I promise this unit", and treating
 * them differently would leak whether a SKU has ever been stocked at a location.
 */
export async function reserveStock(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly skuId: string;
    readonly locationId: string;
    readonly qty: number;
  },
): Promise<LevelRow | undefined> {
  const rows = await tx.execute<LevelRow>(sql`
    update inventory.stock_levels
    set reserved = reserved + ${input.qty}, updated_at = now()
    where org_id = ${input.orgId}
      and sku_id = ${input.skuId}
      and location_id = ${input.locationId}
      and on_hand - reserved >= ${input.qty}
    returning sku_id, location_id, on_hand, reserved, reorder_level
  `);
  return rows[0];
}

/** Give reserved units back. Refuses to release more than are held. */
export async function releaseStock(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly skuId: string;
    readonly locationId: string;
    readonly qty: number;
  },
): Promise<LevelRow | undefined> {
  const rows = await tx.execute<LevelRow>(sql`
    update inventory.stock_levels
    set reserved = reserved - ${input.qty}, updated_at = now()
    where org_id = ${input.orgId}
      and sku_id = ${input.skuId}
      and location_id = ${input.locationId}
      and reserved >= ${input.qty}
    returning sku_id, location_id, on_hand, reserved, reorder_level
  `);
  return rows[0];
}

/**
 * Ship reserved units: they leave the shelf and stop being reserved, in one
 * statement.
 *
 * One statement rather than "release, then apply a negative delta" because the
 * intermediate state is visible to every other transaction: between the release
 * and the dispatch the units look available, and a second order confirmed in that
 * window reserves stock that is already in a courier's van.
 */
export async function consumeReservedStock(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly skuId: string;
    readonly locationId: string;
    readonly qty: number;
  },
): Promise<LevelRow | undefined> {
  const rows = await tx.execute<LevelRow>(sql`
    update inventory.stock_levels
    set on_hand = on_hand - ${input.qty},
        reserved = reserved - ${input.qty},
        updated_at = now()
    where org_id = ${input.orgId}
      and sku_id = ${input.skuId}
      and location_id = ${input.locationId}
      and reserved >= ${input.qty}
      and on_hand >= ${input.qty}
    returning sku_id, location_id, on_hand, reserved, reorder_level
  `);
  return rows[0];
}

export async function setReorderLevel(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly skuId: string;
    readonly locationId: string;
    readonly reorderLevel: number;
  },
): Promise<void> {
  await tx.execute(sql`
    insert into inventory.stock_levels (org_id, sku_id, location_id, on_hand, reorder_level)
    values (${input.orgId}, ${input.skuId}, ${input.locationId}, 0, ${input.reorderLevel})
    on conflict (org_id, sku_id, location_id) do update
      set reorder_level = ${input.reorderLevel}, updated_at = now()
  `);
}

export async function levelFor(
  tx: Tx,
  orgId: string,
  skuId: string,
  locationId: string,
): Promise<LevelRow | undefined> {
  const rows = await tx.execute<LevelRow>(sql`
    select sku_id, location_id, on_hand, reserved, reorder_level
    from inventory.stock_levels
    where org_id = ${orgId} and sku_id = ${skuId} and location_id = ${locationId}
  `);
  return rows[0];
}

export interface StockViewRow extends Record<string, unknown> {
  readonly sku_id: string;
  readonly sku_code: string;
  readonly product_name: string;
  readonly location_id: string;
  readonly location_code: string;
  readonly location_name: string;
  readonly branch_id: string | null;
  readonly on_hand: number;
  readonly reserved: number;
  readonly available: number;
  readonly reorder_level: number;
  /** Cost, stripped by `serializeFor` for a role without `read:cost`. */
  readonly wac_poisha: string;
  readonly stock_value_poisha: string;
}

/**
 * The stock list: availability for every role, value for the cost roles.
 *
 * The cost columns are selected unconditionally and removed on the way out by
 * `serializeFor`, which is the arrangement invariant 5 asks for — one query, one
 * place that strips. Branching the SQL on the caller's role instead would put the
 * decision in two places, and the second one is the one that gets it wrong.
 */
export async function listStock(
  tx: Tx,
  orgId: string,
  filters: {
    readonly scope: SQL;
    readonly locationId?: string | undefined;
    readonly skuQuery?: string | undefined;
    readonly lowOnly: boolean;
    readonly limit: number;
    readonly offset: number;
  },
): Promise<StockViewRow[]> {
  const rows = await tx.execute<StockViewRow>(sql`
    select s.id as sku_id, s.code as sku_code, p.name as product_name,
           l.id as location_id, l.code as location_code, l.name as location_name,
           l.branch_id,
           sl.on_hand, sl.reserved, sl.on_hand - sl.reserved as available, sl.reorder_level,
           coalesce(c.wac_poisha, 0)::text as wac_poisha,
           (coalesce(c.wac_poisha, 0) * sl.on_hand)::text as stock_value_poisha
    from inventory.stock_levels sl
    join catalog.skus s on s.org_id = sl.org_id and s.id = sl.sku_id
    join catalog.products p on p.org_id = s.org_id and p.id = s.product_id
    join org.locations l on l.org_id = sl.org_id and l.id = sl.location_id
    left join inventory.sku_costs c on c.org_id = sl.org_id and c.sku_id = sl.sku_id
    where sl.org_id = ${orgId}
      and ${filters.scope}
      and ${filters.locationId === undefined ? sql`true` : sql`sl.location_id = ${filters.locationId}::uuid`}
      and ${
        filters.skuQuery === undefined
          ? sql`true`
          : sql`(s.code ilike ${`%${filters.skuQuery}%`} or p.name ilike ${`%${filters.skuQuery}%`})`
      }
      and ${filters.lowOnly ? sql`sl.reorder_level > 0 and sl.on_hand - sl.reserved <= sl.reorder_level` : sql`true`}
    order by s.code, l.code
    limit ${filters.limit} offset ${filters.offset}
  `);
  return [...rows];
}

/** Σ value and Σ units, for the stock valuation report (cost roles only). */
export async function stockValuation(
  tx: Tx,
  orgId: string,
  filters: { readonly scope: SQL; readonly locationId?: string | undefined },
): Promise<{ readonly units: number; readonly stockValuePoisha: string }> {
  const rows = await tx.execute<{ units: string; value: string }>(sql`
    select coalesce(sum(sl.on_hand), 0)::text as units,
           coalesce(sum(coalesce(c.wac_poisha, 0) * sl.on_hand), 0)::text as value
    from inventory.stock_levels sl
    join org.locations l on l.org_id = sl.org_id and l.id = sl.location_id
    left join inventory.sku_costs c on c.org_id = sl.org_id and c.sku_id = sl.sku_id
    where sl.org_id = ${orgId}
      and ${filters.scope}
      and ${filters.locationId === undefined ? sql`true` : sql`sl.location_id = ${filters.locationId}::uuid`}
  `);
  return {
    units: Number(rows[0]?.units ?? '0'),
    stockValuePoisha: rows[0]?.value ?? '0',
  };
}

// --- movements ----------------------------------------------------------------

export interface MovementRow extends Record<string, unknown> {
  readonly id: string;
  readonly sku_id: string;
  readonly sku_code: string;
  readonly location_id: string;
  readonly kind: string;
  readonly qty_delta: number;
  readonly unit_cost_poisha: string | null;
  readonly ref_type: string;
  readonly ref_id: string | null;
  readonly business_date: string;
  readonly memo: string | null;
  readonly created_by: string;
  readonly created_at: Date;
}

export async function insertMovement(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly skuId: string;
    readonly locationId: string;
    readonly kind: string;
    readonly qtyDelta: number;
    readonly unitCostPoisha: bigint | null;
    readonly refType: string;
    readonly refId: string | null;
    readonly dedupeKey: string | null;
    readonly businessDate: string;
    readonly occurredAt: Date;
    readonly memo: string | null;
    readonly createdBy: string;
  },
): Promise<string> {
  const rows = await tx.execute<{ id: string }>(sql`
    insert into inventory.stock_movements
      (org_id, sku_id, location_id, kind, qty_delta, unit_cost_poisha,
       ref_type, ref_id, dedupe_key, business_date, occurred_at, memo, created_by, created_txid)
    values (
      ${input.orgId}, ${input.skuId}, ${input.locationId},
      ${input.kind}::inventory.movement_kind, ${input.qtyDelta},
      ${input.unitCostPoisha === null ? null : input.unitCostPoisha.toString()},
      ${input.refType}, ${input.refId}::uuid, ${input.dedupeKey},
      ${input.businessDate}::date, ${input.occurredAt.toISOString()}::timestamptz,
      ${input.memo}, ${input.createdBy},
      -- Overwritten by 0033's trigger. Supplied because the column is NOT NULL
      -- and a BEFORE trigger cannot rescue a null that never arrived.
      pg_current_xact_id()
    )
    returning id
  `);
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('inserting a movement returned no id');
  return id;
}

/**
 * The movement with this dedupe key, if a retry already wrote it.
 *
 * Returns the recorded unit cost as well as the id, and the cost is the reason this
 * is not just an existence check. A partially replayed event — three lines of which
 * two already landed — has to report the same value it reported the first time, or
 * the journal it posts is smaller than the journal already keyed to that event, and
 * `ledger.post` answers `IDEMPOTENCY_CONFLICT` for what is genuinely a retry.
 */
export async function movementByDedupeKey(
  tx: Tx,
  orgId: string,
  dedupeKey: string,
): Promise<{ id: string; unit_cost_poisha: string | null } | undefined> {
  const rows = await tx.execute<{ id: string; unit_cost_poisha: string | null }>(sql`
    select id, unit_cost_poisha::text as unit_cost_poisha
    from inventory.stock_movements
    where org_id = ${orgId} and dedupe_key = ${dedupeKey}
  `);
  return rows[0];
}

export async function listMovements(
  tx: Tx,
  orgId: string,
  filters: {
    readonly scope: SQL;
    readonly skuId?: string | undefined;
    readonly locationId?: string | undefined;
    readonly from?: string | undefined;
    readonly to?: string | undefined;
    readonly limit: number;
    readonly offset: number;
  },
): Promise<MovementRow[]> {
  const rows = await tx.execute<MovementRow>(sql`
    select m.id, m.sku_id, s.code as sku_code, m.location_id, m.kind::text as kind,
           m.qty_delta, m.unit_cost_poisha::text as unit_cost_poisha,
           m.ref_type, m.ref_id, m.business_date::text as business_date,
           m.memo, m.created_by, m.created_at
    from inventory.stock_movements m
    join catalog.skus s on s.org_id = m.org_id and s.id = m.sku_id
    join org.locations l on l.org_id = m.org_id and l.id = m.location_id
    where m.org_id = ${orgId}
      and ${filters.scope}
      and ${filters.skuId === undefined ? sql`true` : sql`m.sku_id = ${filters.skuId}::uuid`}
      and ${filters.locationId === undefined ? sql`true` : sql`m.location_id = ${filters.locationId}::uuid`}
      and ${filters.from === undefined ? sql`true` : sql`m.business_date >= ${filters.from}::date`}
      and ${filters.to === undefined ? sql`true` : sql`m.business_date <= ${filters.to}::date`}
    order by m.created_at desc, m.id desc
    limit ${filters.limit} offset ${filters.offset}
  `);
  return [...rows];
}

// --- costing ------------------------------------------------------------------

export interface CostRow extends Record<string, unknown> {
  readonly sku_id: string;
  readonly wac_poisha: string;
  readonly qty_basis: number;
}

/**
 * Take the SKU's cost row, creating it if absent, and **lock it**.
 *
 * `on conflict do update` rather than `do nothing` because the point is the lock:
 * two receipts of the same SKU arriving together would otherwise both read the
 * same basis, each blend its own quantity into it, and the second write would
 * discard the first — the average would be right for one receipt and the stock
 * would be right for both. `do update` takes a row lock, so the second
 * transaction waits and then reads the first one's result.
 */
export async function lockCost(
  tx: Tx,
  orgId: string,
  skuId: string,
): Promise<{ readonly wacPoisha: bigint; readonly qtyBasis: number }> {
  const rows = await tx.execute<CostRow>(sql`
    insert into inventory.sku_costs (org_id, sku_id, wac_poisha, qty_basis)
    values (${orgId}, ${skuId}, 0, 0)
    on conflict (org_id, sku_id) do update set updated_at = now()
    returning sku_id, wac_poisha::text as wac_poisha, qty_basis
  `);
  const row = rows[0];
  if (row === undefined) throw new Error('locking a cost row returned nothing');
  return { wacPoisha: BigInt(row.wac_poisha), qtyBasis: row.qty_basis };
}

export async function writeCost(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly skuId: string;
    readonly wacPoisha: bigint;
    readonly qtyBasis: number;
  },
): Promise<void> {
  await tx.execute(sql`
    update inventory.sku_costs
    set wac_poisha = ${input.wacPoisha.toString()}, qty_basis = ${input.qtyBasis}, updated_at = now()
    where org_id = ${input.orgId} and sku_id = ${input.skuId}
  `);
}

export async function costsFor(
  tx: Tx,
  orgId: string,
  skuIds: readonly string[],
): Promise<CostRow[]> {
  if (skuIds.length === 0) return [];
  const rows = await tx.execute<CostRow>(sql`
    select sku_id, wac_poisha::text as wac_poisha, qty_basis
    from inventory.sku_costs
    where org_id = ${orgId}
      and sku_id in (${sql.join(
        skuIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
  `);
  return [...rows];
}

// --- reservations -------------------------------------------------------------

export interface ReservationRow extends Record<string, unknown> {
  readonly id: string;
  readonly sku_id: string;
  readonly location_id: string;
  readonly qty: number;
  readonly ref_type: string;
  readonly ref_id: string;
  readonly status: string;
}

export async function insertReservation(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly skuId: string;
    readonly locationId: string;
    readonly qty: number;
    readonly refType: string;
    readonly refId: string;
    readonly createdBy: string;
  },
): Promise<string> {
  const rows = await tx.execute<{ id: string }>(sql`
    insert into inventory.reservations
      (org_id, sku_id, location_id, qty, ref_type, ref_id, created_by)
    values (${input.orgId}, ${input.skuId}, ${input.locationId}, ${input.qty},
            ${input.refType}, ${input.refId}, ${input.createdBy})
    returning id
  `);
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('inserting a reservation returned no id');
  return id;
}

export async function activeReservations(
  tx: Tx,
  orgId: string,
  refType: string,
  refId: string,
): Promise<ReservationRow[]> {
  const rows = await tx.execute<ReservationRow>(sql`
    select id, sku_id, location_id, qty, ref_type, ref_id, status::text as status
    from inventory.reservations
    where org_id = ${orgId} and ref_type = ${refType} and ref_id = ${refId} and status = 'active'
    order by created_at
  `);
  return [...rows];
}

export async function settleReservation(
  tx: Tx,
  orgId: string,
  id: string,
  status: 'consumed' | 'released',
): Promise<void> {
  await tx.execute(sql`
    update inventory.reservations
    set status = ${status}::inventory.reservation_status, updated_at = now()
    where org_id = ${orgId} and id = ${id} and status = 'active'
  `);
}

// --- transfers ----------------------------------------------------------------

export interface TransferRow extends Record<string, unknown> {
  readonly id: string;
  readonly from_location_id: string;
  readonly to_location_id: string;
  readonly transit_location_id: string;
  readonly status: string;
  readonly memo: string | null;
  readonly created_by: string;
  readonly received_by: string | null;
}

export async function insertTransfer(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly fromLocationId: string;
    readonly toLocationId: string;
    readonly transitLocationId: string;
    readonly memo: string | null;
    readonly createdBy: string;
  },
): Promise<string> {
  const rows = await tx.execute<{ id: string }>(sql`
    insert into inventory.stock_transfers
      (org_id, from_location_id, to_location_id, transit_location_id, memo, created_by)
    values (${input.orgId}, ${input.fromLocationId}, ${input.toLocationId},
            ${input.transitLocationId}, ${input.memo}, ${input.createdBy})
    returning id
  `);
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('inserting a transfer returned no id');
  return id;
}

export async function insertTransferLine(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly transferId: string;
    readonly skuId: string;
    readonly qty: number;
  },
): Promise<void> {
  await tx.execute(sql`
    insert into inventory.stock_transfer_lines (org_id, transfer_id, sku_id, qty)
    values (${input.orgId}, ${input.transferId}, ${input.skuId}, ${input.qty})
  `);
}

export async function transferById(
  tx: Tx,
  orgId: string,
  id: string,
): Promise<TransferRow | undefined> {
  const rows = await tx.execute<TransferRow>(sql`
    select id, from_location_id, to_location_id, transit_location_id, status::text as status,
           memo, created_by, received_by
    from inventory.stock_transfers
    where org_id = ${orgId} and id = ${id}
  `);
  return rows[0];
}

export async function transferLines(
  tx: Tx,
  orgId: string,
  transferId: string,
): Promise<{ sku_id: string; qty: number }[]> {
  const rows = await tx.execute<{ sku_id: string; qty: number }>(sql`
    select sku_id, qty from inventory.stock_transfer_lines
    where org_id = ${orgId} and transfer_id = ${transferId}
    order by created_at
  `);
  return [...rows];
}

export async function listTransfers(
  tx: Tx,
  orgId: string,
  filters: { readonly scope: SQL; readonly status?: string | undefined },
): Promise<TransferRow[]> {
  const rows = await tx.execute<TransferRow>(sql`
    select t.id, t.from_location_id, t.to_location_id, t.transit_location_id,
           t.status::text as status, t.memo, t.created_by, t.received_by
    from inventory.stock_transfers t
    join org.locations l on l.org_id = t.org_id and l.id = t.from_location_id
    where t.org_id = ${orgId}
      and ${filters.scope}
      and ${filters.status === undefined ? sql`true` : sql`t.status = ${filters.status}::inventory.transfer_status`}
    order by t.dispatched_at desc
    limit 200
  `);
  return [...rows];
}

export async function markTransferReceived(
  tx: Tx,
  orgId: string,
  id: string,
  receivedBy: string,
): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    update inventory.stock_transfers
    set status = 'received', received_at = now(), received_by = ${receivedBy}, updated_at = now()
    where org_id = ${orgId} and id = ${id} and status = 'dispatched'
    returning id
  `);
  return rows.length === 1;
}

// --- count sessions -----------------------------------------------------------

export interface CountSessionRow extends Record<string, unknown> {
  readonly id: string;
  readonly location_id: string;
  readonly branch_id: string | null;
  readonly status: string;
  readonly memo: string | null;
  readonly created_by: string;
}

export async function insertCountSession(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly locationId: string;
    readonly branchId: string | null;
    readonly memo: string | null;
    readonly createdBy: string;
  },
): Promise<string> {
  const rows = await tx.execute<{ id: string }>(sql`
    insert into inventory.count_sessions (org_id, location_id, branch_id, memo, created_by)
    values (${input.orgId}, ${input.locationId}, ${input.branchId}::uuid, ${input.memo},
            ${input.createdBy})
    returning id
  `);
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('inserting a count session returned no id');
  return id;
}

/**
 * Freeze the snapshot: one line per SKU that has a level at this location.
 *
 * `select … insert` in one statement so the snapshot is taken at one instant. Two
 * statements would let a sale land between the read and the write, and the line it
 * created would carry a quantity nobody ever saw on a shelf.
 */
export async function freezeCountLines(
  tx: Tx,
  orgId: string,
  sessionId: string,
  locationId: string,
): Promise<number> {
  const rows = await tx.execute<{ id: string }>(sql`
    insert into inventory.count_lines (org_id, session_id, sku_id, snapshot_qty)
    select ${orgId}, ${sessionId}, sl.sku_id, sl.on_hand
    from inventory.stock_levels sl
    where sl.org_id = ${orgId} and sl.location_id = ${locationId}
    returning id
  `);
  return rows.length;
}

export async function countSessionById(
  tx: Tx,
  orgId: string,
  id: string,
): Promise<CountSessionRow | undefined> {
  const rows = await tx.execute<CountSessionRow>(sql`
    select id, location_id, branch_id, status::text as status, memo, created_by
    from inventory.count_sessions
    where org_id = ${orgId} and id = ${id}
  `);
  return rows[0];
}

export async function recordCount(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly sessionId: string;
    readonly skuId: string;
    readonly countedQty: number;
    readonly countedBy: string;
  },
): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    update inventory.count_lines
    set counted_qty = ${input.countedQty}, counted_by = ${input.countedBy}, updated_at = now()
    where org_id = ${input.orgId} and session_id = ${input.sessionId} and sku_id = ${input.skuId}
    returning id
  `);
  return rows.length === 1;
}

export interface CountLineRow extends Record<string, unknown> {
  readonly sku_id: string;
  readonly sku_code: string;
  readonly snapshot_qty: number;
  readonly counted_qty: number | null;
  readonly on_hand: number;
}

export async function countLines(
  tx: Tx,
  orgId: string,
  sessionId: string,
): Promise<CountLineRow[]> {
  const rows = await tx.execute<CountLineRow>(sql`
    select cl.sku_id, s.code as sku_code, cl.snapshot_qty, cl.counted_qty,
           coalesce(sl.on_hand, 0) as on_hand
    from inventory.count_lines cl
    join catalog.skus s on s.org_id = cl.org_id and s.id = cl.sku_id
    join inventory.count_sessions cs on cs.org_id = cl.org_id and cs.id = cl.session_id
    left join inventory.stock_levels sl
      on sl.org_id = cl.org_id and sl.sku_id = cl.sku_id and sl.location_id = cs.location_id
    where cl.org_id = ${orgId} and cl.session_id = ${sessionId}
    order by s.code
  `);
  return [...rows];
}

export async function setCountStatus(
  tx: Tx,
  orgId: string,
  id: string,
  status: 'submitted' | 'closed' | 'cancelled',
): Promise<void> {
  await tx.execute(sql`
    update inventory.count_sessions
    set status = ${status}::inventory.count_status,
        closed_at = ${status === 'submitted' ? sql`closed_at` : sql`now()`},
        updated_at = now()
    where org_id = ${orgId} and id = ${id}
  `);
}

export async function listCountSessions(
  tx: Tx,
  orgId: string,
  scope: SQL,
): Promise<CountSessionRow[]> {
  const rows = await tx.execute<CountSessionRow>(sql`
    select id, location_id, branch_id, status::text as status, memo, created_by
    from inventory.count_sessions
    where org_id = ${orgId} and ${scope}
    order by created_at desc
    limit 200
  `);
  return [...rows];
}

// --- adjustments --------------------------------------------------------------

export interface AdjustmentRow extends Record<string, unknown> {
  readonly id: string;
  readonly location_id: string;
  readonly branch_id: string | null;
  readonly direction: string;
  readonly status: string;
  readonly count_session_id: string | null;
  readonly value_poisha: string;
  readonly reason: string;
  readonly approval_request_id: string | null;
  readonly journal_id: string | null;
  readonly business_date: string;
  readonly created_by: string;
}

const ADJUSTMENT_COLUMNS = sql`a.id, a.location_id, a.branch_id, a.direction::text as direction,
  a.status::text as status, a.count_session_id, a.value_poisha::text as value_poisha,
  a.reason, a.approval_request_id, a.journal_id, a.business_date::text as business_date,
  a.created_by`;

export async function insertAdjustment(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly locationId: string;
    readonly branchId: string | null;
    readonly direction: 'loss' | 'gain';
    readonly countSessionId: string | null;
    readonly valuePoisha: bigint;
    readonly reason: string;
    readonly approvalRequestId: string;
    readonly businessDate: string;
    readonly createdBy: string;
  },
): Promise<string> {
  const rows = await tx.execute<{ id: string }>(sql`
    insert into inventory.adjustments
      (org_id, location_id, branch_id, direction, status, count_session_id, value_poisha,
       reason, approval_request_id, business_date, created_by)
    values (${input.orgId}, ${input.locationId}, ${input.branchId}::uuid,
            ${input.direction}::inventory.adjustment_direction, 'pending_approval',
            ${input.countSessionId}::uuid, ${input.valuePoisha.toString()},
            ${input.reason}, ${input.approvalRequestId}, ${input.businessDate}::date,
            ${input.createdBy})
    returning id
  `);
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('inserting an adjustment returned no id');
  return id;
}

export async function insertAdjustmentLine(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly adjustmentId: string;
    readonly skuId: string;
    readonly qty: number;
    readonly unitCostPoisha: bigint;
  },
): Promise<void> {
  await tx.execute(sql`
    insert into inventory.adjustment_lines (org_id, adjustment_id, sku_id, qty, unit_cost_poisha)
    values (${input.orgId}, ${input.adjustmentId}, ${input.skuId}, ${input.qty},
            ${input.unitCostPoisha.toString()})
  `);
}

export async function adjustmentById(
  tx: Tx,
  orgId: string,
  id: string,
  lock = false,
): Promise<AdjustmentRow | undefined> {
  const rows = await tx.execute<AdjustmentRow>(sql`
    select ${ADJUSTMENT_COLUMNS}
    from inventory.adjustments a
    where a.org_id = ${orgId} and a.id = ${id}
    ${lock ? sql`for update` : sql``}
  `);
  return rows[0];
}

export async function adjustmentByApproval(
  tx: Tx,
  orgId: string,
  approvalRequestId: string,
): Promise<AdjustmentRow | undefined> {
  const rows = await tx.execute<AdjustmentRow>(sql`
    select ${ADJUSTMENT_COLUMNS}
    from inventory.adjustments a
    where a.org_id = ${orgId} and a.approval_request_id = ${approvalRequestId}
    for update
  `);
  return rows[0];
}

export async function adjustmentLines(
  tx: Tx,
  orgId: string,
  adjustmentId: string,
): Promise<{ sku_id: string; qty: number; unit_cost_poisha: string }[]> {
  const rows = await tx.execute<{ sku_id: string; qty: number; unit_cost_poisha: string }>(sql`
    select sku_id, qty, unit_cost_poisha::text as unit_cost_poisha
    from inventory.adjustment_lines
    where org_id = ${orgId} and adjustment_id = ${adjustmentId}
    order by created_at
  `);
  return [...rows];
}

export async function settleAdjustment(
  tx: Tx,
  orgId: string,
  id: string,
  outcome: { readonly status: 'posted' | 'rejected'; readonly journalId: string | null },
): Promise<void> {
  await tx.execute(sql`
    update inventory.adjustments
    set status = ${outcome.status}::inventory.adjustment_status,
        journal_id = ${outcome.journalId}::uuid,
        updated_at = now()
    where org_id = ${orgId} and id = ${id} and status = 'pending_approval'
  `);
}

export async function listAdjustments(
  tx: Tx,
  orgId: string,
  filters: { readonly scope: SQL; readonly status?: string | undefined },
): Promise<AdjustmentRow[]> {
  const rows = await tx.execute<AdjustmentRow>(sql`
    select ${ADJUSTMENT_COLUMNS}
    from inventory.adjustments a
    where a.org_id = ${orgId}
      and ${filters.scope}
      and ${filters.status === undefined ? sql`true` : sql`a.status = ${filters.status}::inventory.adjustment_status`}
    order by a.created_at desc
    limit 200
  `);
  return [...rows];
}

// --- reconciliation -----------------------------------------------------------

export interface DriftRow extends Record<string, unknown> {
  readonly sku_id: string;
  readonly location_id: string;
  readonly level_on_hand: number;
  readonly movement_sum: number;
}

/**
 * Levels that disagree with Σ movements, computed entirely in the database.
 *
 * A `full outer join` rather than a left join: drift is symmetric, and the
 * direction the left join would miss is the dangerous one — movements with no
 * level row at all, which is what a failed level write looks like. A left join
 * from levels would report that as "no drift" because the row it needed to compare
 * does not exist.
 */
export async function findLevelDrift(tx: Tx, orgId: string): Promise<DriftRow[]> {
  const rows = await tx.execute<DriftRow>(sql`
    with sums as (
      select sku_id, location_id, sum(qty_delta)::int as movement_sum
      from inventory.stock_movements
      where org_id = ${orgId}
      group by sku_id, location_id
    ),
    levels as (
      select sku_id, location_id, on_hand
      from inventory.stock_levels
      where org_id = ${orgId}
    )
    select coalesce(l.sku_id, s.sku_id) as sku_id,
           coalesce(l.location_id, s.location_id) as location_id,
           coalesce(l.on_hand, 0) as level_on_hand,
           coalesce(s.movement_sum, 0) as movement_sum
    from levels l
    full outer join sums s on s.sku_id = l.sku_id and s.location_id = l.location_id
    where coalesce(l.on_hand, 0) <> coalesce(s.movement_sum, 0)
    order by 1, 2
  `);
  return [...rows];
}

export interface CostDriftRow extends Record<string, unknown> {
  readonly sku_id: string;
  readonly qty_basis: number;
  readonly level_total: number;
}

/**
 * Cost rows whose basis no longer matches the org-wide on-hand.
 *
 * A drifted basis does not look wrong anywhere — every screen shows the same
 * average it always did — and then the *next* receipt blends against the wrong
 * denominator and the error compounds. This is the only place it becomes visible.
 */
export async function findCostDrift(tx: Tx, orgId: string): Promise<CostDriftRow[]> {
  const rows = await tx.execute<CostDriftRow>(sql`
    select c.sku_id, c.qty_basis,
           coalesce((select sum(sl.on_hand)::int from inventory.stock_levels sl
                     where sl.org_id = c.org_id and sl.sku_id = c.sku_id), 0) as level_total
    from inventory.sku_costs c
    where c.org_id = ${orgId}
      and c.qty_basis <> coalesce((select sum(sl.on_hand)::int from inventory.stock_levels sl
                                   where sl.org_id = c.org_id and sl.sku_id = c.sku_id), 0)
    order by c.sku_id
  `);
  return [...rows];
}

export async function countLevels(tx: Tx, orgId: string): Promise<number> {
  const rows = await tx.execute<{ total: string }>(sql`
    select count(*)::text as total from inventory.stock_levels where org_id = ${orgId}
  `);
  return Number(rows[0]?.total ?? '0');
}

export async function insertReconciliation(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly businessDate: string;
    readonly levelsChecked: number;
    readonly driftCount: number;
    readonly costDriftCount: number;
    readonly details: unknown;
  },
): Promise<string> {
  const rows = await tx.execute<{ id: string }>(sql`
    insert into inventory.reconciliations
      (org_id, business_date, levels_checked, drift_count, cost_drift_count, details)
    values (${input.orgId}, ${input.businessDate}::date, ${input.levelsChecked},
            ${input.driftCount}, ${input.costDriftCount},
            ${JSON.stringify(input.details)}::jsonb)
    returning id
  `);
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('inserting a reconciliation returned no id');
  return id;
}

export async function latestReconciliations(
  tx: Tx,
  orgId: string,
  limit: number,
): Promise<
  {
    id: string;
    business_date: string;
    levels_checked: number;
    drift_count: number;
    cost_drift_count: number;
    details: unknown;
    ran_at: Date;
  }[]
> {
  const rows = await tx.execute<{
    id: string;
    business_date: string;
    levels_checked: number;
    drift_count: number;
    cost_drift_count: number;
    details: unknown;
    ran_at: Date;
  }>(sql`
    select id, business_date::text as business_date, levels_checked, drift_count,
           cost_drift_count, details, ran_at
    from inventory.reconciliations
    where org_id = ${orgId}
    order by ran_at desc
    limit ${limit}
  `);
  return [...rows];
}

// --- catalog and ledger lookups this module needs ----------------------------

/**
 * A ledger account by subtype, for the four accounts the posting rules need.
 *
 * Read directly rather than through `LEDGER_API`, the same documented exception
 * M08 takes (D-121): the ledger's service interface posts journals, and resolving
 * "which account is this org's inventory account" is a read of the chart of
 * accounts that every posting module needs. Adding a lookup method to `LedgerApi`
 * for each subtype would be a wider interface for no more safety — this is SELECT
 * on one table, scoped by org like everything else.
 */
export async function accountBySubtype(
  tx: Tx,
  orgId: string,
  subtype: string,
): Promise<{ id: string; code: string; subtype: string; branch_id: string | null } | undefined> {
  const rows = await tx.execute<{
    id: string;
    code: string;
    subtype: string;
    branch_id: string | null;
  }>(sql`
    select id, code, subtype::text as subtype, branch_id
    from ledger.accounts
    where org_id = ${orgId} and subtype = ${subtype}::ledger.account_subtype and is_active
    order by code
    limit 1
  `);
  return rows[0];
}

export async function skuExists(tx: Tx, orgId: string, skuId: string): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    select id from catalog.skus where org_id = ${orgId} and id = ${skuId}
  `);
  return rows.length === 1;
}

export async function skuCodes(
  tx: Tx,
  orgId: string,
  skuIds: readonly string[],
): Promise<Map<string, string>> {
  if (skuIds.length === 0) return new Map();
  const rows = await tx.execute<{ id: string; code: string }>(sql`
    select id, code from catalog.skus
    where org_id = ${orgId}
      and id in (${sql.join(
        skuIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
  `);
  return new Map(rows.map((row) => [row.id, row.code]));
}
