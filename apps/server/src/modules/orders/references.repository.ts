import type { Tx } from '@elysium/db';
import { sql } from 'drizzle-orm';
import type { CampaignMatch } from './orders.api.js';

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

/**
 * Orders whose recorded source names a campaign, compared the way §11's attribution compares
 * them (`resolveAttribution` in `@elysium/domain/marketing`): `campaignId` is the campaign's
 * id or one of its Meta campaign ids, `adId` one of its Meta ad ids, each trimmed, and
 * `utmCampaign` one of its UTM refs, trimmed and lower-cased (the refs are stored lower-cased).
 * Deleting such a campaign would orphan them in past reports (M39a, D-632). An order another
 * rule gives to a different campaign is counted too: keeping a campaign is the safe answer.
 */
export async function ordersAttributedTo(
  tx: Tx,
  orgId: string,
  campaign: CampaignMatch,
): Promise<number> {
  const explicit = [campaign.id, ...campaign.metaCampaignIds];
  const rows = await tx.execute<{ n: number }>(sql`
    select count(*)::int as n from sales.orders
    where org_id = ${orgId}
      and (btrim(source->>'campaignId') = any (${sql.param(explicit)}::text[])
           or btrim(source->>'adId') = any (${sql.param([...campaign.metaAdIds])}::text[])
           or lower(btrim(source->>'utmCampaign'))
              = any (${sql.param([...campaign.utmCampaigns])}::text[]))
  `);
  return rows[0]?.n ?? 0;
}
