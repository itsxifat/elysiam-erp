import { Module } from '@nestjs/common';

import { AuditService } from '../../platform/audit/audit.service.js';
import { FilesModule } from '../files/files.module.js';
import { CATALOG_API, CatalogApiService } from './catalog.api.js';
import { CatalogController } from './catalog.controller.js';
import { CatalogDeletesController } from './catalog-deletes.controller.js';
import { CatalogDeletesService } from './catalog-deletes.service.js';
import { CatalogService } from './catalog.service.js';
import { CatalogReferences } from './ports/catalog-references.port.js';
import { CatalogImportService } from './import.service.js';
import { LabelsService } from './labels.service.js';
import { ProductImportService } from './product-import.service.js';

/**
 * The catalog (architecture §8, M06).
 *
 * Imports `FilesModule` for two things it owns: the `files.objects` rows a product
 * image points at, and the `GotenbergClient` the barcode label sheet renders
 * through. Nothing else — in particular not the ledger, because the catalog holds
 * no money that moves, only the selling price a later module posts with.
 *
 * Other modules reach this one through `CATALOG_API` and never through the
 * `catalog` schema's tables (invariant 12).
 *
 * M39a: `CatalogReferences` is exported for the modules that point at catalog rows to
 * register what they hold (D-621), the way the promo module exports `BuyerHistoryRegistry`.
 * The catalog asks it before deleting anything; it cannot import those modules back.
 */
@Module({
  imports: [FilesModule],
  controllers: [CatalogController, CatalogDeletesController],
  providers: [
    // Provided rather than imported, as every other module does it.
    AuditService,
    CatalogService,
    CatalogDeletesService,
    CatalogReferences,
    CatalogImportService,
    ProductImportService,
    LabelsService,
    { provide: CATALOG_API, useClass: CatalogApiService },
  ],
  exports: [CATALOG_API, CatalogReferences],
})
export class CatalogModule {}
