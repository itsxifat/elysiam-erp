import type { Tx } from '@elysium/db';
import { sql } from 'drizzle-orm';

import { USAGE_EXAMPLES } from '../../platform/references/references.js';

/**
 * What the ncom.bd connector holds about a SKU or a stock location, counted for a delete
 * (M35b joined to M39a at integration; D-553, D-621, D-629).
 *
 * A hold names the place its units were held at (`location_id`, a foreign key) and the SKUs
 * it held (`lines[].skuId`, JSON with no key). Every hold counts, ended ones too: a released
 * or converted hold is the record of what ncom held and what became of it, and keeps both.
 * The examples are ncom's own references, never a shopper.
 */

export async function holdsForSkus(
  tx: Tx,
  orgId: string,
  skuIds: readonly string[],
): Promise<{ count: number; examples: { id: string; label: string }[] }> {
  // Containment rather than `jsonb_array_elements`: a `lines` value that is not an array
  // matches nothing instead of raising for every SKU or product delete in the brand.
  const rows = await tx.execute<{ id: string; label: string; total: number }>(sql`
    select h.id, h.order_ref as label, count(*) over ()::int as total
    from marketplace.ncom_holds h
    where h.org_id = ${orgId}
      and exists (
        select 1 from unnest(${sql.param(skuIds.map(String))}::text[]) as wanted(sku_id)
        where h.lines @> jsonb_build_array(jsonb_build_object('skuId', wanted.sku_id))
      )
    order by h.held_at desc
    limit ${USAGE_EXAMPLES}
  `);
  return {
    count: rows[0]?.total ?? 0,
    examples: rows.map((row) => ({ id: row.id, label: row.label })),
  };
}

export async function holdsAtLocation(
  tx: Tx,
  orgId: string,
  locationId: string,
): Promise<{ count: number; examples: { id: string; label: string }[] }> {
  const rows = await tx.execute<{ id: string; label: string; total: number }>(sql`
    select h.id, h.order_ref as label, count(*) over ()::int as total
    from marketplace.ncom_holds h
    where h.org_id = ${orgId} and h.location_id = ${locationId}
    order by h.held_at desc
    limit ${USAGE_EXAMPLES}
  `);
  return {
    count: rows[0]?.total ?? 0,
    examples: rows.map((row) => ({ id: row.id, label: row.label })),
  };
}
