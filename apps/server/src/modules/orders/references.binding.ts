import { Injectable, type OnModuleInit } from '@nestjs/common';

import { CatalogReferences } from '../catalog/ports/catalog-references.port.js';
import { LocationReferences } from '../inventory/ports/location-references.port.js';
import { DiscountReferences } from '../promo/ports/discount-references.port.js';
import * as refs from './references.repository.js';

/**
 * The orders module's answers to "what uses this row?" (M39a, D-621, D-629, D-631).
 *
 * An order line keeps its SKU, an order keeps the location it ships from and the discount
 * it was given, and an occasion greeting keeps the code it issued. The catalog, inventory and
 * promotions cannot read `sales.*` (invariant 12) and this module imports all three, so it
 * hands itself in to each one's registry when it starts.
 */
@Injectable()
export class OrdersReferencesBinding implements OnModuleInit {
  constructor(
    private readonly catalog: CatalogReferences,
    private readonly locations: LocationReferences,
    private readonly discounts: DiscountReferences,
  ) {}

  onModuleInit(): void {
    this.catalog.register({
      module: 'orders',
      references: async (tx, orgId, kind, ids) =>
        kind === 'sku'
          ? [{ reason: 'order_lines', count: await refs.orderLinesForSkus(tx, orgId, ids) }]
          : [],
    });
    this.locations.register({
      module: 'orders',
      references: async (tx, orgId, _kind, ids) => [
        { reason: 'orders', count: await refs.ordersAtLocation(tx, orgId, ids[0] ?? '') },
      ],
    });
    this.discounts.register({
      module: 'orders',
      references: async (tx, orgId, kind, ids) =>
        kind === 'discount'
          ? [{ reason: 'orders', count: await refs.ordersNamingDiscount(tx, orgId, ids[0] ?? '') }]
          : [],
    });
  }
}
