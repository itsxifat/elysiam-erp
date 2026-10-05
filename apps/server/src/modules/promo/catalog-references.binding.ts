import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { Tx } from '@elysium/db';

import type { ReferenceUse } from '../../platform/references/references.js';
import {
  CatalogReferences,
  type CatalogRefKind,
  type CatalogReferenceChecker,
} from '../catalog/ports/catalog-references.port.js';
import * as refs from './references.repository.js';

/**
 * Promotions' answer to "what uses this catalog row?" (M39a, D-621).
 *
 * A flash sale item names a SKU, sold or not, and claims point at it, so any item keeps the
 * SKU. A live discount's scope names SKUs, products or categories; it keeps them, because a
 * discount's terms are frozen (D-541) and rewriting its scope after redemptions would change
 * what buyers were promised. Archive the discount first, and the row can go.
 */
@Injectable()
export class PromoCatalogReferences implements CatalogReferenceChecker, OnModuleInit {
  readonly module = 'promo';

  constructor(private readonly registry: CatalogReferences) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async references(
    tx: Tx,
    orgId: string,
    kind: CatalogRefKind,
    ids: readonly string[],
  ): Promise<readonly ReferenceUse[]> {
    switch (kind) {
      case 'sku': {
        const [items, discounts] = [
          await refs.flashItemsFor(tx, orgId, ids),
          await refs.discountsNaming(tx, orgId, 'sku_ids', ids),
        ];
        return [
          { reason: 'flash_sale_items', ...items },
          { reason: 'discounts', ...discounts },
        ];
      }
      case 'product':
        return [
          { reason: 'discounts', ...(await refs.discountsNaming(tx, orgId, 'product_ids', ids)) },
        ];
      case 'category':
        return [
          { reason: 'discounts', ...(await refs.discountsNaming(tx, orgId, 'category_ids', ids)) },
        ];
      case 'attribute':
      case 'attribute_value':
        // A discount names SKUs, products and categories, never a size or a colour.
        return [];
    }
  }
}
