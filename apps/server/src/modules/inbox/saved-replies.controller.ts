import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import { savedReplyInputSchema } from '@elysium/contracts';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { RequireAbility } from '../../platform/auth/abilities.js';
import { requireContext } from '../../platform/http/context.js';
import { SavedRepliesService } from './saved-replies.service.js';

const idSchema = z.string().uuid('No such record.');

function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
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
  return parsed.data;
}

const auditable = (request: FastifyRequest): AuditableRequest =>
  request as unknown as AuditableRequest;

/**
 * The inbox's saved replies over HTTP (M44a, D-763). Everyone who answers the inbox reads them
 * and counts a use (`read SavedReply`: sales, org_admin); the inbox's supervisor writes them
 * (`create`, `update`, `delete SavedReply`: org_admin). Settings → Inbox → Saved replies is the
 * screen; the composer's `/` picker and the quick-reply row read the list.
 */
@Controller('v1/inbox/saved-replies')
export class SavedRepliesController {
  constructor(private readonly savedReplies: SavedRepliesService) {}

  @RequireAbility('read', 'SavedReply')
  @Get()
  async list(@Req() request: FastifyRequest) {
    return this.savedReplies.list(requireContext(request));
  }

  @RequireAbility('create', 'SavedReply')
  @Post()
  async create(@Req() request: FastifyRequest, @Body() body: unknown) {
    return this.savedReplies.create(
      requireContext(request),
      auditable(request),
      parse(savedReplyInputSchema, body),
    );
  }

  @RequireAbility('update', 'SavedReply')
  @Put(':id')
  async update(@Req() request: FastifyRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.savedReplies.update(
      requireContext(request),
      auditable(request),
      parse(idSchema, id),
      parse(savedReplyInputSchema, body),
    );
  }

  @RequireAbility('delete', 'SavedReply')
  @Delete(':id')
  async remove(@Req() request: FastifyRequest, @Param('id') id: string) {
    return this.savedReplies.remove(
      requireContext(request),
      auditable(request),
      parse(idSchema, id),
    );
  }

  /** Inserted into a reply: the usage count goes up (D-763). Nothing else changes. */
  @RequireAbility('read', 'SavedReply')
  @Post(':id/use')
  @HttpCode(200)
  async use(@Req() request: FastifyRequest, @Param('id') id: string) {
    return this.savedReplies.use(requireContext(request), parse(idSchema, id));
  }
}
