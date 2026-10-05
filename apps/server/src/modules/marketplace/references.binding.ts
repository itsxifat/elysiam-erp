import { Injectable, type OnModuleInit } from '@nestjs/common';

import { CatalogReferences } from '../catalog/ports/catalog-references.port.js';
import { LocationReferences } from '../inventory/ports/location-references.port.js';
import * as refs from './references.repository.js';

/**
 * The ncom.bd connector's answers to "what uses this row?" (M35b joined to M39a at
 * integration; D-553, D-621, D-629): a hold keeps the SKUs it held and the location it held
 * them at. A live hold's units are also an inventory reservation, which inventory counts
 * itself; this counts the hold, live or ended, so the usage names ncom.
 */
@Injectable()
export class MarketplaceReferencesBinding implements OnModuleInit {
  constructor(
    private readonly catalog: CatalogReferences,
    private readonly locations: LocationReferences,
  ) {}

  onModuleInit(): void {
    this.catalog.register({
      module: 'marketplace',
      references: async (tx, orgId, kind, ids) =>
        kind === 'sku'
          ? [{ reason: 'marketplace_holds', ...(await refs.holdsForSkus(tx, orgId, ids)) }]
          : [],
    });
    this.locations.register({
      module: 'marketplace',
      references: async (tx, orgId, _kind, ids) => [
        { reason: 'marketplace_holds', ...(await refs.holdsAtLocation(tx, orgId, ids[0] ?? '')) },
      ],
    });
  }
}
