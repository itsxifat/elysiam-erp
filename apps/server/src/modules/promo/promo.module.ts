import { Module } from '@nestjs/common';

import { AuditService } from '../../platform/audit/audit.service.js';
import { CatalogModule } from '../catalog/catalog.module.js';
import { FlashController } from './flash.controller.js';
import { FlashService } from './flash.service.js';
import { BuyerHistoryRegistry } from './ports/buyer-history.port.js';
import { PROMO_API, PromoApiService } from './promo.api.js';
import { PromoController } from './promo.controller.js';
import { PromoService } from './promo.service.js';

/**
 * Discounts and flash sales (architecture §10; M16, M35a).
 *
 * `PROMO_API` and `PromoApiService` are the seam: a module
 * that needs a code priced injects the token and knows nothing else about this one. The
 * POS declares its own `PROMO_CODES` port and is bound to the same instance in
 * `pos.module.ts`, which is what replaces M23's refusing `NoPromoCodes` default (D-196).
 *
 * `BuyerHistoryRegistry` is exported for the orders module to hand itself in (D-543): a
 * first-order discount needs the buyer's order history, which only that module may read.
 */
@Module({
  imports: [CatalogModule],
  controllers: [PromoController, FlashController],
  // `AuditService` is provided rather than imported, as every other module does it.
  providers: [
    AuditService,
    BuyerHistoryRegistry,
    PromoService,
    FlashService,
    { provide: PROMO_API, useClass: PromoApiService },
    PromoApiService,
  ],
  exports: [PROMO_API, PromoApiService, PromoService, BuyerHistoryRegistry],
})
export class PromoModule {}
