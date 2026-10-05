import { BadRequestException, Controller, Delete, Get, Param, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { z } from 'zod';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { RequireAbility } from '../../platform/auth/abilities.js';
import { requireContext } from '../../platform/http/context.js';
import { SupplierDeletesService } from './supplier-deletes.service.js';
import { idParamSchema } from './supply.schemas.js';

function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message);
  return parsed.data;
}

const auditable = (request: FastifyRequest): AuditableRequest =>
  request as unknown as AuditableRequest;

/**
 * Deleting a supplier (M39a, D-630). `update Supply` (org_admin, accounts, and the
 * warehouse's drafts) asks what names it, as deactivating already needs; `delete Supply`,
 * org_admin's alone, deletes one nothing names. Deactivate and reactivate stay
 * `PATCH suppliers/:id`.
 */
@Controller('v1/supply')
export class SupplierDeletesController {
  constructor(private readonly suppliers: SupplierDeletesService) {}

  @RequireAbility('update', 'Supply')
  @Get('suppliers/:id/usage')
  async usage(@Req() request: FastifyRequest, @Param('id') id: string) {
    const supplierId = parse(idParamSchema, id);
    return this.suppliers.usage(requireContext(request), supplierId);
  }

  @RequireAbility('delete', 'Supply')
  @Delete('suppliers/:id')
  async delete(@Req() request: FastifyRequest, @Param('id') id: string) {
    const supplierId = parse(idParamSchema, id);
    return this.suppliers.delete(requireContext(request), auditable(request), supplierId);
  }
}
