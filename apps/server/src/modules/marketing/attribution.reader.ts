import type { Tx } from '@elysium/db';
import { businessDate, poisha, toIsoDate, type IsoDate } from '@elysium/domain';
import {
  ATTRIBUTION_RULES,
  campaignIndex,
  resolveAttribution,
  type AttributionRule,
  type OrderFact,
  type SpendFact,
} from '@elysium/domain/marketing';

import type { OrdersApi } from '../orders/orders.api.js';
import type { PromoApi } from '../promo/promo.api.js';
import * as repo from './marketing.repository.js';

/**
 * One period's orders, attributed, and its spend (architecture §11; D-250).
 *
 * The one place an order's campaign is decided at read time: from its own recorded source,
 * its promo code's campaign and the brand's current mappings, through `resolveAttribution`.
 * The marketing dashboard (M18) and the analytics rollup (M24, through `MarketingApi`)
 * both read it, so the two cannot attribute the same order differently.
 */
export interface AttributedPeriod {
  readonly campaigns: readonly repo.CampaignRow[];
  readonly orders: readonly OrderFact[];
  readonly spend: readonly SpendFact[];
  readonly rules: Readonly<Record<AttributionRule, number>>;
}

function dhaka(instant: Date | null): IsoDate | null {
  return instant === null ? null : businessDate(instant);
}

export async function readAttributedPeriod(
  tx: Tx,
  orgId: string,
  period: { readonly from: string; readonly to: string },
  apis: { readonly orders: OrdersApi; readonly promo: PromoApi },
): Promise<AttributedPeriod> {
  const facts = await apis.orders.marketingFacts(tx, orgId, period);
  const campaigns = await repo.listCampaigns(tx, orgId, undefined);
  const refs = await repo.listRefs(tx, orgId);
  const spendRows = await repo.spendInPeriod(tx, orgId, period);
  const codeIds = [
    ...new Set(facts.flatMap((fact) => (fact.promoCodeId === null ? [] : [fact.promoCodeId]))),
  ];
  const promoCampaigns = await apis.promo.campaignsOfCodes(tx, orgId, codeIds);

  const index = campaignIndex(
    campaigns.map((row) => row.id),
    refs.map((ref) => ({ campaignId: ref.campaign_id, kind: ref.kind, value: ref.value })),
  );
  const rules = Object.fromEntries(ATTRIBUTION_RULES.map((rule) => [rule, 0])) as Record<
    AttributionRule,
    number
  >;
  const orders: OrderFact[] = facts.map((fact) => {
    const attribution = resolveAttribution(
      {
        campaignId: fact.source.campaignId,
        promoCampaignId:
          fact.promoCodeId === null ? null : (promoCampaigns.get(fact.promoCodeId) ?? null),
        adId: fact.source.adId,
        utmCampaign: fact.source.utmCampaign,
      },
      index,
    );
    rules[attribution.rule] += 1;
    return {
      orderId: fact.orderId,
      campaignId: attribution.campaignId,
      confirmedOn: dhaka(fact.confirmedAt),
      deliveredOn: dhaka(fact.deliveredAt),
      returnedOn: dhaka(fact.returnedAt),
      deliveredRevenuePoisha: fact.deliveredRevenuePoisha,
      placedRevenuePoisha: fact.placedRevenuePoisha,
    };
  });
  const spend: SpendFact[] = spendRows.map((row) => ({
    campaignId: row.campaign_id,
    spendOn: toIsoDate(row.spend_date),
    amountPoisha: poisha(row.amount_poisha),
  }));

  return { campaigns, orders, spend, rules };
}
