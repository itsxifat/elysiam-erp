import { Injectable, type OnModuleInit } from '@nestjs/common';

import { CatalogReferences } from '../catalog/ports/catalog-references.port.js';
import { LocationReferences } from '../inventory/ports/location-references.port.js';
import * as refs from './references.repository.js';

/**
 * Supply's answers to "what uses this row?" (M39a, D-621, D-629): a supply or return line
 * keeps its SKU; a supply entry or return keeps its location.
 */
@Injectable()
export class SupplyReferencesBinding implements OnModuleInit {
  constructor(
    private readonly catalog: CatalogReferences,
    private readonly locations: LocationReferences,
  ) {}

  onModuleInit(): void {
    this.catalog.register({
      module: 'supply',
      references: async (tx, orgId, kind, ids) =>
        kind === 'sku'
          ? [{ reason: 'supply_lines', count: await refs.supplyLinesForSkus(tx, orgId, ids) }]
          : [],
    });
    this.locations.register({
      module: 'supply',
      references: async (tx, orgId, _kind, ids) => [
        {
          reason: 'supply_entries',
          count: await refs.supplyEntriesAtLocation(tx, orgId, ids[0] ?? ''),
        },
      ],
    });
  }
}
