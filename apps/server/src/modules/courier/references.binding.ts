import { Injectable, type OnModuleInit } from '@nestjs/common';

import { CatalogReferences } from '../catalog/ports/catalog-references.port.js';
import { LocationReferences } from '../inventory/ports/location-references.port.js';
import * as refs from './references.repository.js';

/**
 * The courier module's answers to "what uses this row?" (M39a, D-621, D-629): a return
 * receipt line keeps its SKU, and a return receipt keeps the location it was received into.
 */
@Injectable()
export class CourierReferencesBinding implements OnModuleInit {
  constructor(
    private readonly catalog: CatalogReferences,
    private readonly locations: LocationReferences,
  ) {}

  onModuleInit(): void {
    this.catalog.register({
      module: 'courier',
      references: async (tx, orgId, kind, ids) =>
        kind === 'sku'
          ? [{ reason: 'courier_returns', count: await refs.returnLinesForSkus(tx, orgId, ids) }]
          : [],
    });
    this.locations.register({
      module: 'courier',
      references: async (tx, orgId, _kind, ids) => [
        { reason: 'courier_returns', count: await refs.returnsAtLocation(tx, orgId, ids[0] ?? '') },
      ],
    });
  }
}
