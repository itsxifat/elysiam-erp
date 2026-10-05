import { Inject, Injectable } from '@nestjs/common';
import { withOrg } from '@elysium/db';
import { z } from 'zod';

import type { ActiveContext } from '../../platform/http/context.js';
import { CATALOG_API, type CatalogApi } from '../catalog/catalog.api.js';
import { mapStockErrors, StockError } from './inventory.errors.js';
import * as repo from './inventory.repository.js';

/** Archive or restore many variants together (M39b, D-639). */
export const skuStatusesSchema = z
  .object({
    skuIds: z
      .array(z.string().uuid('No such record.'))
      .min(1, 'Choose at least one variant.')
      .max(500, 'Change at most 500 variants at a time.'),
    status: z.enum(['active', 'archived']),
  })
  .strict();
export type SkuStatusesInput = z.infer<typeof skuStatusesSchema>;

/**
 * "Stop selling XS in all colours" (M39b, D-639): many variants archived, or restored, in one
 * transaction, from the product page's sizes-and-colours section.
 *
 * Served by the inventory module under the catalog's path, like the scan lookup (D-609),
 * because the guard is a stock question and the catalog may not depend on inventory
 * (inventory already imports the catalog module). **Refused when any of the variants has
 * pieces held for orders** (a confirmed order's reservation or a website checkout's hold):
 * archiving them would leave those orders holding pieces nobody may sell, and an order
 * holding an archived variant cannot have its lines edited (D-423). The stock rows are locked
 * for the check, so a reservation cannot land between the check and the archive. Pieces on
 * hand do not stop it: they stay where they are and can be transferred, counted or written
 * off, as D-423 says. An order still pending (no reservation yet) is the orders module's
 * knowledge; the console warns about it from what it can see, and M39a's reference port is
 * where a firmer check would come from.
 */
@Injectable()
export class SkuStatusService {
  constructor(@Inject(CATALOG_API) private readonly catalog: CatalogApi) {}

  async setStatuses(context: ActiveContext, input: SkuStatusesInput) {
    return mapStockErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const ids = [...new Set(input.skuIds)];
        const skus = await this.catalog.skusForStatusChange(tx, context.orgId, ids);
        if (skus.length !== ids.length) {
          throw new StockError(
            'CATALOG_NOT_FOUND',
            `${String(ids.length - skus.length)} of those variants are not in this brand's catalog. Nothing was changed.`,
          );
        }
        if (input.status === 'archived') {
          const held = await repo.reservedBySku(tx, context.orgId, ids);
          const blocked = skus.filter((sku) => (held.get(sku.id)?.reserved ?? 0) > 0);
          if (blocked.length > 0) {
            throw new StockError(
              'CATALOG_SKU_HELD',
              `Orders hold pieces of ${blocked.map((sku) => sku.code).join(', ')}. Dispatch or cancel those orders first; nothing was archived.`,
            );
          }
        }
        const changed = await this.catalog.setSkuStatuses(tx, context.orgId, ids, input.status);
        return {
          status: input.status,
          changed: changed.map((sku) => ({ id: sku.id, skuCode: sku.code })),
          unchanged: ids.length - changed.length,
        };
      }),
    );
  }
}
