import { BadRequestException, Controller, Get, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import { RequireAbility } from '../auth/abilities.js';
import { requireContext } from '../http/context.js';
import { failedJobsQuerySchema } from './failed-jobs.schema.js';
import { FailedJobsService } from './failed-jobs.service.js';

/**
 * What the queue gave up on (architecture §20, §23).
 *
 * `read AuditLog` rather than a new subject. §6's matrix gives it to org_admin
 * at org scope and to nobody else, which is exactly the audience for this: a
 * failed job is a record of something the system tried and could not do, read by
 * the person accountable for the org. Inventing `Job` as a subject would mean a
 * new row in the matrix and in `spec-6.fixture.ts` granting the same role the
 * same scope under a second name — two things to keep in step for no extra
 * decision anyone can make differently.
 */
@Controller('v1/jobs')
export class FailedJobsController {
  constructor(private readonly failedJobs: FailedJobsService) {}

  @RequireAbility('read', 'AuditLog')
  @Get('failed')
  async list(@Req() request: FastifyRequest, @Query() query: unknown) {
    const parsed = failedJobsQuerySchema.safeParse(query ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message);

    return this.failedJobs.list(requireContext(request), parsed.data);
  }
}
