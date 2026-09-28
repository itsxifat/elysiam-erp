import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';

import { RequireAbility } from '../../platform/auth/abilities.js';
import { requireContext } from '../../platform/http/context.js';
import { CatalogService } from './catalog.service.js';
import { mapCatalogErrors } from './catalog.errors.js';
import { CatalogImportService } from './import.service.js';
import { LabelsService } from './labels.service.js';
import {
  attachImageSchema,
  catalogIdSchema,
  createAttributeSchema,
  createAttributeValueSchema,
  createCategorySchema,
  createProductSchema,
  extendMatrixSchema,
  labelSheetSchema,
  priceImportSchema,
  productQuerySchema,
  reorderImagesSchema,
  setBarcodeSchema,
  setPricesSchema,
  skuQuerySchema,
  updateCategorySchema,
  updateProductSchema,
} from './catalog.schemas.js';

function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message);
  return parsed.data;
}

/**
 * The catalog over HTTP (architecture §6, §8, §23).
 *
 * Every route declares an ability, and the split is §6's catalog row exactly:
 * **`read Catalog`** for everybody who works in the brand — sales, accounts,
 * marketing, branch managers, the warehouse, and a reseller through the
 * allow-list — and **`create` / `update` / `delete Catalog`** for org_admin
 * alone. A picker needs to find a SKU; nobody but an admin sets a price.
 *
 * The subject also decides what leaves: `SerializeInterceptor` reads this route's
 * own `@RequireAbility` and runs `serializeFor()` against it, so a reseller
 * receives only §6's allow-listed fields and everyone receives no cost field —
 * of which there are none in this module to begin with (invariant 5).
 *
 * `read Catalog` is `org` scope for every role that holds it, so no handler here
 * narrows by row. The scope is still attached by the guard, and the interceptor
 * lets an `all`-kind filter through untouched; the day a role gets `branch`
 * catalog visibility, `ScopeInterceptor` will refuse these responses until
 * somebody maps the columns, which is the failure mode the mandatory scope exists
 * for (D-061).
 */
@Controller('v1/catalog')
export class CatalogController {
  constructor(
    private readonly catalog: CatalogService,
    private readonly imports: CatalogImportService,
    private readonly labels: LabelsService,
  ) {}

  // --- categories -----------------------------------------------------------

  @RequireAbility('read', 'Catalog')
  @Get('categories')
  async categories(@Req() request: FastifyRequest) {
    return mapCatalogErrors(() => this.catalog.listCategories(requireContext(request)));
  }

  @RequireAbility('create', 'Catalog')
  @Post('categories')
  async createCategory(@Req() request: FastifyRequest, @Body() body: unknown) {
    const input = parse(createCategorySchema, body);
    return mapCatalogErrors(() => this.catalog.createCategory(requireContext(request), input));
  }

  @RequireAbility('update', 'Catalog')
  @Patch('categories/:id')
  async updateCategory(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const categoryId = parse(catalogIdSchema, id);
    const input = parse(updateCategorySchema, body);
    return mapCatalogErrors(() =>
      this.catalog.updateCategory(requireContext(request), categoryId, input),
    );
  }

  // --- attributes -----------------------------------------------------------

  @RequireAbility('read', 'Catalog')
  @Get('attributes')
  async attributes(@Req() request: FastifyRequest) {
    return mapCatalogErrors(() => this.catalog.listAttributes(requireContext(request)));
  }

  @RequireAbility('create', 'Catalog')
  @Post('attributes')
  async createAttribute(@Req() request: FastifyRequest, @Body() body: unknown) {
    const input = parse(createAttributeSchema, body);
    return mapCatalogErrors(() => this.catalog.createAttribute(requireContext(request), input));
  }

  @RequireAbility('create', 'Catalog')
  @Post('attributes/:id/values')
  async createAttributeValue(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const attributeId = parse(catalogIdSchema, id);
    const input = parse(createAttributeValueSchema, body);
    return mapCatalogErrors(() =>
      this.catalog.createAttributeValue(requireContext(request), attributeId, input),
    );
  }

  // --- products -------------------------------------------------------------

  /** The product list: pg_trgm search, category and status filters, keyset page. */
  @RequireAbility('read', 'Catalog')
  @Get('products')
  async products(@Req() request: FastifyRequest, @Query() query: unknown) {
    const parsed = parse(productQuerySchema, query);
    return mapCatalogErrors(() => this.catalog.listProducts(requireContext(request), parsed));
  }

  @RequireAbility('read', 'Catalog')
  @Get('products/:id')
  async productDetail(@Req() request: FastifyRequest, @Param('id') id: string) {
    const productId = parse(catalogIdSchema, id);
    return mapCatalogErrors(() => this.catalog.product(requireContext(request), productId));
  }

  @RequireAbility('create', 'Catalog')
  @Post('products')
  async createProduct(@Req() request: FastifyRequest, @Body() body: unknown) {
    const input = parse(createProductSchema, body);
    return mapCatalogErrors(() => this.catalog.createProduct(requireContext(request), input));
  }

  @RequireAbility('update', 'Catalog')
  @Patch('products/:id')
  async updateProduct(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const productId = parse(catalogIdSchema, id);
    const input = parse(updateProductSchema, body);
    return mapCatalogErrors(() =>
      this.catalog.updateProduct(requireContext(request), productId, input),
    );
  }

