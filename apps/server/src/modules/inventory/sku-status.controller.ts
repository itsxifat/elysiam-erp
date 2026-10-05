import { BadRequestException, Body, Controller, Patch, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import { RequireAbility } from '../../platform/auth/abilities.js';
import { requireContext } from '../../platform/http/context.js';
import { SkuStatusService, skuStatusesSchema } from './sku-status.service.js';

/**
 * `PATCH /v1/catalog/skus` (M39b, D-639): archive or restore many variants at once.
 *
 * `update Catalog`, like archiving one variant (`PATCH /v1/catalog/skus/:id`, D-423): it is a
 * catalog decision, org_admin's. Served here because the guard is a stock question (see
 * `SkuStatusService`). Audited by the net like every mutation.
 */
@Controller('v1/catalog')
export class SkuStatusController {
  constructor(private readonly statuses: SkuStatusService) {}

  @RequireAbility('update', 'Catalog')
  @Patch('skus')
  async setStatuses(@Req() request: FastifyRequest, @Body() body: unknown) {
    const parsed = skuStatusesSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message);
    return this.statuses.setStatuses(requireContext(request), parsed.data);
  }
}
