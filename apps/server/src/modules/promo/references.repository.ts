import type { Tx } from '@elysium/db';
import { sql } from 'drizzle-orm';

import { USAGE_EXAMPLES } from '../../platform/references/references.js';

/**
 * What promotions hold about a catalog row, a discount or a flash sale (M39a, D-621, D-631).
 *
 * A discount's scope names SKUs, products and categories as ids in its own columns, with no
 * foreign key (a scope is terms, and terms are frozen, D-541). A live discount naming a row
 * keeps that row: the scope is never rewritten. An archived discount is not counted: its
 * scope is history, and an id in it that no longer exists harms nothing.
 */

export interface Counted {
  readonly count: number;
  readonly examples: { id: string; label: string }[];
}

type ScopeColumn = 'sku_ids' | 'product_ids' | 'category_ids';

/** Live (not archived) discounts whose scope names any of the ids. */
export async function discountsNaming(
  tx: Tx,
  orgId: string,
  column: ScopeColumn,
  ids: readonly string[],
): Promise<Counted> {
  const scope =
    column === 'sku_ids'
      ? sql`c.sku_ids`
      : column === 'product_ids'
        ? sql`c.product_ids`
        : sql`c.category_ids`;
  const rows = await tx.execute<{ id: string; label: string; total: number }>(sql`
    select c.id, coalesce(nullif(c.title, ''), c.code, '') as label,
           count(*) over ()::int as total
    from promo.codes c
    where c.org_id = ${orgId} and c.status <> 'archived'
      and ${scope} ?| ${sql.param([...ids])}::text[]
    order by c.created_at desc
    limit ${USAGE_EXAMPLES}
  `);
  return {
    count: rows[0]?.total ?? 0,
    examples: rows.map((row) => ({ id: row.id, label: row.label })),
  };
}

/** Flash sale items (any sale, on or off) for any of the SKUs. */
export async function flashItemsFor(
  tx: Tx,
  orgId: string,
  skuIds: readonly string[],
): Promise<Counted> {
  const rows = await tx.execute<{ id: string; label: string; total: number }>(sql`
    select s.id, s.title as label, count(*) over ()::int as total
    from promo.flash_sale_items i
    join promo.flash_sales s on s.org_id = i.org_id and s.id = i.flash_sale_id
    where i.org_id = ${orgId} and i.sku_id = any (${sql.param([...skuIds])}::uuid[])
    order by s.created_at desc
    limit ${USAGE_EXAMPLES}
  `);
  return {
    count: rows[0]?.total ?? 0,
    examples: rows.map((row) => ({ id: row.id, label: row.label })),
  };
}

// --- a discount ----------------------------------------------------------------------------

export interface CodeImage extends Record<string, unknown> {
  readonly id: string;
  readonly method: string;
  readonly code: string | null;
  readonly title: string;
  readonly kind: string;
  readonly status: string;
  readonly used_count: number;
}

/** The whole row, for the audit's before image. */
export async function lockCode(
  tx: Tx,
  orgId: string,
  id: string,
  lock = true,
): Promise<CodeImage | undefined> {
  const rows = await tx.execute<CodeImage>(sql`
    select c.* from promo.codes c where c.org_id = ${orgId} and c.id = ${id}
    ${lock ? sql`for update` : sql``}
  `);
  return rows[0];
}

export async function redemptionCount(tx: Tx, orgId: string, codeId: string): Promise<number> {
  const rows = await tx.execute<{ n: number }>(sql`
    select count(*)::int as n from promo.redemptions where org_id = ${orgId} and code_id = ${codeId}
  `);
  return rows[0]?.n ?? 0;
}

export async function tiersOfCode(
  tx: Tx,
  orgId: string,
  codeId: string,
): Promise<Record<string, unknown>[]> {
  const rows = await tx.execute<Record<string, unknown>>(sql`
    select position, min_subtotal_poisha::text as min_subtotal_poisha, kind, value_bps,
           value_poisha::text as value_poisha
    from promo.discount_tiers where org_id = ${orgId} and code_id = ${codeId}
    order by position
  `);
  return [...rows];
}

export async function deleteCode(tx: Tx, orgId: string, id: string): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    delete from promo.codes where org_id = ${orgId} and id = ${id} returning id
  `);
  return rows.length === 1;
}

/** Discounts (any status) promoting an ad campaign, for marketing's campaign delete. */
export async function codesForCampaign(
  tx: Tx,
  orgId: string,
  campaignId: string,
): Promise<Counted> {
  const rows = await tx.execute<{ id: string; label: string; total: number }>(sql`
    select c.id, coalesce(nullif(c.title, ''), c.code, '') as label,
           count(*) over ()::int as total
    from promo.codes c
    where c.org_id = ${orgId} and c.campaign_id = ${campaignId}
    order by c.created_at desc
    limit ${USAGE_EXAMPLES}
  `);
  return {
    count: rows[0]?.total ?? 0,
    examples: rows.map((row) => ({ id: row.id, label: row.label })),
  };
}

// --- a flash sale --------------------------------------------------------------------------

export interface SaleImage extends Record<string, unknown> {
  readonly id: string;
  readonly title: string;
  readonly slug: string;
  readonly enabled: boolean;
  readonly archived_at: Date | string | null;
}

export async function lockSale(
  tx: Tx,
  orgId: string,
  id: string,
  lock = true,
): Promise<SaleImage | undefined> {
  const rows = await tx.execute<SaleImage>(sql`
    select s.* from promo.flash_sales s where s.org_id = ${orgId} and s.id = ${id}
    ${lock ? sql`for update` : sql``}
  `);
  return rows[0];
}

/** What the sale sold: claims against its items, and units recorded as sold. */
export async function saleSold(
  tx: Tx,
  orgId: string,
  saleId: string,
): Promise<{ claims: number; unitsSold: number }> {
  const rows = await tx.execute<{ claims: number; units_sold: number }>(sql`
    select
      (select count(*)::int from promo.flash_claims fc
         join promo.flash_sale_items i on i.org_id = fc.org_id and i.id = fc.flash_sale_item_id
        where fc.org_id = ${orgId} and i.flash_sale_id = ${saleId}) as claims,
      (select coalesce(sum(units_sold), 0)::int from promo.flash_sale_items
        where org_id = ${orgId} and flash_sale_id = ${saleId}) as units_sold
  `);
  return { claims: rows[0]?.claims ?? 0, unitsSold: rows[0]?.units_sold ?? 0 };
}

export async function itemsImage(
  tx: Tx,
  orgId: string,
  saleId: string,
): Promise<Record<string, unknown>[]> {
  const rows = await tx.execute<Record<string, unknown>>(sql`
    select sku_id, sale_price_poisha::text as sale_price_poisha, unit_limit, units_sold, enabled
    from promo.flash_sale_items where org_id = ${orgId} and flash_sale_id = ${saleId}
    order by created_at, sku_id
  `);
  return [...rows];
}

export async function deleteSale(tx: Tx, orgId: string, id: string): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    delete from promo.flash_sales where org_id = ${orgId} and id = ${id} returning id
  `);
  return rows.length === 1;
}

/** Archive (switched off, out of the list) or restore (back in the list, still off). */
export async function setSaleArchived(
  tx: Tx,
  orgId: string,
  id: string,
  archived: boolean,
): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    update promo.flash_sales
    set archived_at = ${archived ? sql`now()` : sql`null`},
        enabled = ${archived ? sql`false` : sql`enabled`},
        updated_at = now()
    where org_id = ${orgId} and id = ${id}
    returning id
  `);
  return rows.length === 1;
}
