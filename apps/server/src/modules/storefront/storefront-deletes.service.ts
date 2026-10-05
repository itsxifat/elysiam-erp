import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { EmptySizeChartInput, UsageReport } from '@elysium/contracts';
import { withOrg } from '@elysium/db';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { CATALOG_API, type CatalogApi } from '../catalog/catalog.api.js';
import * as refs from './references.repository.js';
import * as repo from './storefront.repository.js';
import { SiteCache } from './site-cache.js';
import { StorefrontError } from './storefront.errors.js';

/**
 * What the website's own deletes need beyond a plain DELETE (M39a, D-622, D-628).
 *
 * - **Size charts.** The products a chart is on are named (with links) before anything is
 *   deleted, and "Empty and delete" gives them another chart, or none, and then deletes the
 *   chart, in one transaction. The products are the catalog's, so the move goes through
 *   `CatalogApi` (invariant 12).
 * - **The menu.** Deleting a dropdown takes its items with it (0103's cascade); the console
 *   asks how many first and says the number in its confirmation.
 *
 * Every delete writes the deleted row, and every row the database removed with it, into the
 * audit log inside the same transaction: after a hard delete nothing else holds them.
 */
@Injectable()
export class StorefrontDeletesService {
  constructor(
    @Inject(CATALOG_API) private readonly catalog: CatalogApi,
    private readonly cache: SiteCache,
    private readonly audit: AuditService,
  ) {}

  async sizeChartUsage(context: ActiveContext, id: string): Promise<UsageReport> {
    return withOrg(context, async (tx) => {
      const chart = await refs.lockSizeChart(tx, context.orgId, id, 'none');
      if (chart === undefined) throw notFound('size chart');
      const products = await this.catalog.sizeChartProducts(tx, context.orgId, id);
      const uses =
        products.count === 0
          ? []
          : [
              {
                reason: 'products' as const,
                count: products.count,
                examples: [...products.examples],
                movable: true,
              },
            ];
      return {
        kind: 'size_chart',
        id,
        label: chart.name,
        archived: false,
        canDelete: uses.length === 0,
        canEmptyAndDelete: uses.length > 0,
        canArchive: false,
        uses,
      };
    });
  }

  /** Give the chart's products another chart (or none), then delete the chart (D-628). */
  async emptyAndDeleteSizeChart(
    context: ActiveContext,
    request: AuditableRequest,
    id: string,
    input: EmptySizeChartInput,
  ) {
    const result = await withOrg(context, async (tx) => {
      const replacement = input.replacementId;
      // Both charts in id order, so two opposite empties queue instead of deadlocking.
      if (replacement !== null && replacement < id) {
        await refs.lockSizeChart(tx, context.orgId, replacement, 'share');
      }
      const chart = await refs.lockSizeChart(tx, context.orgId, id);
      if (chart === undefined) throw notFound('size chart');
      if (replacement !== null) {
        if (replacement === id) {
          throw new StorefrontError(
            'STOREFRONT_INVALID',
            HttpStatus.BAD_REQUEST,
            'Choose a different chart for the products, or none.',
          );
        }
        if ((await refs.lockSizeChart(tx, context.orgId, replacement, 'share')) === undefined) {
          throw notFound('size chart');
        }
      }
      const moved = await this.catalog.reassignSizeChart(tx, context.orgId, id, replacement);
      // One row per product given another chart, for each product's own history (D-622).
      for (const productId of moved) {
        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'update',
          action: 'catalog.product.size_chart_moved',
          entityType: 'Product',
          entityId: productId,
          before: { sizeChartId: id },
          after: { sizeChartId: replacement, because: `${chart.name} was emptied and deleted` },
          requestId: context.requestId,
        });
      }
      await refs.forgetLegacyIds(tx, context.orgId, 'size_chart', [id]);
      if (!(await repo.deleteSizeChart(tx, context.orgId, id))) throw notFound('size chart');
      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: 'delete',
        action: 'storefront.size_chart.emptied_and_deleted',
        entityType: 'SizeChart',
        entityId: id,
        before: { ...chart },
        after: { replacementId: replacement, movedProductIds: moved },
        requestId: context.requestId,
        request,
      });
      return { id, deleted: true, movedProducts: moved.length };
    });
    this.cache.forget(context.orgId);
    return result;
  }

  /** A menu item and how many items go with it (a dropdown's), before it is deleted. */
  async navItemUsage(context: ActiveContext, id: string) {
    return withOrg(context, async (tx) => {
      const { item, children } = await refs.navItemWithChildren(tx, context.orgId, id);
      if (item === undefined) throw notFound('menu item');
      return {
        id,
        kind: item.kind,
        label: item.label,
        children: children.length,
        childLabels: children.slice(0, 5).map((child) => child.label ?? ''),
      };
    });
  }
}

function notFound(what: string): StorefrontError {
  return new StorefrontError(
    'STOREFRONT_NOT_FOUND',
    HttpStatus.NOT_FOUND,
    `No such ${what} on this brand's website.`,
  );
}
