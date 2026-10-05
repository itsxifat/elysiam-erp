import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { z } from 'zod';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { RequireAbility } from '../../platform/auth/abilities.js';
import { requireContext } from '../../platform/http/context.js';
import { flashIdParamSchema } from './flash.schemas.js';
import { PromoDeletesService } from './promo-deletes.service.js';
import { mapPromoErrors } from './promo.errors.js';
import { promoIdParamSchema } from './promo.schemas.js';

function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message);
  return parsed.data;
}

const auditable = (request: FastifyRequest): AuditableRequest =>
  request as unknown as AuditableRequest;

/**
 * Deleting, archiving and restoring discounts and flash sales (M39a, D-631).
 *
 * The `LandingPage` subject, as for every other promotion route (D-203): `update` (org_admin
 * and marketing) to ask what uses one and to archive or restore it, `delete` (org_admin
 * alone, added by M39a) to delete one nobody used.
 */
@Controller('v1/promo')
export class PromoDeletesController {
  constructor(private readonly deletes: PromoDeletesService) {}

  @RequireAbility('update', 'LandingPage')
  @Get('codes/:id/usage')
  async discountUsage(@Req() request: FastifyRequest, @Param('id') id: string) {
    const codeId = parse(promoIdParamSchema, id);
    return mapPromoErrors(() => this.deletes.discountUsage(requireContext(request), codeId));
  }

  @RequireAbility('delete', 'LandingPage')
  @Delete('codes/:id')
  async deleteDiscount(@Req() request: FastifyRequest, @Param('id') id: string) {
    const codeId = parse(promoIdParamSchema, id);
    return mapPromoErrors(() =>
      this.deletes.deleteDiscount(requireContext(request), auditable(request), codeId),
    );
  }

  /** An archived discount comes back paused, never straight to active. */
  @RequireAbility('update', 'LandingPage')
  @Post('codes/:id/restore')
  @HttpCode(200)
  async restoreDiscount(@Req() request: FastifyRequest, @Param('id') id: string) {
    const codeId = parse(promoIdParamSchema, id);
    return mapPromoErrors(() =>
      this.deletes.restoreDiscount(requireContext(request), auditable(request), codeId),
    );
  }

  @RequireAbility('update', 'LandingPage')
  @Get('flash-sales/:id/usage')
  async flashUsage(@Req() request: FastifyRequest, @Param('id') id: string) {
    const saleId = parse(flashIdParamSchema, id);
    return mapPromoErrors(() => this.deletes.flashUsage(requireContext(request), saleId));
  }

  @RequireAbility('delete', 'LandingPage')
  @Delete('flash-sales/:id')
  async deleteFlashSale(@Req() request: FastifyRequest, @Param('id') id: string) {
    const saleId = parse(flashIdParamSchema, id);
    return mapPromoErrors(() =>
      this.deletes.deleteFlashSale(requireContext(request), auditable(request), saleId),
    );
  }

  @RequireAbility('update', 'LandingPage')
  @Post('flash-sales/:id/archive')
  @HttpCode(200)
  async archiveFlashSale(@Req() request: FastifyRequest, @Param('id') id: string) {
    const saleId = parse(flashIdParamSchema, id);
    return mapPromoErrors(() =>
      this.deletes.setFlashArchived(requireContext(request), auditable(request), saleId, true),
    );
  }

  @RequireAbility('update', 'LandingPage')
  @Post('flash-sales/:id/restore')
  @HttpCode(200)
  async restoreFlashSale(@Req() request: FastifyRequest, @Param('id') id: string) {
    const saleId = parse(flashIdParamSchema, id);
    return mapPromoErrors(() =>
      this.deletes.setFlashArchived(requireContext(request), auditable(request), saleId, false),
    );
  }
}
