import { Module } from '@nestjs/common';

import { AuditService } from '../../platform/audit/audit.service.js';
import { CatalogModule } from '../catalog/catalog.module.js';
import { FilesModule } from '../files/files.module.js';
import { FlashController } from './flash.controller.js';
import { FlashService } from './flash.service.js';
import { PromoCatalogReferences } from './catalog-references.binding.js';
import { BuyerHistoryRegistry } from './ports/buyer-history.port.js';
import { DiscountReferences } from './ports/discount-references.port.js';
import { PROMO_API, PromoApiService } from './promo.api.js';
import { PromoController } from './promo.controller.js';
import { PromoDeletesController } from './promo-deletes.controller.js';
import { PromoDeletesService } from './promo-deletes.service.js';
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
  imports: [CatalogModule, FilesModule],
  // M39a: deleting, archiving and restoring discounts and flash sales (D-631).
  controllers: [PromoController, FlashController, PromoDeletesController],
  // `AuditService` is provided rather than imported, as every other module does it.
  providers: [
    AuditService,
    BuyerHistoryRegistry,
    // M39a: what promotions hold about catalog rows (D-621); who else names a discount.
    PromoCatalogReferences,
    DiscountReferences,
    PromoDeletesService,
    PromoService,
    FlashService,
    { provide: PROMO_API, useClass: PromoApiService },
    PromoApiService,
  ],
  exports: [PROMO_API, PromoApiService, PromoService, BuyerHistoryRegistry, DiscountReferences],
})
export class PromoModule {}
