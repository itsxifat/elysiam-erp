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
import { AdvancesService } from './advances.service.js';
import {
  advanceQueueSchema,
  orderIdSchema,
  recordAdvanceSchema,
  refundAdvanceSchema,
  rejectAdvanceSchema,
  returnReasonReportSchema,
  verifyAdvanceSchema,
} from './orders.schemas.js';
import { ReturnReasonsService } from './returns.service.js';

function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message);
  return parsed.data;
}

const auditable = (request: FastifyRequest): AuditableRequest =>
  request as unknown as AuditableRequest;

/**
 * Advances and return reasons over HTTP (M17; architecture §6, §7, §9; D-235).
 *
 * The grants are the control D-013 describes:
 *
 * * **`update Order`** records a claim, on an order the caller may work (row scope). It
 *   posts nothing, so the agent who took the buyer's call is the right person to type it.
 * * **`create Wallet`** sees the queue and verifies, rejects or refunds. Verification is
 *   money arriving in a wallet and a journal posted against it (D-099), and `create Wallet`
 *   is accounts' (and super_admin's). The recorder can never verify their own claim.
 * * **`read Order`** reads an order's advances and the return-reason report, in the
 *   caller's order scope.
 */
@Controller('v1')
export class AdvancesController {
  constructor(
    private readonly advances: AdvancesService,
    private readonly returns: ReturnReasonsService,
  ) {}

  /** Declared before `orders/:id/...`; `GET /v1/orders/:id` is the orders controller's. */
  @RequireAbility('read', 'Order')
  @Get('orders/return-reasons')
  async returnReasons(@Req() request: FastifyRequest, @Query() query: unknown) {
    const parsed = parse(returnReasonReportSchema, query ?? {});
    return this.returns.report(requireContext(request), request, parsed.from, parsed.to);
  }

  @RequireAbility('read', 'Order')
  @Get('orders/:id/advances')
  async listForOrder(@Req() request: FastifyRequest, @Param('id') id: string) {
    return this.advances.listForOrder(requireContext(request), request, parse(orderIdSchema, id));
  }

  @RequireAbility('update', 'Order')
  @Post('orders/:id/advances')
  async record(@Req() request: FastifyRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.advances.record(
      requireContext(request),
      auditable(request),
      parse(orderIdSchema, id),
      parse(recordAdvanceSchema, body),
    );
  }

  @RequireAbility('create', 'Wallet')
  @Get('order-advances')
  async queue(@Req() request: FastifyRequest, @Query() query: unknown) {
    const parsed = parse(advanceQueueSchema, query ?? {});
    return this.advances.queue(requireContext(request), request, parsed.status);
  }

  @RequireAbility('create', 'Wallet')
  @Post('order-advances/:id/verify')
  async verify(@Req() request: FastifyRequest, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(verifyAdvanceSchema, body);
    return this.advances.verify(
      requireContext(request),
      auditable(request),
      parse(orderIdSchema, id),
      input.walletAccountId,
    );
  }

  @RequireAbility('create', 'Wallet')
  @Post('order-advances/:id/reject')
  async reject(@Req() request: FastifyRequest, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(rejectAdvanceSchema, body);
    return this.advances.reject(
      requireContext(request),
      auditable(request),
      parse(orderIdSchema, id),
      input.reason,
    );
  }

  @RequireAbility('create', 'Wallet')
  @Post('order-advances/:id/refund')
  async refund(@Req() request: FastifyRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.advances.refund(
      requireContext(request),
      auditable(request),
      parse(orderIdSchema, id),
      parse(refundAdvanceSchema, body ?? {}),
    );
  }
}
