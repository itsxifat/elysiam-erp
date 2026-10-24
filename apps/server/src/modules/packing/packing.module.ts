import { Module } from '@nestjs/common';

import { AuditService } from '../../platform/audit/audit.service.js';
import { CatalogModule } from '../catalog/catalog.module.js';
import { FilesModule } from '../files/files.module.js';
import { IamDirectoryModule } from '../iam/iam.api.js';
import { OrdersModule } from '../orders/orders.module.js';
import { StorefrontModule } from '../storefront/storefront.module.js';
import { InventoryModule } from '../inventory/inventory.module.js';
import { TeamModule } from '../team/team.module.js';
import { CameraSettingsService } from './camera-settings.service.js';
import { LabelsController } from './labels.controller.js';
import { LotsController } from './lots.controller.js';
import { LotsService } from './lots.service.js';
import { PackingLocationReferences } from './location-references.binding.js';
import { PackingCatalogReferences } from './catalog-references.binding.js';
import { OrderLabelsService } from './order-labels.service.js';
import { PACKING_API, PackingApiService } from './packing.api.js';
import { PackingController } from './packing.controller.js';
import { NetworkPrinterTransport, PRINTER_TRANSPORT } from './printers/transport.js';
import { PrintersService } from './printers.service.js';
import { PrintingService } from './printing.service.js';
import {
  ScannerAppController,
  ScannerController,
  ScannerDeviceGuard,
} from './scanner.controller.js';
import { ScannerService } from './scanner.service.js';
import { PackStationController } from './station.controller.js';
import { PackStationService } from './station.service.js';
import { PackingVideoService } from './video.service.js';
import { TerminalsController } from './terminals.controller.js';
import { TerminalsService } from './terminals.service.js';

/**
 * Packing (M35b, D-554, D-555): the scanner phones and the console's Scan page, and the order
 * label sheet. Owns the `packing` schema; reads orders, the catalog, the website's settings
 * and the brand's people only through their interfaces (invariant 12). M38b adds the packing
 * station (scan each piece against the order, D-610) and the packing video (D-611 to D-615);
 * M38c the IP cameras over the packing tables (D-668 to D-676), whose recordings the camera
 * process (`main.camera.ts`) cuts.
 */
@Module({
  // M46: the team's presence, for who is working at each terminal (D-803).
  imports: [
    OrdersModule,
    CatalogModule,
    // D-621: a terminal's stock location is counted when the location is deleted.
    InventoryModule,
    StorefrontModule,
    FilesModule,
    IamDirectoryModule,
    TeamModule,
  ],
  controllers: [
    ScannerController,
    ScannerAppController,
    PackingController,
    PackStationController,
    // M46: Labels and Packaging (D-800 to D-826).
    TerminalsController,
    LabelsController,
    LotsController,
  ],
  providers: [
    AuditService,
    PackingLocationReferences,
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
    // M46: terminals, printers, the print queue, lots and the handover (D-800 to D-826).
    TerminalsService,
    PrintersService,
    PrintingService,
    LotsService,
    { provide: PRINTER_TRANSPORT, useClass: NetworkPrinterTransport },
  ],
  exports: [PACKING_API, PackingVideoService, PrintingService],
})
export class PackingModule {}
