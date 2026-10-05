import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import { emptyCategorySchema } from '@elysium/contracts';
import type { FastifyRequest } from 'fastify';
import type { z } from 'zod';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { RequireAbility } from '../../platform/auth/abilities.js';
import { requireContext } from '../../platform/http/context.js';
import { mapCatalogErrors } from './catalog.errors.js';
import { catalogIdSchema } from './catalog.schemas.js';
import { CatalogDeletesService } from './catalog-deletes.service.js';
import { archiveValueSchema, reorderValuesSchema } from './catalog-deletes.schemas.js';

function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message);
  return parsed.data;
}

const auditable = (request: FastifyRequest): AuditableRequest =>
  request as unknown as AuditableRequest;

/**
 * Deleting and archiving the catalog's rows over HTTP (M39a, D-621 to D-626).
 *
 * The abilities are §6's catalog row as it stands: `delete Catalog` (org_admin) to delete,
 * `update Catalog` (org_admin) to archive, restore and reorder, and to ask what uses a row —
 * the usage report is part of managing the catalog, not of reading it, so a reseller or a
 * till never sees which orders hold a SKU.
 */
@Controller('v1/catalog')
export class CatalogDeletesController {
  constructor(private readonly deletes: CatalogDeletesService) {}

  // --- categories ----------------------------------------------------------------------------

  @RequireAbility('update', 'Catalog')
  @Get('categories/:id/usage')
  async categoryUsage(@Req() request: FastifyRequest, @Param('id') id: string) {
    const categoryId = parse(catalogIdSchema, id);
    return mapCatalogErrors(() => this.deletes.categoryUsage(requireContext(request), categoryId));
  }

  @RequireAbility('delete', 'Catalog')
  @Delete('categories/:id')
  async deleteCategory(@Req() request: FastifyRequest, @Param('id') id: string) {
    const categoryId = parse(catalogIdSchema, id);
    return mapCatalogErrors(() =>
      this.deletes.deleteCategory(requireContext(request), auditable(request), categoryId),
    );
  }

  @RequireAbility('delete', 'Catalog')
  @Post('categories/:id/empty-and-delete')
  @HttpCode(200)
  async emptyAndDeleteCategory(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const categoryId = parse(catalogIdSchema, id);
    const input = parse(emptyCategorySchema, body);
    return mapCatalogErrors(() =>
      this.deletes.emptyAndDeleteCategory(
        requireContext(request),
        auditable(request),
        categoryId,
        input,
      ),
    );
  }

  @RequireAbility('update', 'Catalog')
  @Post('categories/:id/archive')
  @HttpCode(200)
  async archiveCategory(@Req() request: FastifyRequest, @Param('id') id: string) {
    const categoryId = parse(catalogIdSchema, id);
    return mapCatalogErrors(() =>
      this.deletes.setCategoryArchived(
        requireContext(request),
        auditable(request),
        categoryId,
        true,
      ),
    );
  }

  @RequireAbility('update', 'Catalog')
  @Post('categories/:id/restore')
  @HttpCode(200)
  async restoreCategory(@Req() request: FastifyRequest, @Param('id') id: string) {
    const categoryId = parse(catalogIdSchema, id);
    return mapCatalogErrors(() =>
      this.deletes.setCategoryArchived(
        requireContext(request),
        auditable(request),
        categoryId,
        false,
      ),
    );
  }

  // --- lists ---------------------------------------------------------------------------------

  @RequireAbility('update', 'Catalog')
  @Get('attributes/:id/usage')
  async attributeUsage(@Req() request: FastifyRequest, @Param('id') id: string) {
    const attributeId = parse(catalogIdSchema, id);
    return mapCatalogErrors(() =>
      this.deletes.attributeUsage(requireContext(request), attributeId),
    );
  }

  @RequireAbility('delete', 'Catalog')
  @Delete('attributes/:id')
  async deleteAttribute(@Req() request: FastifyRequest, @Param('id') id: string) {
    const attributeId = parse(catalogIdSchema, id);
    return mapCatalogErrors(() =>
      this.deletes.deleteAttribute(requireContext(request), auditable(request), attributeId),
    );
  }

  @RequireAbility('update', 'Catalog')
  @Post('attributes/:id/archive')
  @HttpCode(200)
  async archiveAttribute(@Req() request: FastifyRequest, @Param('id') id: string) {
    const attributeId = parse(catalogIdSchema, id);
    return mapCatalogErrors(() =>
      this.deletes.setAttributeArchived(
        requireContext(request),
        auditable(request),
        attributeId,
        true,
      ),
    );
  }

