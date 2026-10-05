import { BadRequestException, Body, Controller, Get, Param, Patch, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { RequireAbility } from '../../platform/auth/abilities.js';
import { requireContext } from '../../platform/http/context.js';
import { BranchAdminService } from './branch-admin.service.js';

function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message);
  return parsed.data;
}

const idSchema = z.string().uuid('No such branch.');

const updateBranchSchema = z
  .object({
    name: z.string().trim().min(1, 'A name is required.').max(120).optional(),
    isActive: z.boolean().optional(),
  })
  .strict()
  .refine(
    (value) => value.name !== undefined || value.isActive !== undefined,
    'Nothing to change.',
  );

const auditable = (request: FastifyRequest): AuditableRequest =>
  request as unknown as AuditableRequest;

/**
 * A branch's own record (M39a, D-633): what still runs there, a new name, switching it off
 * or back on. `read Branch` and `update Branch`, org_admin only (§6 "settings"). The branch
 * dashboards stay where they were (`GET branches`, `read LedgerReport`).
 */
@Controller('v1/pos')
export class BranchAdminController {
  constructor(private readonly branches: BranchAdminService) {}

  @RequireAbility('read', 'Branch')
  @Get('branches/:id/holds')
  async holds(@Req() request: FastifyRequest, @Param('id') id: string) {
    const branchId = parse(idSchema, id);
    return this.branches.holds(requireContext(request), branchId);
  }

  @RequireAbility('update', 'Branch')
  @Patch('branches/:id')
  async update(@Req() request: FastifyRequest, @Param('id') id: string, @Body() body: unknown) {
    const branchId = parse(idSchema, id);
    const patch = parse(updateBranchSchema, body);
    return this.branches.update(requireContext(request), auditable(request), branchId, patch);
  }
}
