import { Module } from '@nestjs/common';

import { AuditService } from '../../platform/audit/audit.service.js';
import { CatalogModule } from '../catalog/catalog.module.js';
import { FilesModule } from '../files/files.module.js';
import { IamDirectoryModule } from '../iam/iam.api.js';
import { OrdersModule } from '../orders/orders.module.js';
import { StorefrontModule } from '../storefront/storefront.module.js';
import { CameraSettingsService } from './camera-settings.service.js';
import { PackingCatalogReferences } from './catalog-references.binding.js';
import { OrderLabelsService } from './order-labels.service.js';
import { PACKING_API, PackingApiService } from './packing.api.js';
import { PackingController } from './packing.controller.js';
import {
  ScannerAppController,
  ScannerController,
  ScannerDeviceGuard,
} from './scanner.controller.js';
import { ScannerService } from './scanner.service.js';
import { PackStationController } from './station.controller.js';
import { PackStationService } from './station.service.js';
import { PackingVideoService } from './video.service.js';

/**
 * Packing (M35b, D-554, D-555): the scanner phones and the console's Scan page, and the order
 * label sheet. Owns the `packing` schema; reads orders, the catalog, the website's settings
 * and the brand's people only through their interfaces (invariant 12). M38b adds the packing
 * station (scan each piece against the order, D-610) and the packing video (D-611 to D-615);
 * M38c the IP cameras over the packing tables (D-668 to D-676), whose recordings the camera
 * process (`main.camera.ts`) cuts.
 */
@Module({
  imports: [OrdersModule, CatalogModule, StorefrontModule, FilesModule, IamDirectoryModule],
  controllers: [ScannerController, ScannerAppController, PackingController, PackStationController],
  providers: [
    AuditService,
    ScannerService,
    ScannerDeviceGuard,
    OrderLabelsService,
    PackStationService,
    PackingVideoService,
    // M38c: the packing tables' IP cameras (D-668).
    CameraSettingsService,
    // A packing scan keeps the SKU it names (D-621).
    PackingCatalogReferences,
    { provide: PACKING_API, useClass: PackingApiService },
  ],
  exports: [PACKING_API, PackingVideoService],
})
export class PackingModule {}
