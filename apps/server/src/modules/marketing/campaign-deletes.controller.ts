import { BadRequestException, Controller, Delete, Get, Param, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { RequireAbility } from '../../platform/auth/abilities.js';
import { requireContext } from '../../platform/http/context.js';
import { CampaignDeletesService } from './campaign-deletes.service.js';

function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message);
  return parsed.data;
}

const idSchema = z.string().uuid('No such campaign.');

const auditable = (request: FastifyRequest): AuditableRequest =>
  request as unknown as AuditableRequest;

/**
 * Deleting an ad campaign nothing used (M39a, D-632). `update Campaign` (org_admin and
 * marketing) asks what uses it, as archiving needs; `delete Campaign`, org_admin's alone,
 * deletes it. Archive and restore stay `PATCH campaigns/:id`.
 */
@Controller('v1/marketing')
export class CampaignDeletesController {
  constructor(private readonly campaigns: CampaignDeletesService) {}

  @RequireAbility('update', 'Campaign')
  @Get('campaigns/:id/usage')
  async usage(@Req() request: FastifyRequest, @Param('id') id: string) {
    const campaignId = parse(idSchema, id);
    return this.campaigns.usage(requireContext(request), campaignId);
  }

  @RequireAbility('delete', 'Campaign')
  @Delete('campaigns/:id')
  async delete(@Req() request: FastifyRequest, @Param('id') id: string) {
    const campaignId = parse(idSchema, id);
    return this.campaigns.delete(requireContext(request), auditable(request), campaignId);
  }
}
