import { Module } from '@nestjs/common';

import { AuditService } from '../../platform/audit/audit.service.js';
import { CatalogModule } from '../catalog/catalog.module.js';
import { FilesModule } from '../files/files.module.js';
import { IamDirectoryModule } from '../iam/iam.api.js';
import { OrdersModule } from '../orders/orders.module.js';
import { StorefrontModule } from '../storefront/storefront.module.js';
import { OrderLabelsService } from './order-labels.service.js';
import { PACKING_API, PackingApiService } from './packing.api.js';
import { PackingController } from './packing.controller.js';
import {
  ScannerAppController,
  ScannerController,
  ScannerDeviceGuard,
} from './scanner.controller.js';
import { ScannerService } from './scanner.service.js';

/**
 * Packing (M35b, D-554, D-555): the scanner phones and the console's Scan page, and the order
 * label sheet. Owns the `packing` schema; reads orders, the catalog, the website's settings
 * and the brand's people only through their interfaces (invariant 12). M38b's scan-to-pack
 * builds here.
 */
@Module({
  imports: [OrdersModule, CatalogModule, StorefrontModule, FilesModule, IamDirectoryModule],
  controllers: [ScannerController, ScannerAppController, PackingController],
  providers: [
    AuditService,
    ScannerService,
    ScannerDeviceGuard,
    OrderLabelsService,
    { provide: PACKING_API, useClass: PackingApiService },
  ],
  exports: [PACKING_API],
})
export class PackingModule {}
