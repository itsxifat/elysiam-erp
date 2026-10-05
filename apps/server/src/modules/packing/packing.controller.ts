import { BadRequestException, Body, Controller, HttpCode, Post, Req, Res } from '@nestjs/common';
import { orderLabelsSchema } from '@elysium/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { AuditExempt } from '../../platform/audit/audit.interceptor.js';
import { RequireAbility } from '../../platform/auth/abilities.js';
import { requireContext } from '../../platform/http/context.js';
import { OrderLabelsService } from './order-labels.service.js';

/**
 * The orders list's label sheet (M35b, D-555): a `POST` because the order ids and the options
 * are a body, and `@Res()` because the answer is a PDF. Rendering changes nothing, and the
 * service applies the caller's §6 scope to every order before reading it.
 */
@Controller('v1/packing')
export class PackingController {
  constructor(private readonly labels: OrderLabelsService) {}

  @RequireAbility('read', 'Order')
  @AuditExempt('Rendering labels reads orders and writes nothing.')
  @Post('labels')
  @HttpCode(200)
  async labelsPdf(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const parsed = orderLabelsSchema.safeParse(body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message:
          issue === undefined
            ? 'That is not valid.'
            : `${issue.path.join('.') || 'body'}: ${issue.message}`,
      });
    }
    const rendered = await this.labels.render(requireContext(request), request, parsed.data);
    await reply
      .header('content-type', 'application/pdf')
      .header('content-disposition', `inline; filename="${rendered.filename}"`)
      .send(Buffer.from(rendered.bytes));
  }
}
