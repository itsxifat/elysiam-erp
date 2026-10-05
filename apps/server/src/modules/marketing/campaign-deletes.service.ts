import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import type { UsageEntry, UsageReport } from '@elysium/contracts';
import { withOrg, type Tx } from '@elysium/db';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { describeUses, mergeUses } from '../../platform/references/references.js';
import { CatalogReferences } from '../catalog/ports/catalog-references.port.js';
import { PROMO_API, type PromoApi } from '../promo/promo.api.js';
import { MarketingError, mapMarketingErrors } from './marketing.errors.js';
import * as refs from './references.repository.js';
import { ORDERS_API, type OrdersApi } from '../orders/orders.api.js';

/**
 * Marketing's part in deleting things (M39a, D-621, D-632).
 *
 * - **Its answer to the catalog.** A lead keeps the SKU it asked about; a live campaign
 *   keeps the products it promotes (archive the campaign first).
 * - **Deleting a campaign** nobody spent on, no lead came from, no discount was made for and
 *   no order's source names (by its id or a ref): one created by mistake. Its refs (a Meta id, a `utm_campaign`) go with it. Anything else
 *   keeps it, archived, which the campaigns screen already does.
 */
@Injectable()
export class CampaignDeletesService implements OnModuleInit {
  constructor(
    private readonly catalog: CatalogReferences,
    @Inject(PROMO_API) private readonly promo: PromoApi,
    @Inject(ORDERS_API) private readonly orders: OrdersApi,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    this.catalog.register({
      module: 'marketing',
      references: async (tx, orgId, kind, ids) => {
        if (kind === 'sku')
          return [{ reason: 'leads', count: await refs.leadsForSkus(tx, orgId, ids) }];
        if (kind === 'product') {
          return [{ reason: 'campaigns', ...(await refs.campaignsForProducts(tx, orgId, ids)) }];
        }
        return [];
      },
    });
  }

  async usage(context: ActiveContext, id: string): Promise<UsageReport> {
    return mapMarketingErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const campaign = await refs.lockCampaign(tx, context.orgId, id, false);
        if (campaign === undefined) throw notFound();
        const uses = await this.uses(tx, context.orgId, id);
        const archived = campaign.status === 'archived';
        return {
          kind: 'ad_campaign',
          id,
          label: campaign.name,
          archived,
          canDelete: uses.length === 0,
          canEmptyAndDelete: false,
          canArchive: !archived,
          uses,
        };
      }),
    );
  }

  async delete(context: ActiveContext, request: AuditableRequest, id: string) {
    return mapMarketingErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const campaign = await refs.lockCampaign(tx, context.orgId, id);
        if (campaign === undefined) throw notFound();
        const uses = await this.uses(tx, context.orgId, id);
        if (uses.length > 0) {
          throw new MarketingError(
            'MARKETING_IN_USE',
            `${campaign.name} has ${describeUses(uses)}. Archive it instead; its figures stay.`,
          );
        }
        const campaignRefs = await refs.campaignRefsImage(tx, context.orgId, id);
        if (!(await refs.deleteCampaign(tx, context.orgId, id))) throw notFound();
        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'delete',
          action: 'marketing.campaign.deleted',
          entityType: 'Campaign',
          entityId: id,
          before: { ...campaign, refs: campaignRefs },
          after: null,
          requestId: context.requestId,
          request,
        });
        return { id, deleted: true };
      }),
    );
  }

  private async uses(tx: Tx, orgId: string, id: string): Promise<UsageEntry[]> {
    const own = await refs.campaignUses(tx, orgId, id);
    const discounts = await this.promo.discountsForCampaign(tx, orgId, id);
    const attributed = await this.orders.ordersAttributedTo(
      tx,
      orgId,
      id,
      await refs.campaignRefValues(tx, orgId, id),
    );
    return mergeUses([
      { reason: 'ad_spend', count: own.spend },
      { reason: 'leads', count: own.leads },
      { reason: 'orders', count: attributed },
      { reason: 'discounts', count: discounts.count, examples: [...discounts.examples] },
    ]);
  }
}

function notFound(): MarketingError {
  return new MarketingError('MARKETING_CAMPAIGN_NOT_FOUND', 'No such campaign.');
}
