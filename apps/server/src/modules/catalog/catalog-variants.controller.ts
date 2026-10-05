import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { z } from 'zod';

import { RequireAbility } from '../../platform/auth/abilities.js';
import { requireContext } from '../../platform/http/context.js';
import { mapCatalogErrors } from './catalog.errors.js';
import {
  bulkProductsSchema,
  catalogIdSchema,
  duplicateProductSchema,
  imageColourSchema,
  skuWeightSchema,
} from './catalog.schemas.js';
import { CatalogVariantsService } from './catalog-variants.service.js';

function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message);
  return parsed.data;
}

/**
 * M39b's catalog routes (D-636, D-641 to D-645), beside `CatalogController` under the same
 * `/v1/catalog` prefix and the same §6 split: `read Catalog` to read, `create Catalog` to
 * make a product (a duplicate is a new product), `update Catalog` to change one. None of
 * them reads or returns a cost (invariant 5); `SerializeInterceptor` runs `serializeFor()`
 * on every answer all the same.
 */
@Controller('v1/catalog')
export class CatalogVariantsController {
  constructor(private readonly variants: CatalogVariantsService) {}

  /** One price history for every variant of a product (D-636). */
  @RequireAbility('read', 'Catalog')
  @Get('products/:id/price-history')
  async productPriceHistory(@Req() request: FastifyRequest, @Param('id') id: string) {
    const productId = parse(catalogIdSchema, id);
    return mapCatalogErrors(() =>
      this.variants.productPriceHistory(requireContext(request), productId),
    );
  }

  /** A copy of a product with its variants and prices, no stock (D-641). */
  @RequireAbility('create', 'Catalog')
  @Post('products/:id/duplicate')
  async duplicate(@Req() request: FastifyRequest, @Param('id') id: string, @Body() body: unknown) {
    const productId = parse(catalogIdSchema, id);
    const input = parse(duplicateProductSchema, body);
    return mapCatalogErrors(() =>
      this.variants.duplicateProduct(requireContext(request), productId, input),
    );
  }

  /** Archive, restore or re-file many products from the product list (D-642). */
  @RequireAbility('update', 'Catalog')
  @Patch('products')
  async bulkProducts(@Req() request: FastifyRequest, @Body() body: unknown) {
    const input = parse(bulkProductsSchema, body);
    return mapCatalogErrors(() => this.variants.bulkProducts(requireContext(request), input));
  }

  /** Which colour a photo shows, or every colour (D-643). */
  @RequireAbility('update', 'Catalog')
  @Put('products/:id/images/:imageId/colour')
  async imageColour(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Param('imageId') imageId: string,
    @Body() body: unknown,
  ) {
    const productId = parse(catalogIdSchema, id);
    const image = parse(catalogIdSchema, imageId);
    const input = parse(imageColourSchema, body);
    return mapCatalogErrors(() =>
      this.variants.setImageColour(requireContext(request), productId, image, input),
    );
  }

  /** A variant's own weight in grams, for couriers (D-645). */
  @RequireAbility('update', 'Catalog')
  @Put('skus/:id/weight')
  async skuWeight(@Req() request: FastifyRequest, @Param('id') id: string, @Body() body: unknown) {
    const skuId = parse(catalogIdSchema, id);
    const input = parse(skuWeightSchema, body);
    return mapCatalogErrors(() =>
      this.variants.setSkuWeight(requireContext(request), skuId, input),
    );
  }
}
