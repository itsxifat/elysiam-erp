import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { z } from 'zod';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { RequireAbility } from '../../platform/auth/abilities.js';
import { scopeHasNoRowDimension } from '../../platform/auth/scope.js';
import { requireContext } from '../../platform/http/context.js';
import {
  flashEnabledSchema,
  flashIdParamSchema,
  flashListSchema,
  flashSaleBodySchema,
} from './flash.schemas.js';
import { FlashService } from './flash.service.js';
import { mapPromoErrors } from './promo.errors.js';

function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message);
  return parsed.data;
}

const auditable = (request: FastifyRequest): AuditableRequest =>
  request as unknown as AuditableRequest;

const FLASH_HAS_NO_ROW_DIMENSION =
  'a flash sale is the brand’s: it has no branch, owner or assignee to narrow by';

/**
 * Flash sales over HTTP (M35a, D-542; architecture §10, §23).
 *
 * The same subject as promo codes, `LandingPage` (D-203): §6's row for landing pages and
 * promo codes is the brand's promotions, and a flash sale is one. Marketing and org_admin
 * read, create and update; since M39a org_admin deletes a sale that sold nothing, and a sale
 * that sold is archived instead (it is the record of the price it sold at; D-631). Responses carry selling prices only; `SerializeInterceptor` runs
 * `serializeFor()` against this route's subject as it does for every route.
 *
 * The website reads live sales through the storefront API (M33, M34), never through here.
 */
@Controller('v1/promo/flash-sales')
export class FlashController {
  constructor(private readonly flash: FlashService) {}

  @RequireAbility('read', 'LandingPage')
  @Get()
  async list(@Req() request: FastifyRequest, @Query() query: unknown) {
    scopeHasNoRowDimension(request, FLASH_HAS_NO_ROW_DIMENSION);
    const { limit, archived } = parse(flashListSchema, query);
    return mapPromoErrors(() =>
      this.flash.list(requireContext(request), limit, archived === 'true'),
    );
  }

  @RequireAbility('create', 'LandingPage')
  @Post()
  async create(@Req() request: FastifyRequest, @Body() body: unknown) {
    const input = parse(flashSaleBodySchema, body);
    return mapPromoErrors(() =>
      this.flash.create(requireContext(request), auditable(request), input),
    );
  }

  @RequireAbility('read', 'LandingPage')
  @Get(':id')
  async detail(@Req() request: FastifyRequest, @Param('id') id: string) {
    scopeHasNoRowDimension(request, FLASH_HAS_NO_ROW_DIMENSION);
    const saleId = parse(flashIdParamSchema, id);
    return mapPromoErrors(() => this.flash.get(requireContext(request), saleId));
  }

  /** The whole sale as the editor has it; SKUs left out are switched off, not deleted. */
  @RequireAbility('update', 'LandingPage')
  @Put(':id')
  async update(@Req() request: FastifyRequest, @Param('id') id: string, @Body() body: unknown) {
    const saleId = parse(flashIdParamSchema, id);
    const input = parse(flashSaleBodySchema, body);
    return mapPromoErrors(() =>
      this.flash.update(requireContext(request), auditable(request), saleId, input),
    );
  }

  /** Switch a sale on or off without touching anything else. */
  @RequireAbility('update', 'LandingPage')
  @Patch(':id')
  async setEnabled(@Req() request: FastifyRequest, @Param('id') id: string, @Body() body: unknown) {
    const saleId = parse(flashIdParamSchema, id);
    const { enabled } = parse(flashEnabledSchema, body);
    return mapPromoErrors(() =>
      this.flash.setEnabled(requireContext(request), auditable(request), saleId, enabled),
    );
  }

  /** A switched-off copy to start the next sale from. */
  @RequireAbility('create', 'LandingPage')
  @Post(':id/duplicate')
  async duplicate(@Req() request: FastifyRequest, @Param('id') id: string) {
    const saleId = parse(flashIdParamSchema, id);
    return mapPromoErrors(() =>
      this.flash.duplicate(requireContext(request), auditable(request), saleId),
    );
  }
}
