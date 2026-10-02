import { Inject, Injectable } from '@nestjs/common';
import type { Tx } from '@elysium/db';
import { addDays, daysBetween, toIsoDate } from '@elysium/domain';
import { aggregateFacts, type MetricInputs } from '@elysium/domain/marketing';

import { ORDERS_API, type OrdersApi } from '../orders/orders.api.js';
import { PROMO_API, type PromoApi } from '../promo/promo.api.js';
import { readAttributedPeriod } from './attribution.reader.js';
import * as repo from './marketing.repository.js';

/**
 * Marketing's service interface for other modules (invariant 12; M24).
 *
 * One read, for the analytics rollup (`analytics.daily_campaign`, `daily_org.spend_poisha`):
 * §11's inputs per campaign per Asia/Dhaka day, attributed exactly as the marketing
 * dashboard attributes them (D-250), because both go through `readAttributedPeriod`. No
 * names, no leads, no Meta link: a campaign is its id here.
 */
export interface CampaignDay {
  readonly businessDate: string;
  /** Null is the orders no campaign claims; it carries no spend. */
  readonly campaignId: string | null;
  readonly inputs: MetricInputs;
}

export interface MarketingApi {
  /**
   * Every (campaign, day) with spend or an order event, `from` to `to` inclusive. A day
   * with neither is absent rather than a row of zeros.
   */
  campaignDays(
    tx: Tx,
    orgId: string,
    range: { readonly from: string; readonly to: string },
  ): Promise<readonly CampaignDay[]>;

  /** The names of these campaigns, for a dashboard's labels. Unknown ids are absent. */
  campaignNames(
    tx: Tx,
    orgId: string,
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, string>>;
}

/** The Nest injection token for `MarketingApi`. */
export const MARKETING_API = Symbol('MarketingApi');

const isEmpty = (inputs: MetricInputs): boolean =>
  BigInt(inputs.spendPoisha) === 0n &&
  inputs.confirmedOrders === 0 &&
  inputs.deliveredOrders === 0 &&
  inputs.returnedOrders === 0 &&
  BigInt(inputs.deliveredRevenuePoisha) === 0n &&
  BigInt(inputs.placedRevenuePoisha) === 0n;

@Injectable()
export class MarketingApiService implements MarketingApi {
  constructor(
    @Inject(ORDERS_API) private readonly orders: OrdersApi,
    @Inject(PROMO_API) private readonly promo: PromoApi,
  ) {}

  async campaignDays(
    tx: Tx,
    orgId: string,
    range: { readonly from: string; readonly to: string },
  ): Promise<readonly CampaignDay[]> {
    const { orders, spend } = await readAttributedPeriod(tx, orgId, range, {
      orders: this.orders,
      promo: this.promo,
    });
    const from = toIsoDate(range.from);
    const days = daysBetween(from, toIsoDate(range.to)) + 1;
    const result: CampaignDay[] = [];
    for (let offset = 0; offset < days; offset += 1) {
      const day = addDays(from, offset);
      const { byCampaign } = aggregateFacts(orders, spend, { from: day, to: day });
      for (const [campaignId, inputs] of byCampaign) {
        if (isEmpty(inputs)) continue;
        result.push({ businessDate: day, campaignId, inputs });
      }
    }
    return result;
  }

  async campaignNames(
    tx: Tx,
    orgId: string,
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, string>> {
    if (ids.length === 0) return new Map();
    const wanted = new Set(ids);
    const rows = await repo.listCampaigns(tx, orgId, undefined);
    return new Map(rows.filter((row) => wanted.has(row.id)).map((row) => [row.id, row.name]));
  }
}
