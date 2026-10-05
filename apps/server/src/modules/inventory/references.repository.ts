import type { Tx } from '@elysium/db';
import { sql } from 'drizzle-orm';

/**
 * What inventory holds about a SKU or a location, counted for a delete (M39a, D-621).
 *
 * Inventory's own tables only. Every row here is history or stock (invariant 3), so every
 * count keeps the SKU or location; the one exception is an empty stock level (a reorder
 * level set on a SKU that never moved), which is not counted: it leaves by the cascade 0118
 * declared, guarded by 0119's trigger.
 */

export interface StockUses {
  readonly movements: number;
  readonly onHandPlaces: number;
  readonly reservedPlaces: number;
  readonly documents: number;
}

/** Movements, places holding or reserving stock, and stock documents naming any of the SKUs. */
export async function skuStockUses(
  tx: Tx,
  orgId: string,
  skuIds: readonly string[],
): Promise<StockUses> {
  const ids = sql`(${sql.param([...skuIds])}::uuid[])`;
  const rows = await tx.execute<{
    movements: number;
    on_hand: number;
    reserved: number;
    documents: number;
  }>(sql`
    select
      (select count(*)::int from inventory.stock_movements
        where org_id = ${orgId} and sku_id = any ${ids}) as movements,
      (select count(*)::int from inventory.stock_levels
        where org_id = ${orgId} and sku_id = any ${ids} and on_hand > 0) as on_hand,
      (select count(*)::int from inventory.stock_levels
        where org_id = ${orgId} and sku_id = any ${ids} and reserved > 0) as reserved,
      (select count(*)::int from inventory.sku_costs
         where org_id = ${orgId} and sku_id = any ${ids})
      + (select count(*)::int from inventory.reservations
         where org_id = ${orgId} and sku_id = any ${ids})
      + (select count(*)::int from inventory.stock_transfer_lines
         where org_id = ${orgId} and sku_id = any ${ids})
      + (select count(*)::int from inventory.count_lines
         where org_id = ${orgId} and sku_id = any ${ids})
      + (select count(*)::int from inventory.adjustment_lines
         where org_id = ${orgId} and sku_id = any ${ids})
      + (select count(*)::int from inventory.stock_in_hand_lines
         where org_id = ${orgId} and sku_id = any ${ids})
      + (select count(*)::int from inventory.count_scans
         where org_id = ${orgId} and sku_id = any ${ids}) as documents
  `);
  const row = rows[0];
  return {
    movements: row?.movements ?? 0,
    onHandPlaces: row?.on_hand ?? 0,
    reservedPlaces: row?.reserved ?? 0,
    documents: row?.documents ?? 0,
  };
}

/** Movements, held stock and stock documents at one location. */
export async function locationStockUses(
  tx: Tx,
  orgId: string,
  locationId: string,
): Promise<StockUses> {
  const rows = await tx.execute<{
    movements: number;
    on_hand: number;
    reserved: number;
    documents: number;
  }>(sql`
    select
      (select count(*)::int from inventory.stock_movements
        where org_id = ${orgId} and location_id = ${locationId}) as movements,
      (select count(*)::int from inventory.stock_levels
        where org_id = ${orgId} and location_id = ${locationId} and on_hand > 0) as on_hand,
      (select count(*)::int from inventory.stock_levels
        where org_id = ${orgId} and location_id = ${locationId} and reserved > 0) as reserved,
      (select count(*)::int from inventory.reservations
         where org_id = ${orgId} and location_id = ${locationId})
      + (select count(*)::int from inventory.stock_transfers
         where org_id = ${orgId}
           and (from_location_id = ${locationId} or to_location_id = ${locationId}
                or transit_location_id = ${locationId}))
      + (select count(*)::int from inventory.count_sessions
         where org_id = ${orgId} and location_id = ${locationId})
      + (select count(*)::int from inventory.adjustments
         where org_id = ${orgId} and location_id = ${locationId})
      + (select count(*)::int from inventory.stock_in_hand_entries
         where org_id = ${orgId} and location_id = ${locationId}) as documents
  `);
  const row = rows[0];
  return {
    movements: row?.movements ?? 0,
    onHandPlaces: row?.on_hand ?? 0,
    reservedPlaces: row?.reserved ?? 0,
    documents: row?.documents ?? 0,
  };
}

/** A location row, locked for a delete or an archive, with what its audit row keeps. */
export interface LocationImage extends Record<string, unknown> {
  readonly id: string;
  readonly branch_id: string | null;
  readonly code: string;
  readonly name: string;
  readonly kind: string;
  readonly is_active: boolean;
}

export async function lockLocationImage(
  tx: Tx,
  orgId: string,
  id: string,
  lock = true,
): Promise<LocationImage | undefined> {
  const rows = await tx.execute<LocationImage>(sql`
    select id, branch_id, code, name, kind::text as kind, is_active
    from org.locations where org_id = ${orgId} and id = ${id}
    ${lock ? sql`for update` : sql``}
  `);
  return rows[0];
}

export async function deleteLocation(tx: Tx, orgId: string, id: string): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    delete from org.locations where org_id = ${orgId} and id = ${id} returning id
  `);
  return rows.length === 1;
}

/** Places at a branch's locations that still hold or reserve stock (D-633). */
export async function stockAtBranch(tx: Tx, orgId: string, branchId: string): Promise<number> {
  const rows = await tx.execute<{ n: number }>(sql`
    select count(*)::int as n
    from inventory.stock_levels s
    join org.locations l on l.org_id = s.org_id and l.id = s.location_id
    where s.org_id = ${orgId} and l.branch_id = ${branchId} and (s.on_hand > 0 or s.reserved > 0)
  `);
  return rows[0]?.n ?? 0;
}
