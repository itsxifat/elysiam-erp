import type { Tx } from '@elysium/db';
import { sql } from 'drizzle-orm';

import { USAGE_EXAMPLES } from '../../platform/references/references.js';
import type { NavItemRow } from './storefront.repository.js';

/**
 * What the website holds about a category, a product, a SKU, a location, a discount or a
 * flash sale, and the size charts and menu it owns, for deletes (M39a, D-621, D-628).
 */

const NAV_COLUMNS = sql`id, parent_id, kind, label, href, category_id, highlighted, is_active,
  position`;

/** Menu entries that open any of these categories. */
export async function menuEntriesFor(
  tx: Tx,
  orgId: string,
  categoryIds: readonly string[],
): Promise<{ count: number; examples: { id: string; label: string }[] }> {
  const rows = await tx.execute<{ id: string; label: string; total: number }>(sql`
    select n.id, coalesce(n.label, p.label, '') as label, count(*) over ()::int as total
    from storefront.nav_items n
    left join storefront.nav_items p on p.org_id = n.org_id and p.id = n.parent_id
    where n.org_id = ${orgId} and n.kind = 'category'
      and n.category_id = any (${sql.param([...categoryIds])}::uuid[])
    order by n.position
    limit ${USAGE_EXAMPLES}
  `);
  return {
    count: rows[0]?.total ?? 0,
    examples: rows.map((row) => ({ id: row.id, label: row.label })),
  };
}

/** A category's menu entries pointed at another category; how many. */
export async function repointMenuEntries(
  tx: Tx,
  orgId: string,
  fromId: string,
  toId: string,
): Promise<number> {
  const rows = await tx.execute<{ id: string }>(sql`
    update storefront.nav_items set category_id = ${toId}::uuid, updated_at = now()
    where org_id = ${orgId} and kind = 'category' and category_id = ${fromId}
    returning id
  `);
  return rows.length;
}

/** A category's menu entries removed; the rows, for the audit (a category entry has no items). */
export async function removeMenuEntries(
  tx: Tx,
  orgId: string,
  categoryId: string,
): Promise<NavItemRow[]> {
  const rows = await tx.execute<NavItemRow>(sql`
    delete from storefront.nav_items
    where org_id = ${orgId} and kind = 'category' and category_id = ${categoryId}
    returning ${NAV_COLUMNS}
  `);
  return [...rows];
}

/** A menu item and the items under it (a dropdown's), for its usage and its audit. */
export async function navItemWithChildren(
  tx: Tx,
  orgId: string,
  id: string,
): Promise<{ item: NavItemRow | undefined; children: NavItemRow[] }> {
  const rows = await tx.execute<NavItemRow>(sql`
    select ${NAV_COLUMNS} from storefront.nav_items
    where org_id = ${orgId} and (id = ${id} or parent_id = ${id})
    order by parent_id nulls first, position
  `);
  return {
    item: rows.find((row) => row.id === id),
    children: rows.filter((row) => row.id !== id),
  };
}

export async function heroSlideImage(
  tx: Tx,
  orgId: string,
  id: string,
): Promise<Record<string, unknown> | undefined> {
  const rows = await tx.execute<Record<string, unknown>>(sql`
    select h.* from storefront.hero_slides h where h.org_id = ${orgId} and h.id = ${id}
  `);
  return rows[0];
}

export async function lockSizeChart(
  tx: Tx,
  orgId: string,
  id: string,
  mode: 'update' | 'share' | 'none' = 'update',
): Promise<(Record<string, unknown> & { id: string; name: string }) | undefined> {
  const rows = await tx.execute<Record<string, unknown> & { id: string; name: string }>(sql`
    select c.id, c.name, c.columns, c.rows from storefront.size_charts c
    where c.org_id = ${orgId} and c.id = ${id}
    ${mode === 'update' ? sql`for update` : mode === 'share' ? sql`for share` : sql``}
  `);
  return rows[0];
}

/** Whether the website sells from this location (it keeps the location). */
export async function webLocationUses(tx: Tx, orgId: string, locationId: string): Promise<number> {
  const rows = await tx.execute<{ n: number }>(sql`
    select count(*)::int as n from storefront.web_locations
    where org_id = ${orgId} and location_id = ${locationId}
  `);
  return rows[0]?.n ?? 0;
}

/** The old site's ids for rows being deleted: nothing points at a deleted row any more. */
export async function forgetLegacyIds(
  tx: Tx,
  orgId: string,
  kind: string,
  erpIds: readonly string[],
): Promise<number> {
  if (erpIds.length === 0) return 0;
  const rows = await tx.execute<{ legacy_id: string }>(sql`
    delete from storefront.legacy_ids
    where org_id = ${orgId} and kind = ${kind}
      and erp_id = any (${sql.param([...erpIds])}::uuid[])
    returning legacy_id
  `);
  return rows.length;
}
