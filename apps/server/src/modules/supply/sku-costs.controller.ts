import { BadRequestException, Body, Controller, Get, Post, Put, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { z } from 'zod';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { RequireAbility } from '../../platform/auth/abilities.js';
import { requireContext } from '../../platform/http/context.js';
import {
  setStandardCostsSchema,
  SkuCostsService,
  skuCostsQuerySchema,
  standardCostExportSchema,
  standardCostImportSchema,
} from './sku-costs.service.js';

const auditable = (request: FastifyRequest): AuditableRequest =>
  request as unknown as AuditableRequest;

function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message);
  return parsed.data;
}

/**
 * Buying prices per variant over HTTP (M39b, D-637, D-638).
 *
 * Every route declares **`read Cost`** (super_admin, org_admin, accounts: §6's cost row), the
 * same set D-005 lets price a receipt, because every answer here is purchase cost (invariant
 * 5). Writing a standard price also needs `update Supply`, which the service checks (every
 * `read Cost` role holds it today). Mutations write their own audit rows, with counts only
 * (the request body is the prices), so the interceptor's net stands down for them.
 */
@Controller('v1/supply')
export class SkuCostsController {
  constructor(private readonly costs: SkuCostsService) {}

  /** Standard, last and average buying price per variant, and a receipt's prefill. */
  @RequireAbility('read', 'Cost')
  @Get('sku-costs')
  async list(@Req() request: FastifyRequest, @Query() query: unknown) {
    return this.costs.costs(requireContext(request), parse(skuCostsQuerySchema, query ?? {}));
  }

  /** Set, replace or remove standard buying prices (D-638). */
  @RequireAbility('read', 'Cost')
  @Put('sku-costs')
  async set(@Req() request: FastifyRequest, @Body() body: unknown) {
    return this.costs.setStandards(
      requireContext(request),
      auditable(request),
      parse(setStandardCostsSchema, body),
    );
  }

  /** The standard buying price spreadsheet, every active variant (D-638). */
  @RequireAbility('read', 'Cost')
  @Get('sku-costs/export')
  async exportCsv(@Req() request: FastifyRequest, @Query() query: unknown) {
    const parsed = parse(standardCostExportSchema, query ?? {});
    return this.costs.exportCsv(requireContext(request), parsed.productId);
  }

  /** Check a spreadsheet, change nothing. */
  @RequireAbility('read', 'Cost')
  @Post('sku-costs/import/dry-run')
  async dryRun(@Req() request: FastifyRequest, @Body() body: unknown) {
    return this.costs.dryRun(
      requireContext(request),
      auditable(request),
      parse(standardCostImportSchema, body),
    );
  }

  /** Import a spreadsheet: every priced row, or none. */
  @RequireAbility('read', 'Cost')
  @Post('sku-costs/import')
  async commit(@Req() request: FastifyRequest, @Body() body: unknown) {
    return this.costs.commit(
      requireContext(request),
      auditable(request),
      parse(standardCostImportSchema, body),
    );
  }
}
