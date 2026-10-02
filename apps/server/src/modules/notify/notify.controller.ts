import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { z } from 'zod';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { RequireAbility } from '../../platform/auth/abilities.js';
import { requireContext } from '../../platform/http/context.js';
import { mapNotifyErrors } from './notify.errors.js';
import {
  messageListSchema,
  optOutPhoneParamSchema,
  optOutSchema,
  upsertTemplateSchema,
} from './notify.schemas.js';
import { NotifyService } from './notify.service.js';

function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message);
  return parsed.data;
}

const auditable = (request: FastifyRequest): AuditableRequest =>
  request as unknown as AuditableRequest;

/**
 * Notifications over HTTP (architecture §10, §23; M16).
 *
 * **The subject is `Campaign`** (D-205). §6 has no notifications row, and the obvious
 * subject, `Customer`, is the wrong one: sales holds it at `own` scope, and every route
 * here is org-wide — the delivery log lists every buyer's phone, the opt-out list is the
 * brand's — so admitting sales on `read Customer` would hand each agent the whole
 * brand's contact history. `Campaign` is held by org_admin and marketing, both at `org`,
 * which is exactly the audience for what a brand says to its buyers and when.
 *
 * Sending is not a route. A message is queued by the code that has a reason to send it —
 * an occasion, an order — through `NotifyApi`, inside its own transaction.
 */
@Controller('v1/notify')
export class NotifyController {
  constructor(private readonly notify: NotifyService) {}

  @RequireAbility('read', 'Campaign')
  @Get('templates')
  async listTemplates(@Req() request: FastifyRequest) {
    return mapNotifyErrors(() => this.notify.listTemplates(requireContext(request)));
  }

  /** Create or edit by key: saving `order.confirmed` twice edits one template. */
  @RequireAbility('update', 'Campaign')
  @Put('templates')
  async upsertTemplate(@Req() request: FastifyRequest, @Body() body: unknown) {
    const input = parse(upsertTemplateSchema, body);
    return mapNotifyErrors(() =>
      this.notify.upsertTemplate(requireContext(request), auditable(request), input),
    );
  }

  @RequireAbility('read', 'Campaign')
  @Get('opt-outs')
  async listOptOuts(@Req() request: FastifyRequest) {
    return mapNotifyErrors(() => this.notify.listOptOuts(requireContext(request)));
  }

  @RequireAbility('update', 'Campaign')
  @Post('opt-outs')
  async addOptOut(@Req() request: FastifyRequest, @Body() body: unknown) {
    const input = parse(optOutSchema, body);
    return mapNotifyErrors(() =>
      this.notify.addOptOut(requireContext(request), auditable(request), input),
    );
  }

  /** Opting back in is the buyer's right, so the row really goes (0078 grants DELETE). */
  @RequireAbility('update', 'Campaign')
  @Delete('opt-outs/:phone')
  async removeOptOut(@Req() request: FastifyRequest, @Param('phone') phone: string) {
    const value = parse(optOutPhoneParamSchema, phone);
    return mapNotifyErrors(() =>
      this.notify.removeOptOut(requireContext(request), auditable(request), value),
    );
  }

  @RequireAbility('read', 'Campaign')
  @Get('messages')
  async listMessages(@Req() request: FastifyRequest, @Query() query: unknown) {
    const filters = parse(messageListSchema, query);
    return mapNotifyErrors(() =>
      this.notify.listMessages(requireContext(request), {
        ...(filters.state === undefined ? {} : { state: filters.state }),
        limit: filters.limit,
      }),
    );
  }
}
