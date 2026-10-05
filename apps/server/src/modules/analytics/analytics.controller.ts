import { BadRequestException, Body, Controller, Get, Post, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { RequireAbility } from '../../platform/auth/abilities.js';
import { requireContext } from '../../platform/http/context.js';
import { mapAnalyticsErrors } from './analytics.errors.js';
import {
  dashboardQuerySchema,
  exportQuerySchema,
  monthQuerySchema,
  refreshSchema,
} from './analytics.schemas.js';
import { AnalyticsService } from './analytics.service.js';

function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message);
  return parsed.data;
}

const auditable = (request: FastifyRequest): AuditableRequest =>
  request as unknown as AuditableRequest;

/**
 * Analytics over HTTP (architecture §18; M24).
 *
 * **`Dashboard`** (D-325): the brand's own dashboard, insights, narrative, export and rollup
 * refresh — org_admin at `org`. Nothing here compares brands: a brand's ERP runs on its own
 * database and knows no other (D-469); the combined figures and the leaderboard left with
 * M31 (D-471).
 */
@Controller('v1/analytics')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @RequireAbility('read', 'Dashboard')
  @Get('dashboard')
  async dashboard(@Req() request: FastifyRequest, @Query() query: unknown) {
    const parsed = parse(dashboardQuerySchema, query ?? {});
    return mapAnalyticsErrors(() => this.analytics.dashboard(requireContext(request), parsed));
  }

  @RequireAbility('read', 'Dashboard')
  @Get('insights')
  async insights(@Req() request: FastifyRequest, @Query() query: unknown) {
    const parsed = parse(monthQuerySchema, query ?? {});
    return mapAnalyticsErrors(() => this.analytics.insights(requireContext(request), parsed));
  }

  @RequireAbility('read', 'Dashboard')
  @Get('narrative')
  async narrative(@Req() request: FastifyRequest, @Query() query: unknown) {
    const parsed = parse(monthQuerySchema, query ?? {});
    return mapAnalyticsErrors(() => this.analytics.narrative(requireContext(request), parsed));
  }

  @RequireAbility('update', 'Dashboard')
  @Post('rollups/refresh')
  async refresh(@Req() request: FastifyRequest, @Body() body: unknown) {
    const input = parse(refreshSchema, body);
    return mapAnalyticsErrors(() =>
      this.analytics.refresh(requireContext(request), auditable(request), input),
    );
  }

  @RequireAbility('read', 'Dashboard')
  @Get('export')
  async export(
    @Req() request: FastifyRequest,
    @Query() query: unknown,
    @Res() reply: FastifyReply,
  ) {
    const parsed = parse(exportQuerySchema, query ?? {});
    const file = await mapAnalyticsErrors(() =>
      this.analytics.export(requireContext(request), auditable(request), parsed),
    );
    await reply
      .header('content-type', file.contentType)
      .header('content-disposition', `attachment; filename="${file.filename}"`)
      .header('x-row-count', String(file.rows))
      .header('cache-control', 'no-store')
      .send(file.bytes);
  }
}
