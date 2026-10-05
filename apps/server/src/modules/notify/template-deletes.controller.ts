import { BadRequestException, Controller, Delete, Get, Param, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { RequireAbility } from '../../platform/auth/abilities.js';
import { requireContext } from '../../platform/http/context.js';
import { TemplateDeletesService } from './template-deletes.service.js';

function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message);
  return parsed.data;
}

const idSchema = z.string().uuid('No such template.');

const auditable = (request: FastifyRequest): AuditableRequest =>
  request as unknown as AuditableRequest;

/**
 * Deleting an SMS template that never went out (M39a, D-632). The `Campaign` subject, as for
 * every notify route (D-205): `update` (org_admin and marketing) asks what uses it,
 * `delete` (org_admin alone) deletes it. Switching one off stays `PUT templates`.
 */
@Controller('v1/notify')
export class TemplateDeletesController {
  constructor(private readonly templates: TemplateDeletesService) {}

  @RequireAbility('update', 'Campaign')
  @Get('templates/:id/usage')
  async usage(@Req() request: FastifyRequest, @Param('id') id: string) {
    const templateId = parse(idSchema, id);
    return this.templates.usage(requireContext(request), templateId);
  }

  @RequireAbility('delete', 'Campaign')
  @Delete('templates/:id')
  async delete(@Req() request: FastifyRequest, @Param('id') id: string) {
    const templateId = parse(idSchema, id);
    return this.templates.delete(requireContext(request), auditable(request), templateId);
  }
}
