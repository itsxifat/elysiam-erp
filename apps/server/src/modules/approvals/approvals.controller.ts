import { BadRequestException, Body, Controller, Get, Param, Post, Put, Req } from '@nestjs/common';
import {
  approvalDecisionSchema,
  approvalIdSchema,
  approvalRequestSchema,
  thresholdSchema,
} from '@elysium/contracts';
import type { FastifyRequest } from 'fastify';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { RequireAbility } from '../../platform/auth/abilities.js';
import { requireContext } from '../../platform/http/context.js';
import { ApprovalsService } from './approvals.service.js';

/** Maker-checker over HTTP (architecture §6). */
@Controller('v1/approvals')
export class ApprovalsController {
  constructor(private readonly approvals: ApprovalsService) {}

  @RequireAbility('read', 'ApprovalRequest')
  @Get()
  async list(@Req() request: FastifyRequest) {
    return this.approvals.list(requireContext(request), request);
  }

  /**
   * One request as a checker decides it: its frozen terms, including what a
   * threshold change would do. Same scope and relevance as the list.
   */
  @RequireAbility('read', 'ApprovalRequest')
  @Get(':id')
  async get(@Req() request: FastifyRequest, @Param('id') id: string) {
    const parsedId = approvalIdSchema.safeParse(id);
    if (!parsedId.success) throw new BadRequestException(parsedId.error.issues[0]?.message);
    return this.approvals.get(requireContext(request), request, parsedId.data);
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
      ...(parsed.data.branchId === undefined ? {} : { branchId: parsed.data.branchId }),
    });
  }

  /**
   * Set this org's threshold for one approval type.
   *
   * org_admin only, through the matrix (`update ApprovalThreshold`): whoever
   * sets a threshold decides which requests skip the second person.
   */
  @RequireAbility('update', 'ApprovalThreshold')
  @Put('thresholds')
  async setThreshold(@Req() request: FastifyRequest, @Body() body: unknown) {
    const parsed = thresholdSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message);

    return this.approvals.setThreshold(requireContext(request), {
      request: request as unknown as AuditableRequest,
      type: parsed.data.type,
      thresholdPoisha: BigInt(parsed.data.thresholdPoisha),
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
  @Post(':id/decide')
  async decide(@Req() request: FastifyRequest, @Param('id') id: string, @Body() body: unknown) {
    // A malformed id reached PostgreSQL's uuid parser and came back as a 500.
    const parsedId = approvalIdSchema.safeParse(id);
    if (!parsedId.success) throw new BadRequestException(parsedId.error.issues[0]?.message);

    const parsed = approvalDecisionSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message);

    return this.approvals.decide(requireContext(request), {
      request: request as unknown as AuditableRequest,
      id: parsedId.data,
      decision: parsed.data.decision,
      ...(parsed.data.note === undefined ? {} : { note: parsed.data.note }),
    });
  }
}
