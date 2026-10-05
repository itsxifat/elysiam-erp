import type { Tx } from '@elysium/db';
import { sql } from 'drizzle-orm';

/**
 * What orders hold about a SKU, a location or a discount, counted for a delete (M39a,
 * D-621, D-629, D-631). Counts only: an order is a buyer's, and a usage report names no
 * buyer and no order number to a screen that manages the catalog.
 */

export async function orderLinesForSkus(
  tx: Tx,
  orgId: string,
  skuIds: readonly string[],
): Promise<number> {
  const rows = await tx.execute<{ n: number }>(sql`
    select count(*)::int as n from sales.order_lines
    where org_id = ${orgId} and sku_id = any (${sql.param([...skuIds])}::uuid[])
  `);
  return rows[0]?.n ?? 0;
}

export async function ordersAtLocation(tx: Tx, orgId: string, locationId: string): Promise<number> {
  const rows = await tx.execute<{ n: number }>(sql`
    select count(*)::int as n from sales.orders where org_id = ${orgId} and location_id = ${locationId}
  `);
  return rows[0]?.n ?? 0;
}

/** Orders that name the discount, and occasion greetings that issued it. */
export async function ordersNamingDiscount(tx: Tx, orgId: string, codeId: string): Promise<number> {
  const rows = await tx.execute<{ n: number }>(sql`
    select
      (select count(*)::int from sales.orders where org_id = ${orgId} and promo_code_id = ${codeId})
      + (select count(*)::int from sales.occasion_issues
          where org_id = ${orgId} and promo_code_id = ${codeId}) as n
  `);
  return rows[0]?.n ?? 0;
}
