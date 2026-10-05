import type { Tx } from '@elysium/db';
import { sql } from 'drizzle-orm';

/**
 * Standard buying prices (M39b, D-638): `supply.sku_purchase_prices`, per variant and
 * optionally per supplier. Purchase cost (invariant 5): every statement here serves a
 * `read Cost` route, inside the caller's `withOrg()` transaction.
 */

export interface StandardRow extends Record<string, unknown> {
  readonly sku_id: string;
  readonly supplier_id: string | null;
  readonly supplier_code: string | null;
  readonly supplier_name: string | null;
  readonly standard_unit_cost_poisha: string;
  readonly updated_at: Date;
}

/** Every standard price of these SKUs, any supplier first, then by supplier code. */
export async function standardsFor(
  tx: Tx,
  orgId: string,
  skuIds: readonly string[] | null,
): Promise<StandardRow[]> {
  if (skuIds !== null && skuIds.length === 0) return [];
  const rows = await tx.execute<StandardRow>(sql`
    select pp.sku_id, pp.supplier_id, s.code as supplier_code, s.name as supplier_name,
           pp.standard_unit_cost_poisha::text as standard_unit_cost_poisha, pp.updated_at
    from supply.sku_purchase_prices pp
    left join supply.suppliers s on s.org_id = pp.org_id and s.id = pp.supplier_id
    where pp.org_id = ${orgId}
      and ${skuIds === null ? sql`true` : sql`pp.sku_id = any (${sql.param([...skuIds])}::uuid[])`}
    order by pp.sku_id, pp.supplier_id nulls first, s.code
  `);
  return [...rows];
}

/**
 * Set one standard price, or replace it. The conflict target is the unique index's own
 * expression, so "any supplier" (null) has one row like every supplier does.
 */
export async function upsertStandard(
  tx: Tx,
  orgId: string,
  input: {
    readonly skuId: string;
    readonly supplierId: string | null;
    readonly unitCostPoisha: bigint;
    readonly updatedBy: string | null;
  },
): Promise<void> {
  await tx.execute(sql`
    insert into supply.sku_purchase_prices
      (org_id, sku_id, supplier_id, standard_unit_cost_poisha, updated_by)
    values (${orgId}, ${input.skuId}, ${input.supplierId}::uuid,
            ${input.unitCostPoisha.toString()}::bigint, ${input.updatedBy})
    on conflict (org_id, sku_id, (coalesce(supplier_id, '00000000-0000-0000-0000-000000000000'::uuid)))
    do update set standard_unit_cost_poisha = excluded.standard_unit_cost_poisha,
                  updated_by = excluded.updated_by,
                  updated_at = now()
  `);
}

/** Remove one standard price. True when there was one. */
export async function deleteStandard(
  tx: Tx,
  orgId: string,
  skuId: string,
  supplierId: string | null,
): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    delete from supply.sku_purchase_prices
    where org_id = ${orgId} and sku_id = ${skuId}
      and supplier_id is not distinct from ${supplierId}::uuid
    returning id
  `);
  return rows.length > 0;
}

/** These supplier ids of this brand. */
export async function suppliersByIds(
  tx: Tx,
  orgId: string,
  ids: readonly string[],
): Promise<{ id: string; code: string; name: string }[]> {
  if (ids.length === 0) return [];
  const rows = await tx.execute<{ id: string; code: string; name: string }>(sql`
    select id, code, name from supply.suppliers
    where org_id = ${orgId} and id = any (${sql.param([...new Set(ids)])}::uuid[])
  `);
  return [...rows];
}

/** Every supplier's code and id, for the spreadsheet (a brand has tens, not thousands). */
export async function allSupplierCodes(
  tx: Tx,
  orgId: string,
): Promise<{ id: string; code: string }[]> {
  const rows = await tx.execute<{ id: string; code: string }>(sql`
    select id, code from supply.suppliers where org_id = ${orgId}
  `);
  return [...rows];
}

/** The supplier each of these supply entries came from, for "last bought from". */
export async function suppliersOfSupplies(
  tx: Tx,
  orgId: string,
  supplyIds: readonly string[],
): Promise<Map<string, { code: string; name: string }>> {
  if (supplyIds.length === 0) return new Map();
  const rows = await tx.execute<{ id: string; code: string; name: string }>(sql`
    select sp.id, s.code, s.name
    from supply.supplies sp
    join supply.suppliers s on s.org_id = sp.org_id and s.id = sp.supplier_id
    where sp.org_id = ${orgId} and sp.id = any (${sql.param([...new Set(supplyIds)])}::uuid[])
  `);
  return new Map(rows.map((row) => [row.id, { code: row.code, name: row.name }]));
}