  /**
   * Extend the variant matrix.
   *
   * `POST .../variants`, not `PUT .../variants`, and the verb is the design: this
   * adds the combinations that do not exist yet. There is no route that replaces a
   * product's matrix, because the SKUs it would drop have stock movements, order
   * lines and printed labels behind them (M06 check 1).
   */
  @RequireAbility('update', 'Catalog')
  @Post('products/:id/variants')
  async extendVariants(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const productId = parse(catalogIdSchema, id);
    const input = parse(extendMatrixSchema, body);
    return mapCatalogErrors(() =>
      this.catalog.extendMatrix(requireContext(request), productId, input),
    );
  }

  // --- SKUs, prices and barcodes -------------------------------------------

  @RequireAbility('read', 'Catalog')
  @Get('skus')
  async skus(@Req() request: FastifyRequest, @Query() query: unknown) {
    const parsed = parse(skuQuerySchema, query);
    return mapCatalogErrors(() => this.catalog.searchSkus(requireContext(request), parsed));
  }

  /** Bulk price edit. All or nothing, with a history row per change (0026). */
  @RequireAbility('update', 'Catalog')
  @Put('prices')
  async setPrices(@Req() request: FastifyRequest, @Body() body: unknown) {
    const input = parse(setPricesSchema, body);
    return mapCatalogErrors(() => this.catalog.setPrices(requireContext(request), input));
  }

  @RequireAbility('read', 'Catalog')
  @Get('skus/:id/price-history')
  async priceHistory(@Req() request: FastifyRequest, @Param('id') id: string) {
    const skuId = parse(catalogIdSchema, id);
    return mapCatalogErrors(() => this.catalog.priceHistory(requireContext(request), skuId));
  }

  @RequireAbility('update', 'Catalog')
  @Put('skus/:id/barcode')
  async setBarcode(@Req() request: FastifyRequest, @Param('id') id: string, @Body() body: unknown) {
    const skuId = parse(catalogIdSchema, id);
    const input = parse(setBarcodeSchema, body);
    return mapCatalogErrors(() => this.catalog.setBarcode(requireContext(request), skuId, input));
  }

  // --- images ---------------------------------------------------------------

  @RequireAbility('update', 'Catalog')
  @Post('products/:id/images')
  async attachImage(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const productId = parse(catalogIdSchema, id);
    const input = parse(attachImageSchema, body);
    return mapCatalogErrors(() =>
      this.catalog.attachImage(requireContext(request), productId, input),
    );
  }

  @RequireAbility('update', 'Catalog')
  @Put('products/:id/images/order')
  async reorderImages(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const productId = parse(catalogIdSchema, id);
    const input = parse(reorderImagesSchema, body);
    return mapCatalogErrors(() =>
      this.catalog.reorderImages(requireContext(request), productId, input),
    );
  }

  @RequireAbility('update', 'Catalog')
  @Delete('products/:id/images/:imageId')
  async detachImage(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Param('imageId') imageId: string,
  ) {
    const productId = parse(catalogIdSchema, id);
    const image = parse(catalogIdSchema, imageId);
    return mapCatalogErrors(() =>
      this.catalog.detachImage(requireContext(request), productId, image),
    );
  }

  // --- CSV import -----------------------------------------------------------

  /**
   * Step one: report, change nothing.
   *
   * A POST although it writes nothing, because the file is the request body and a
   * few hundred kilobytes of CSV does not belong in a query string. `read` rather
   * than `update`, so somebody without write access can check a file before
   * handing it to an admin — and because a dry run that needed write access would
   * be indistinguishable from the commit to anybody auditing the route list.
   */
  @RequireAbility('read', 'Catalog')
  @Post('imports/prices/dry-run')
  async dryRunImport(@Req() request: FastifyRequest, @Body() body: unknown) {
    const input = parse(priceImportSchema, body);
    return mapCatalogErrors(() => this.imports.dryRun(requireContext(request), input));
  }

  /** Step two: apply the whole file, or none of it (M06 check 4). */
  @RequireAbility('update', 'Catalog')
  @Post('imports/prices')
  async commitImport(@Req() request: FastifyRequest, @Body() body: unknown) {
    const input = parse(priceImportSchema, body);
    return mapCatalogErrors(() => this.imports.commit(requireContext(request), input));
  }

  // --- labels ---------------------------------------------------------------

  /**
   * The barcode label sheet, as a PDF.
   *
   * `@Res({ passthrough: false })` and a manual send, because this is the one
   * route in the module that does not return JSON. That also means
   * `SerializeInterceptor` never sees it — which is safe here and worth saying out
   * loud: the bytes are a rendered page, and the only catalog fields that reach the
   * renderer are the SKU code, the product name, the barcode and (on request) the
   * selling price. No cost reaches the template because `skusByIds` does not
   * select one.
   */
  @RequireAbility('read', 'Catalog')
  @Post('labels')
  async labelSheet(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
    @Res() reply: FastifyReply,
  ) {
    const input = parse(labelSheetSchema, body);
    const pdf = await mapCatalogErrors(() => this.labels.sheetPdf(requireContext(request), input));
    await reply
      .header('content-type', 'application/pdf')
      .header('content-disposition', 'inline; filename="labels.pdf"')
      .send(Buffer.from(pdf));
  }
}
