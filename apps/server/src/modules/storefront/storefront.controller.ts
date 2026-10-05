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
  Req,
} from '@nestjs/common';
import {
  categoryWebFieldsSchema,
  heroSlideSchema,
  issueStorefrontKeySchema,
  navItemSchema,
  navLayoutSchema,
  productWebFieldsSchema,
  reorderSchema,
  sizeChartSchema,
  storefrontSettingsPatchSchema,
} from '@elysium/contracts';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { RequireAbility } from '../../platform/auth/abilities.js';
import { requireContext } from '../../platform/http/context.js';
import { mapStorefrontErrors } from './storefront.errors.js';
import { StorefrontService } from './storefront.service.js';

const idSchema = z.string().uuid('No such record.');

const auditable = (request: FastifyRequest): AuditableRequest =>
  request as unknown as AuditableRequest;

function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new BadRequestException({
      code: 'VALIDATION_FAILED',
      message: issue === undefined ? 'That is not valid.' : issue.message,
    });
  }
  return parsed.data;
}

/**
 * The console's Website section (M33, D-503 to D-508): settings, hero slides, the menu, size
 * charts, the website's keys, and the website fields on a product and a category.
 *
 * `Storefront` is the subject throughout (D-508): org_admin and marketing manage it, sales
 * reads it. Every grant is `org` (a brand has one website), so no handler narrows by row.
 * The product and category routes write catalog columns, but through `CATALOG_API` and under
 * `Storefront`: what the website shows is marketing's to decide, where the catalog itself
 * (names, prices, SKUs) stays org_admin's.
 */
@Controller('v1/storefront')
export class StorefrontController {
  constructor(private readonly storefront: StorefrontService) {}

  // --- settings -------------------------------------------------------------------------------

  @RequireAbility('read', 'Storefront')
  @Get('settings')
  async settings(@Req() request: FastifyRequest) {
    return mapStorefrontErrors(() => this.storefront.getSettings(requireContext(request)));
  }

  @RequireAbility('update', 'Storefront')
  @Patch('settings')
  async patchSettings(@Req() request: FastifyRequest, @Body() body: unknown) {
    const input = parse(storefrontSettingsPatchSchema, body);
    return mapStorefrontErrors(() =>
      this.storefront.patchSettings(requireContext(request), auditable(request), input),
    );
  }

  // --- hero slides ----------------------------------------------------------------------------

  @RequireAbility('read', 'Storefront')
  @Get('hero-slides')
  async heroSlides(@Req() request: FastifyRequest) {
    return mapStorefrontErrors(() => this.storefront.listHeroSlides(requireContext(request)));
  }

  @RequireAbility('create', 'Storefront')
  @Post('hero-slides')
  async createHeroSlide(@Req() request: FastifyRequest, @Body() body: unknown) {
    const input = parse(heroSlideSchema, body);
    return mapStorefrontErrors(() =>
      this.storefront.createHeroSlide(requireContext(request), input),
    );
  }

  @RequireAbility('update', 'Storefront')
  @Put('hero-slides/order')
  async reorderHeroSlides(@Req() request: FastifyRequest, @Body() body: unknown) {
    const input = parse(reorderSchema, body);
    return mapStorefrontErrors(() =>
      this.storefront.reorderHeroSlides(requireContext(request), input.ids),
    );
  }

  @RequireAbility('update', 'Storefront')
  @Put('hero-slides/:id')
  async updateHeroSlide(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const slideId = parse(idSchema, id);
    const input = parse(heroSlideSchema, body);
    return mapStorefrontErrors(() =>
      this.storefront.updateHeroSlide(requireContext(request), slideId, input),
    );
  }

  @RequireAbility('delete', 'Storefront')
  @Delete('hero-slides/:id')
  async deleteHeroSlide(@Req() request: FastifyRequest, @Param('id') id: string) {
    const slideId = parse(idSchema, id);
    return mapStorefrontErrors(() =>
      this.storefront.deleteHeroSlide(requireContext(request), slideId),
    );
  }

  // --- the menu -------------------------------------------------------------------------------

  @RequireAbility('read', 'Storefront')
  @Get('nav-items')
  async navItems(@Req() request: FastifyRequest) {
    return mapStorefrontErrors(() => this.storefront.listNav(requireContext(request)));
  }

