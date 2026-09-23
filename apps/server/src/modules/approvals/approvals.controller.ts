import { BadRequestException, Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import { approvalDecisionSchema, approvalRequestSchema } from '@elysium/contracts';
import type { FastifyRequest } from 'fastify';

import { markAudited } from '../../platform/audit/audit.interceptor.js';
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
    return this.approvals.list(requireContext(request));
  }

  @RequireAbility('request', 'ApprovalRequest')
  @Post()
  async request(@Req() request: FastifyRequest, @Body() body: unknown) {
    const parsed = approvalRequestSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message);

    // The service writes its own entry inside the mutation's transaction,
    // which the interceptor cannot do. Marked so the net does not duplicate it.
    markAudited(request);

    return this.approvals.request(requireContext(request), {
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
  @Post(':id/decide')
  async decide(@Req() request: FastifyRequest, @Param('id') id: string, @Body() body: unknown) {
    const parsed = approvalDecisionSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message);

    markAudited(request);

    return this.approvals.decide(requireContext(request), {
      id,
      decision: parsed.data.decision,
      ...(parsed.data.note === undefined ? {} : { note: parsed.data.note }),
    });
  }
}
