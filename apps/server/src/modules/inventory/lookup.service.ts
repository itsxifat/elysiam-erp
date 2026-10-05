import { Inject, Injectable } from '@nestjs/common';
import { canReadCost, defineAbilityFor } from '@elysium/contracts';
import { withOrg } from '@elysium/db';
import { normaliseScannedCode } from '@elysium/domain';

import type { ActiveContext } from '../../platform/http/context.js';
import { CATALOG_API, type CatalogApi } from '../catalog/catalog.api.js';
import { mapStockErrors, StockError } from './inventory.errors.js';
import * as repo from './inventory.repository.js';
import * as stock from './stock-in-hand.repository.js';

/**
 * What a scanned code is (M38a, D-605): `GET /v1/catalog/lookup?code=`.
 *
 * The console's scanner sends whatever the scanner typed; this answers with the product,
 * the variant in words, its selling price and, for a caller who may read stock, where its
 * pieces are. Served from the inventory module, which already reaches the catalog through
 * `CatalogApi`, because the answer needs both and the catalog may not depend on inventory
 * (the modules would import each other). The path stays under `/v1/catalog`: it is a
 * catalog question with a stock footnote.
 *
 * No cost unless the caller holds `read:cost` (invariant 5): then the weighted average is
 * included as `wacPoisha`, which `serializeFor` strips again for anybody else.
 */
@Injectable()
export class LookupService {
  constructor(@Inject(CATALOG_API) private readonly catalog: CatalogApi) {}

  async lookup(context: ActiveContext, rawCode: string) {
    const code = normaliseScannedCode(rawCode);
    const ability = defineAbilityFor(context);
    const withStock = ability.can('read', 'Stock');
    const withCost = canReadCost(context.roles, context.isSuperAdmin);

    return mapStockErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const found = await this.catalog.lookupCode(tx, context.orgId, code);
        if (found === undefined) {
          throw new StockError('STOCK_NOT_FOUND', 'No product in this brand has that code.');
        }

        const levels = withStock ? await stock.stockOfSku(tx, context.orgId, found.skuId) : [];
        const wac = withCost
          ? (await repo.costsFor(tx, context.orgId, [found.skuId]))[0]?.wac_poisha
          : undefined;

        return {
          code,
          product: {
            id: found.productId,
            name: found.productName,
            status: found.productStatus,
          },
          sku: {
            id: found.skuId,
            code: found.skuCode,
            barcode: found.barcode,
            status: found.skuStatus,
            variantLabel: found.variantLabel,
            pricePoisha: found.pricePoisha,
          },
          stock: withStock
            ? {
                onHand: levels.reduce((sum, level) => sum + level.on_hand, 0),
                available: levels.reduce((sum, level) => sum + level.on_hand - level.reserved, 0),
                locations: levels.map((level) => ({
                  locationId: level.location_id,
                  locationCode: level.location_code,
                  locationName: level.location_name,
                  onHand: level.on_hand,
                  available: level.on_hand - level.reserved,
                })),
              }
            : null,
          ...(withCost ? { wacPoisha: wac === undefined ? null : String(wac) } : {}),
        };
      }),
    );
  }
}
