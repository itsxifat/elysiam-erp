import { Injectable, type OnModuleInit } from '@nestjs/common';

import { CatalogReferences } from '../catalog/ports/catalog-references.port.js';
import { LocationReferences } from '../inventory/ports/location-references.port.js';
import * as refs from './references.repository.js';

/**
 * The till's answers to "what uses this row?" (M39a, D-621, D-629): a sale or return line
 * keeps its SKU; a register, sale or return keeps its location.
 *
 * A till sells offline from its own copy of the price list, so a sale of a SKU deleted in
 * the meantime would arrive naming nothing. Only a SKU with no stock movement anywhere can be
 * deleted, so no piece of it was ever in a showroom to sell; such a sale is refused as
 * `POS_SALE_INVALID` and stays on the till as failed for the manager to see (D-625).
 */
@Injectable()
export class PosReferencesBinding implements OnModuleInit {
  constructor(
    private readonly catalog: CatalogReferences,
    private readonly locations: LocationReferences,
  ) {}

  onModuleInit(): void {
    this.catalog.register({
      module: 'pos',
      references: async (tx, orgId, kind, ids) =>
        kind === 'sku'
          ? [{ reason: 'pos_lines', count: await refs.tillLinesForSkus(tx, orgId, ids) }]
          : [],
    });
    this.locations.register({
      module: 'pos',
      references: async (tx, orgId, _kind, ids) => {
        const uses = await refs.tillUsesOfLocation(tx, orgId, ids[0] ?? '');
        return [
          { reason: 'pos_registers', count: uses.registers },
          { reason: 'pos_lines', count: uses.documents },
        ];
      },
    });
  }
}
