import { Module } from '@nestjs/common';

import { AuditService } from '../../platform/audit/audit.service.js';
import { CatalogModule } from '../catalog/catalog.module.js';
import { PROMO_API, PromoApiService } from './promo.api.js';
import { PromoController } from './promo.controller.js';
import { PromoService } from './promo.service.js';

/**
 * Promo codes (architecture §10; M16).
 *
 * `PROMO_API` and `PromoApiService` are the seam, as the fraud module does it: a module
 * that needs a code priced injects the token and knows nothing else about this one. The
 * POS declares its own `PROMO_CODES` port and is bound to the same instance in
 * `pos.module.ts`, which is what replaces M23's refusing `NoPromoCodes` default (D-196).
 */
@Module({
  imports: [CatalogModule],
  controllers: [PromoController],
  // `AuditService` is provided rather than imported, as every other module does it.
  providers: [
    AuditService,
    PromoService,
    { provide: PROMO_API, useClass: PromoApiService },
    PromoApiService,
  ],
  exports: [PROMO_API, PromoApiService, PromoService],
})
export class PromoModule {}