  @RequireAbility('update', 'Catalog')
  @Post('attributes/:id/restore')
  @HttpCode(200)
  async restoreAttribute(@Req() request: FastifyRequest, @Param('id') id: string) {
    const attributeId = parse(catalogIdSchema, id);
    return mapCatalogErrors(() =>
      this.deletes.setAttributeArchived(
        requireContext(request),
        auditable(request),
        attributeId,
        false,
      ),
    );
  }

  /** Values in a new order: every value of the list, once. */
  @RequireAbility('update', 'Catalog')
  @Put('attributes/:id/values/order')
  async reorderValues(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const attributeId = parse(catalogIdSchema, id);
    const input = parse(reorderValuesSchema, body);
    return mapCatalogErrors(() =>
      this.deletes.reorderValues(requireContext(request), auditable(request), attributeId, input),
    );
  }

  // --- values --------------------------------------------------------------------------------

  @RequireAbility('update', 'Catalog')
  @Get('attributes/:id/values/:valueId/usage')
  async valueUsage(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Param('valueId') valueId: string,
  ) {
    const attributeId = parse(catalogIdSchema, id);
    const value = parse(catalogIdSchema, valueId);
    return mapCatalogErrors(() =>
      this.deletes.valueUsage(requireContext(request), attributeId, value),
    );
  }

  @RequireAbility('delete', 'Catalog')
  @Delete('attributes/:id/values/:valueId')
  async deleteValue(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Param('valueId') valueId: string,
  ) {
    const attributeId = parse(catalogIdSchema, id);
    const value = parse(catalogIdSchema, valueId);
    return mapCatalogErrors(() =>
      this.deletes.deleteValue(requireContext(request), auditable(request), attributeId, value),
    );
  }

  /** Archive a value; `archiveVariants` archives every active variant carrying it too. */
  @RequireAbility('update', 'Catalog')
  @Post('attributes/:id/values/:valueId/archive')
  @HttpCode(200)
  async archiveValue(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Param('valueId') valueId: string,
    @Body() body: unknown,
  ) {
    const attributeId = parse(catalogIdSchema, id);
    const value = parse(catalogIdSchema, valueId);
    const input = parse(archiveValueSchema, body ?? {});
    return mapCatalogErrors(() =>
      this.deletes.archiveValue(
        requireContext(request),
        auditable(request),
        attributeId,
        value,
        input,
      ),
    );
  }

  @RequireAbility('update', 'Catalog')
  @Post('attributes/:id/values/:valueId/restore')
  @HttpCode(200)
  async restoreValue(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Param('valueId') valueId: string,
  ) {
    const attributeId = parse(catalogIdSchema, id);
    const value = parse(catalogIdSchema, valueId);
    return mapCatalogErrors(() =>
      this.deletes.restoreValue(requireContext(request), auditable(request), attributeId, value),
    );
  }

  // --- products and variants -----------------------------------------------------------------

  @RequireAbility('update', 'Catalog')
  @Get('products/:id/usage')
  async productUsage(@Req() request: FastifyRequest, @Param('id') id: string) {
    const productId = parse(catalogIdSchema, id);
    return mapCatalogErrors(() => this.deletes.productUsage(requireContext(request), productId));
  }

  @RequireAbility('delete', 'Catalog')
  @Delete('products/:id')
  async deleteProduct(@Req() request: FastifyRequest, @Param('id') id: string) {
    const productId = parse(catalogIdSchema, id);
    return mapCatalogErrors(() =>
      this.deletes.deleteProduct(requireContext(request), auditable(request), productId),
    );
  }

  @RequireAbility('update', 'Catalog')
  @Get('skus/:id/usage')
  async skuUsage(@Req() request: FastifyRequest, @Param('id') id: string) {
    const skuId = parse(catalogIdSchema, id);
    return mapCatalogErrors(() => this.deletes.skuUsage(requireContext(request), skuId));
  }

  @RequireAbility('delete', 'Catalog')
  @Delete('skus/:id')
  async deleteSku(@Req() request: FastifyRequest, @Param('id') id: string) {
    const skuId = parse(catalogIdSchema, id);
    return mapCatalogErrors(() =>
      this.deletes.deleteSku(requireContext(request), auditable(request), skuId),
    );
  }
}
