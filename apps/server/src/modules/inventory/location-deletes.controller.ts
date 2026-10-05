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
import { stockIdSchema } from './inventory.schemas.js';
import { LocationDeletesService } from './location-deletes.service.js';

function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message);
  return parsed.data;
}

const auditable = (request: FastifyRequest): AuditableRequest =>
  request as unknown as AuditableRequest;

/**
 * Deleting, archiving and restoring a stock location (M39a, D-629).
 *
 * Under the catalog's grants, as creating and renaming one already are (a location is
 * catalog setup, D-046): `update Catalog` to ask what uses it and to switch it off or on,
 * `delete Catalog` to delete one nothing ever named. All org_admin.
 */
@Controller('v1/inventory')
export class LocationDeletesController {
  constructor(private readonly locations: LocationDeletesService) {}

  @RequireAbility('update', 'Catalog')
  @Get('locations/:id/usage')
  async usage(@Req() request: FastifyRequest, @Param('id') id: string) {
    const locationId = parse(stockIdSchema, id);
    return this.locations.usage(requireContext(request), request, locationId);
  }

  @RequireAbility('delete', 'Catalog')
  @Delete('locations/:id')
  async delete(@Req() request: FastifyRequest, @Param('id') id: string) {
    const locationId = parse(stockIdSchema, id);
    return this.locations.delete(requireContext(request), auditable(request), locationId);
  }

  @RequireAbility('update', 'Catalog')
  @Post('locations/:id/archive')
  @HttpCode(200)
  async archive(@Req() request: FastifyRequest, @Param('id') id: string) {
    const locationId = parse(stockIdSchema, id);
    return this.locations.setArchived(
      requireContext(request),
      auditable(request),
      locationId,
      true,
    );
  }

  @RequireAbility('update', 'Catalog')
  @Post('locations/:id/restore')
  @HttpCode(200)
  async restore(@Req() request: FastifyRequest, @Param('id') id: string) {
    const locationId = parse(stockIdSchema, id);
    return this.locations.setArchived(
      requireContext(request),
      auditable(request),
      locationId,
      false,
    );
  }
}
