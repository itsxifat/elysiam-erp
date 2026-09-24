import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  NotFoundException,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import {
  approvalDecisionSchema,
  approvalListSchema,
  approvalRequestSchema,
  thresholdSchema,
} from '@elysium/contracts';
import type { FastifyRequest } from 'fastify';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { RequireAbility } from '../../platform/auth/abilities.js';
import { requireContext } from '../../platform/http/context.js';
import { ApprovalsService } from './approvals.service.js';

/** A uuid, so a malformed path parameter never reaches a uuid column. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Maker-checker over HTTP (architecture §6). */
@Controller('v1/approvals')
export class ApprovalsController {
  constructor(private readonly approvals: ApprovalsService) {}

  @RequireAbility('read', 'ApprovalRequest')
  @Get()
  async list(@Req() request: FastifyRequest, @Query() query: unknown) {
    // §23: cursor pagination and Zod-validated filters. The list used to
    // return the newest 100 and stop, so an older pending payment fell off the
    // end of the only endpoint that lists them.
    const parsed = approvalListSchema.safeParse(query ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message);

    return this.approvals.list(requireContext(request), parsed.data);
  }

  /*
   * Thresholds, declared before `:id/decide` and read under `Settings`.
   *
   * §6's last row is "Users, roles, **settings**", and until `Settings`
   * existed as a subject these numbers were governed by no rule anyone could
   * name — `setThreshold` had no route at all, which is one way of being safe
   * and not a very useful one. They decide when maker-checker applies and how
   * far a branch checker's authority runs, so they belong to the same role
   * that manages users, and nobody else.
   */
  @RequireAbility('read', 'Settings')
  @Get('thresholds')
  async thresholds(@Req() request: FastifyRequest) {
    return this.approvals.listThresholds(requireContext(request));
  }

  @RequireAbility('update', 'Settings')
  @Put('thresholds')
  async setThreshold(@Req() request: FastifyRequest, @Body() body: unknown) {
    const parsed = thresholdSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message);

    await this.approvals.setThreshold(requireContext(request), {
      request: request as unknown as AuditableRequest,
      type: parsed.data.type,
      thresholdPoisha: BigInt(parsed.data.thresholdPoisha),
    });
    return { type: parsed.data.type, thresholdPoisha: parsed.data.thresholdPoisha };
  }

  @RequireAbility('request', 'ApprovalRequest')
  @Post()
  async request(@Req() request: FastifyRequest, @Body() body: unknown) {
    const parsed = approvalRequestSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message);

    // The service writes its own entry inside the mutation's transaction, which
    // the interceptor cannot do; passing `request` is how the net learns that a
    // write actually happened and stands down.
    return this.approvals.request(requireContext(request), {
      request: request as unknown as AuditableRequest,
      type: parsed.data.type,
      amountPoisha: parsed.data.amountPoisha === null ? null : BigInt(parsed.data.amountPoisha),
      payload: parsed.data.payload,
      ...(parsed.data.reason === undefined ? {} : { reason: parsed.data.reason }),
    });
  }

  /**
   * Decide someone else's request.
   *
   * The `approve` ability gets you here; the maker≠checker rule then decides
   * whether it is *this* request you may decide. Two different questions, and
   * collapsing them into one would mean either nobody can approve anything or
   * everybody can approve their own.
   */
  @RequireAbility('approve', 'ApprovalRequest')
  // 200, not Nest's default 201 for a POST. Deciding creates nothing — it
  // changes the state of a request that already exists — and a client reading
  // 201 Created has been told something untrue about what just happened.
  @HttpCode(HttpStatus.OK)
  @Post(':id/decide')
  async decide(@Req() request: FastifyRequest, @Param('id') id: string, @Body() body: unknown) {
    // §23 wants problem+json, and `where id = 'nonsense'` against a uuid column
    // is a Postgres error and a 500. Refused here as a 404, which is also the
    // answer a request in another org gets — so this cannot become a way to
    // tell a malformed id from one that exists elsewhere.
    if (!UUID.test(id)) throw new NotFoundException('No such approval request.');

    const parsed = approvalDecisionSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message);

    return this.approvals.decide(requireContext(request), {
      request: request as unknown as AuditableRequest,
      id,
      decision: parsed.data.decision,
      ...(parsed.data.note === undefined ? {} : { note: parsed.data.note }),
    });
  }
}
