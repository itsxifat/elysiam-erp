import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { z } from 'zod';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { RequireAbility } from '../../platform/auth/abilities.js';
import { requireContext } from '../../platform/http/context.js';
import { BonusRulesService } from './bonus.service.js';
import { hrIdSchema } from './hr.schemas.js';
import {
  bonusVersionSchema,
  createBonusRuleSchema,
  createTargetSchema,
  meQuerySchema,
  previewQuerySchema,
  productivityQuerySchema,
  submitVersionSchema,
  targetQuerySchema,
} from './performance.schemas.js';
import { TargetsService } from './targets.service.js';

function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message);
  return parsed.data;
}

const auditable = (request: FastifyRequest): AuditableRequest =>
  request as unknown as AuditableRequest;

/**
 * Targets, bonus rules and productivity over HTTP (M20; architecture §6, §12; D-278).
 *
 * Two subjects, split by who may see money:
 *
 * * **`Target`** for targets, progress and productivity. hr and org_admin across the org,
 *   a branch manager for their branch, and sales and marketing `own` — the targets that
 *   count them and their own desk figures (M20 check 4).
 * * **`Payroll`** for bonus rules, their preview and their application to a run. A rule's
 *   preview lists what each person would be paid, which is a payroll figure, so it sits
 *   behind the grant §6 gives hr, accounts and org_admin — not behind `read Target`, which
 *   every agent holds for themselves.
 */
@Controller('v1/hr')
export class PerformanceController {
  constructor(
    private readonly targets: TargetsService,
    private readonly bonuses: BonusRulesService,
  ) {}

  // --- targets ------------------------------------------------------------------

  @RequireAbility('read', 'Target')
  @Get('targets')
  async listTargets(@Req() request: FastifyRequest, @Query() query: unknown) {
    return this.targets.list(
      requireContext(request),
      request,
      parse(targetQuerySchema, query ?? {}),
    );
  }

  @RequireAbility('read', 'Target')
  @Get('targets/:id')
  async getTarget(@Req() request: FastifyRequest, @Param('id') id: string) {
    return this.targets.get(requireContext(request), request, parse(hrIdSchema, id));
  }

  @RequireAbility('create', 'Target')
  @Post('targets')
  async createTarget(@Req() request: FastifyRequest, @Body() body: unknown) {
    return this.targets.create(
      requireContext(request),
      auditable(request),
      parse(createTargetSchema, body),
    );
  }

  @RequireAbility('update', 'Target')
  @Post('targets/refresh')
  async refreshTargets(@Req() request: FastifyRequest) {
    return this.targets.refresh(requireContext(request), auditable(request));
  }

  @RequireAbility('update', 'Target')
  @Post('targets/:id/cancel')
  async cancelTarget(@Req() request: FastifyRequest, @Param('id') id: string) {
    return this.targets.cancel(requireContext(request), auditable(request), parse(hrIdSchema, id));
  }

  // --- the agent's own figures, and the desk report -------------------------------

  @RequireAbility('read', 'Target')
  @Get('performance/me')
  async me(@Req() request: FastifyRequest, @Query() query: unknown) {
    const parsed = parse(meQuerySchema, query ?? {});
    return this.targets.me(requireContext(request), request, parsed.month);
  }

  @RequireAbility('read', 'Target')
  @Get('productivity')
  async productivity(@Req() request: FastifyRequest, @Query() query: unknown) {
    return this.targets.productivity(
      requireContext(request),
      request,
      parse(productivityQuerySchema, query ?? {}),
    );
  }

  // --- bonus rules --------------------------------------------------------------------

  @RequireAbility('read', 'Payroll')
  @Get('bonus-rules')
  async listRules(@Req() request: FastifyRequest) {
    return this.bonuses.list(requireContext(request));
  }

  @RequireAbility('create', 'Payroll')
  @Post('bonus-rules')
  async createRule(@Req() request: FastifyRequest, @Body() body: unknown) {
    return this.bonuses.create(
      requireContext(request),
      auditable(request),
      parse(createBonusRuleSchema, body),
    );
  }

  @RequireAbility('create', 'Payroll')
  @Post('bonus-rules/:id/versions')
  async addVersion(@Req() request: FastifyRequest, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(bonusVersionSchema, body);
    return this.bonuses.addVersion(
      requireContext(request),
      auditable(request),
      parse(hrIdSchema, id),
      input.definition,
    );
  }

  @RequireAbility('read', 'Payroll')
  @Get('bonus-rules/versions/:versionId/preview')
  async preview(
    @Req() request: FastifyRequest,
    @Param('versionId') versionId: string,
    @Query() query: unknown,
  ) {
    const parsed = parse(previewQuerySchema, query ?? {});
    return this.bonuses.preview(
      requireContext(request),
      parse(hrIdSchema, versionId),
      parsed.month,
    );
  }

  @RequireAbility('create', 'Payroll')
  @Post('bonus-rules/versions/:versionId/submit')
  async submit(
    @Req() request: FastifyRequest,
    @Param('versionId') versionId: string,
    @Body() body: unknown,
  ) {
    const input = parse(submitVersionSchema, body ?? {});
    return this.bonuses.submit(
      requireContext(request),
      auditable(request),
      parse(hrIdSchema, versionId),
      input.reason,
    );
  }

  // --- bonuses on a payroll run ---------------------------------------------------------

  @RequireAbility('read', 'Payroll')
  @Get('payroll/runs/:id/bonuses')
  async runBonuses(@Req() request: FastifyRequest, @Param('id') id: string) {
    return this.bonuses.runBonuses(requireContext(request), parse(hrIdSchema, id));
  }

  @RequireAbility('create', 'Payroll')
  @Post('payroll/runs/:id/bonuses')
  async applyBonuses(@Req() request: FastifyRequest, @Param('id') id: string) {
    return this.bonuses.applyToRun(
      requireContext(request),
      auditable(request),
      parse(hrIdSchema, id),
    );
  }
}
