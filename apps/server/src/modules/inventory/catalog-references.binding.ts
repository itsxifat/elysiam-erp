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
 * Inventory's answer to "what uses this SKU?" (M39a, D-621): its movements, the places that
 * hold or reserve it, and every stock document naming it. Any one keeps the SKU.
 */
@Injectable()
export class InventoryCatalogReferences implements CatalogReferenceChecker, OnModuleInit {
  readonly module = 'inventory';

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
    if (kind !== 'sku') return [];
    return stockReferenceUses(await refs.skuStockUses(tx, orgId, ids));
  }
}

export function stockReferenceUses(uses: refs.StockUses): ReferenceUse[] {
  return [
    { reason: 'stock_movements', count: uses.movements },
    { reason: 'stock_on_hand', count: uses.onHandPlaces },
    { reason: 'stock_reserved', count: uses.reservedPlaces },
    { reason: 'stock_documents', count: uses.documents },
  ];
}
