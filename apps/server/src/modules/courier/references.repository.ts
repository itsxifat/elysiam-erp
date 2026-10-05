import type { Tx } from '@elysium/db';
import { sql } from 'drizzle-orm';

/**
 * What couriers hold about a SKU or a location, counted for a delete (M39a, D-621, D-629).
 *
 * `courier.return_receipt_lines.sku_id` has its foreign key only in migration 0048's SQL, not
 * in the Drizzle schema, which is why the investigation's first list missed it (critic): a
 * received return names the SKU and the place it went back to, and keeps both.
 */

export async function returnLinesForSkus(
  tx: Tx,
  orgId: string,
  skuIds: readonly string[],
): Promise<number> {
  const rows = await tx.execute<{ n: number }>(sql`
    select count(*)::int as n from courier.return_receipt_lines
    where org_id = ${orgId} and sku_id = any (${sql.param([...skuIds])}::uuid[])
  `);
  return rows[0]?.n ?? 0;
}

export async function returnsAtLocation(
  tx: Tx,
  orgId: string,
  locationId: string,
): Promise<number> {
  const rows = await tx.execute<{ n: number }>(sql`
    select count(*)::int as n from courier.return_receipts
    where org_id = ${orgId}
      and (location_id = ${locationId} or damaged_location_id = ${locationId})
  `);
  return rows[0]?.n ?? 0;
}
