import { Module, type Provider } from '@nestjs/common';

import { AuditService } from '../../platform/audit/audit.service.js';
import { CatalogModule } from '../catalog/catalog.module.js';
import { OrdersModule } from '../orders/orders.module.js';
import { PromoModule } from '../promo/promo.module.js';
import {
  MARKETING_CONFIG,
  marketingConfig,
  metaGatewayFor,
  type MarketingConfig,
} from './marketing.config.js';
import { MARKETING_API, MarketingApiService } from './marketing.api.js';
import { MarketingController } from './marketing.controller.js';
import { MarketingService } from './marketing.service.js';
import { MetaJobsService } from './meta-jobs.service.js';
import { META_GATEWAY } from './providers/meta-gateway.js';
import { CampaignDeletesController } from './campaign-deletes.controller.js';
import { CampaignDeletesService } from './campaign-deletes.service.js';

/**
 * Marketing (architecture §11; M18): campaigns, spend, attribution, the dashboard, leads,
 * the Meta spend import and the Conversions API sender.
 *
 * Reads orders only through `ORDERS_API`, promo campaigns through `PROMO_API` and
 * products through `CATALOG_API` (invariant 12). Hears of deliveries through the orders
 * module's `DeliveryObserverRegistry`, which `MetaJobsService` joins at init (D-262), so
 * the arrow points one way: marketing → orders.
 *
 * The config and the gateway are factories, run at `app.init()`: naming the unverified
 * Graph adapters without also opting in stops the process at boot (D-257).
 */
const configProvider: Provider = {
  provide: MARKETING_CONFIG,
  useFactory: () => marketingConfig(),
};

const gatewayProvider: Provider = {
  provide: META_GATEWAY,
  useFactory: (config: MarketingConfig) => metaGatewayFor(config),
  inject: [MARKETING_CONFIG],
};

@Module({
  imports: [OrdersModule, PromoModule, CatalogModule],
  // M39a: deleting a campaign nothing used (D-632).
  controllers: [MarketingController, CampaignDeletesController],
  providers: [
    configProvider,
    gatewayProvider,
    AuditService,
    MarketingService,
    // M39a: marketing's answer to the catalog's references, and campaign deletes (D-621).
    CampaignDeletesService,
    MetaJobsService,
    // M24: per-campaign, per-day inputs for the analytics rollup.
    { provide: MARKETING_API, useClass: MarketingApiService },
  ],
  exports: [MetaJobsService, META_GATEWAY, MARKETING_API],
})
export class MarketingModule {}
