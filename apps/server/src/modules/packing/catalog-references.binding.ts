import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { Tx } from '@elysium/db';

import type { ReferenceUse } from '../../platform/references/references.js';
import {
  CatalogReferences,
  type CatalogRefKind,
  type CatalogReferenceChecker,
} from '../catalog/ports/catalog-references.port.js';
import { scansForSkus } from './station.repository.js';

/**
 * Packing's answer to "what uses this SKU?" (M38b audit, D-621): a packing scan names the SKU
 * that went into the box (or was refused at the table), and that record keeps the SKU.
 */
@Injectable()
export class PackingCatalogReferences implements CatalogReferenceChecker, OnModuleInit {
  readonly module = 'packing';

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
    return [{ reason: 'packing_scans', count: await scansForSkus(tx, orgId, ids) }];
  }
}
