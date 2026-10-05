import type { Tx } from '@elysium/db';
import { sql } from 'drizzle-orm';

import { USAGE_EXAMPLES } from '../../platform/references/references.js';

/**
 * What marketing holds about a SKU, a product or one of its own campaigns, for deletes
 * (M39a, D-621, D-632).
 */

/** Leads that asked about any of the SKUs (a lead is a buyer's interest; it keeps the SKU). */
export async function leadsForSkus(
  tx: Tx,
  orgId: string,
  skuIds: readonly string[],
): Promise<number> {
  const rows = await tx.execute<{ n: number }>(sql`
    select count(*)::int as n from marketing.leads
    where org_id = ${orgId} and sku_id = any (${sql.param([...skuIds])}::uuid[])
  `);
  return rows[0]?.n ?? 0;
}

/** Live (not archived) campaigns promoting any of the products. */
export async function campaignsForProducts(
  tx: Tx,
  orgId: string,
  productIds: readonly string[],
): Promise<{ count: number; examples: { id: string; label: string }[] }> {
  const rows = await tx.execute<{ id: string; label: string; total: number }>(sql`
    select id, name as label, count(*) over ()::int as total
    from marketing.campaigns
    where org_id = ${orgId} and status <> 'archived'
      and product_ids ?| ${sql.param([...productIds])}::text[]
    order by created_at desc
    limit ${USAGE_EXAMPLES}
  `);
  return {
    count: rows[0]?.total ?? 0,
    examples: rows.map((row) => ({ id: row.id, label: row.label })),
  };
}

export interface CampaignImage extends Record<string, unknown> {
  readonly id: string;
  readonly name: string;
  readonly status: string;
}

export async function lockCampaign(
  tx: Tx,
  orgId: string,
  id: string,
  lock = true,
): Promise<CampaignImage | undefined> {
  const rows = await tx.execute<CampaignImage>(sql`
    select c.* from marketing.campaigns c where c.org_id = ${orgId} and c.id = ${id}
    ${lock ? sql`for update` : sql``}
  `);
  return rows[0];
}

/** Spend entries and leads naming the campaign. */
export async function campaignUses(
  tx: Tx,
  orgId: string,
  campaignId: string,
): Promise<{ spend: number; leads: number }> {
  const rows = await tx.execute<{ spend: number; leads: number }>(sql`
    select
      (select count(*)::int from marketing.ad_spend
        where org_id = ${orgId} and campaign_id = ${campaignId}) as spend,
      (select count(*)::int from marketing.leads
        where org_id = ${orgId} and campaign_id = ${campaignId}) as leads
  `);
  return { spend: rows[0]?.spend ?? 0, leads: rows[0]?.leads ?? 0 };
}

export async function campaignRefsImage(
  tx: Tx,
  orgId: string,
  campaignId: string,
): Promise<Record<string, unknown>[]> {
  const rows = await tx.execute<Record<string, unknown>>(sql`
    select r.* from marketing.campaign_refs r
    where r.org_id = ${orgId} and r.campaign_id = ${campaignId}
  `);
  return [...rows];
}

/** The campaign and its refs (a Meta id or a `utm_campaign` mapped to it). */
export async function deleteCampaign(tx: Tx, orgId: string, id: string): Promise<boolean> {
  await tx.execute(sql`
    delete from marketing.campaign_refs where org_id = ${orgId} and campaign_id = ${id}
  `);
  const rows = await tx.execute<{ id: string }>(sql`
    delete from marketing.campaigns where org_id = ${orgId} and id = ${id} returning id
  `);
  return rows.length === 1;
}
