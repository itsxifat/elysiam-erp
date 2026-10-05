import { Module } from '@nestjs/common';

import { AuditService } from '../../platform/audit/audit.service.js';
import { CatalogModule } from '../catalog/catalog.module.js';
import { InventoryModule } from '../inventory/inventory.module.js';
import { OrdersModule } from '../orders/orders.module.js';
import { StorefrontModule } from '../storefront/storefront.module.js';
import { MarketplaceController } from './marketplace.controller.js';
import { MarketplaceSettingsService } from './marketplace-settings.service.js';
import { NcomAuthService } from './ncom-auth.service.js';
import { NcomConnectorService } from './ncom-connector.service.js';
import { NcomController } from './ncom.controller.js';
import { NcomRawBody } from './ncom.http.js';
import { NcomOrdersService } from './ncom-orders.service.js';
import { NcomTransport } from './ncom.transport.js';

/**
 * The ncom.bd marketplace connector (M35b, architecture §31, D-553, D-556).
 *
 * Owns the `marketplace` schema. Reaches the catalog, the stock, the orders and the website's
 * settings and old ids only through `CATALOG_API`, `INVENTORY_API`, `ORDERS_API` and
 * `STOREFRONT_API` (invariant 12). Every call to ncom is the worker's (`marketplace.ncom_send`).
 */
@Module({
  imports: [CatalogModule, InventoryModule, OrdersModule, StorefrontModule],
  controllers: [NcomController, MarketplaceController],
  providers: [
    AuditService,
    NcomRawBody,
    NcomTransport,
    NcomAuthService,
    NcomConnectorService,
    NcomOrdersService,
    MarketplaceSettingsService,
  ],
  exports: [NcomOrdersService, NcomTransport],
})
export class MarketplaceModule {}
