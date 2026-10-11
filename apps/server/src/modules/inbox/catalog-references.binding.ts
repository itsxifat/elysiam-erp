import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { Tx } from '@elysium/db';

import type { ReferenceUse } from '../../platform/references/references.js';
import {
  CatalogReferences,
  type CatalogRefKind,
  type CatalogReferenceChecker,
} from '../catalog/ports/catalog-references.port.js';
import { interestsFor } from './inbox.repository.js';

/**
 * The inbox's answer to "what uses this product or SKU?" (M42, D-621, D-741): a customer's
 * interest names the product, and sometimes one of its sizes, so it keeps them; such a product
 * is archived, not deleted, and the interest still shows what it was.
 */
@Injectable()
export class InboxCatalogReferences implements CatalogReferenceChecker, OnModuleInit {
  readonly module = 'inbox';

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
    if (kind === 'product') {
      return [
        { reason: 'inbox_interests', count: await interestsFor(tx, orgId, 'product_id', ids) },
      ];
    }
    if (kind === 'sku') {
      return [{ reason: 'inbox_interests', count: await interestsFor(tx, orgId, 'sku_id', ids) }];
    }
    return [];
  }
}
