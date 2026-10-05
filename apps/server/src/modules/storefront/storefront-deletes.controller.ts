import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { emptySizeChartSchema } from '@elysium/contracts';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { RequireAbility } from '../../platform/auth/abilities.js';
import { requireContext } from '../../platform/http/context.js';
import { StorefrontDeletesService } from './storefront-deletes.service.js';
import { mapStorefrontErrors } from './storefront.errors.js';

function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message);
  return parsed.data;
}

const idSchema = z.string().uuid('No such record.');

const auditable = (request: FastifyRequest): AuditableRequest =>
  request as unknown as AuditableRequest;

/**
 * What uses a size chart or a menu item, and a size chart's "Empty and delete" (M39a, D-628).
 *
 * The website's grants (D-508): `update Storefront` (org_admin and marketing) to ask,
 * `delete Storefront` to delete, as the plain DELETE of a chart or an item already needs.
 */
@Controller('v1/storefront')
export class StorefrontDeletesController {
  constructor(private readonly deletes: StorefrontDeletesService) {}

  @RequireAbility('update', 'Storefront')
  @Get('size-charts/:id/usage')
  async sizeChartUsage(@Req() request: FastifyRequest, @Param('id') id: string) {
    const chartId = parse(idSchema, id);
    return mapStorefrontErrors(() => this.deletes.sizeChartUsage(requireContext(request), chartId));
  }

  @RequireAbility('delete', 'Storefront')
  @Post('size-charts/:id/empty-and-delete')
  @HttpCode(200)
  async emptyAndDeleteSizeChart(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const chartId = parse(idSchema, id);
    const input = parse(emptySizeChartSchema, body);
    return mapStorefrontErrors(() =>
      this.deletes.emptyAndDeleteSizeChart(
        requireContext(request),
        auditable(request),
        chartId,
        input,
      ),
    );
  }

  /** A menu item, and how many items under it go when it is deleted. */
  @RequireAbility('update', 'Storefront')
  @Get('nav-items/:id/usage')
  async navItemUsage(@Req() request: FastifyRequest, @Param('id') id: string) {
    const itemId = parse(idSchema, id);
    return mapStorefrontErrors(() => this.deletes.navItemUsage(requireContext(request), itemId));
  }
}
