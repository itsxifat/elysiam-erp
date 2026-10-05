import { Module } from '@nestjs/common';

import { FilesModule } from '../files/files.module.js';
import { CATALOG_API, CatalogApiService } from './catalog.api.js';
import { CatalogController } from './catalog.controller.js';
import { CatalogService } from './catalog.service.js';
import { CatalogVariantsController } from './catalog-variants.controller.js';
import { CatalogVariantsService } from './catalog-variants.service.js';
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
 */
@Module({
  imports: [FilesModule],
  // M39b: duplicate, product-wide price history, photo colours, weights, bulk changes.
  controllers: [CatalogController, CatalogVariantsController],
  providers: [
    CatalogService,
    CatalogVariantsService,
    CatalogImportService,
    ProductImportService,
    LabelsService,
    { provide: CATALOG_API, useClass: CatalogApiService },
  ],
  exports: [CATALOG_API],
})
export class CatalogModule {}