  @RequireAbility('create', 'Storefront')
  @Post('nav-items')
  async createNavItem(@Req() request: FastifyRequest, @Body() body: unknown) {
    const input = parse(navItemSchema, body);
    return mapStorefrontErrors(() => this.storefront.createNavItem(requireContext(request), input));
  }

  @RequireAbility('update', 'Storefront')
  @Put('nav-items/layout')
  async layoutNav(@Req() request: FastifyRequest, @Body() body: unknown) {
    const input = parse(navLayoutSchema, body);
    return mapStorefrontErrors(() =>
      this.storefront.layoutNav(requireContext(request), input.items),
    );
  }

  @RequireAbility('update', 'Storefront')
  @Put('nav-items/:id')
  async updateNavItem(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const itemId = parse(idSchema, id);
    const input = parse(navItemSchema, body);
    return mapStorefrontErrors(() =>
      this.storefront.updateNavItem(requireContext(request), itemId, input),
    );
  }

  @RequireAbility('delete', 'Storefront')
  @Delete('nav-items/:id')
  async deleteNavItem(@Req() request: FastifyRequest, @Param('id') id: string) {
    const itemId = parse(idSchema, id);
    return mapStorefrontErrors(() =>
      this.storefront.deleteNavItem(requireContext(request), itemId),
    );
  }

  // --- size charts ----------------------------------------------------------------------------

  @RequireAbility('read', 'Storefront')
  @Get('size-charts')
  async sizeCharts(@Req() request: FastifyRequest) {
    return mapStorefrontErrors(() => this.storefront.listSizeCharts(requireContext(request)));
  }

  @RequireAbility('create', 'Storefront')
  @Post('size-charts')
  async createSizeChart(@Req() request: FastifyRequest, @Body() body: unknown) {
    const input = parse(sizeChartSchema, body);
    return mapStorefrontErrors(() =>
      this.storefront.createSizeChart(requireContext(request), input),
    );
  }

  @RequireAbility('update', 'Storefront')
  @Put('size-charts/:id')
  async updateSizeChart(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const chartId = parse(idSchema, id);
    const input = parse(sizeChartSchema, body);
    return mapStorefrontErrors(() =>
      this.storefront.updateSizeChart(requireContext(request), chartId, input),
    );
  }

  @RequireAbility('delete', 'Storefront')
  @Delete('size-charts/:id')
  async deleteSizeChart(@Req() request: FastifyRequest, @Param('id') id: string) {
    const chartId = parse(idSchema, id);
    return mapStorefrontErrors(() =>
      this.storefront.deleteSizeChart(requireContext(request), chartId),
    );
  }

  // --- the website's keys ---------------------------------------------------------------------

  /** Labels and public key ids; never a secret, because none is stored. */
  @RequireAbility('read', 'Storefront')
  @Get('site-keys')
  async siteKeys(@Req() request: FastifyRequest) {
    return mapStorefrontErrors(() => this.storefront.listKeys(requireContext(request)));
  }

  /** The one response that carries a key's secret. */
  @RequireAbility('create', 'Storefront')
  @Post('site-keys')
  async issueKey(@Req() request: FastifyRequest, @Body() body: unknown) {
    const input = parse(issueStorefrontKeySchema, body);
    return mapStorefrontErrors(() =>
      this.storefront.issueKey(requireContext(request), auditable(request), input.label),
    );
  }

  @RequireAbility('update', 'Storefront')
  @Post('site-keys/:id/revoke')
  async revokeKey(@Req() request: FastifyRequest, @Param('id') id: string) {
    const keyId = parse(idSchema, id);
    return mapStorefrontErrors(() =>
      this.storefront.revokeKey(requireContext(request), auditable(request), keyId),
    );
  }

  // --- website fields on the catalog ----------------------------------------------------------

  @RequireAbility('update', 'Storefront')
  @Put('products/:id')
  async productWebFields(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const productId = parse(idSchema, id);
    const input = parse(productWebFieldsSchema, body);
    return mapStorefrontErrors(() =>
      this.storefront.setProductWebFields(requireContext(request), productId, input),
    );
  }

  @RequireAbility('update', 'Storefront')
  @Put('categories/:id')
  async categoryWebFields(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const categoryId = parse(idSchema, id);
    const input = parse(categoryWebFieldsSchema, body);
    return mapStorefrontErrors(() =>
      this.storefront.setCategoryWebFields(requireContext(request), categoryId, input),
    );
  }
}
