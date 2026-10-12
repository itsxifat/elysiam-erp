import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { inboxCallAnswerSchema, inboxVoiceSchema } from '@elysium/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { RequireAbility } from '../../platform/auth/abilities.js';
import { scopeHasNoRowDimension } from '../../platform/auth/scope.js';
import { requireContext } from '../../platform/http/context.js';
import { InboxCallsService } from './calls.service.js';
import { InboxMediaService } from './media.service.js';
import { acknowledgedIn } from './ownership.js';

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
 * Voice messages and calls over HTTP (M45, D-780 to D-788), under M42's abilities (D-736):
 * `read Conversation` to play a kept voice message or picture and to see calls, `update
 * Conversation` to send a voice message and to pick up, answer, decline or hang up a call. A
 * voice message and a call-back on someone else's conversation need `x-acknowledge-owner: 1`,
 * like every inbox write (D-737); answering a call that rang for you does not (D-785).
 */
@Controller('v1/inbox')
export class VoiceCallsController {
  constructor(
    private readonly media: InboxMediaService,
    private readonly calls: InboxCallsService,
  ) {}

  /**
   * A kept voice message or picture, to a person who reads the inbox: the bytes, not JSON, so
   * `@Res()` and a manual send (the serializer has nothing to strip: no cost reaches a recording).
   * Private and cached briefly in the browser only; never sniffed as anything else.
   */
  @RequireAbility('read', 'Conversation')
  @Get('media/:fileId')
  async mediaFile(
    @Req() request: FastifyRequest,
    @Param('fileId') fileId: string,
    @Res() reply: FastifyReply,
  ) {
    const bytes = await this.media.serve(requireContext(request), parse(idSchema, fileId));
    await reply
      .header('content-type', bytes.mime)
      .header('content-length', String(bytes.bytes.byteLength))
      .header('cache-control', 'private, max-age=300')
      .header('x-content-type-options', 'nosniff')
      .header('content-disposition', 'inline')
      .send(Buffer.from(bytes.bytes));
  }

  /** A recorded voice message: refused outside the 24-hour window, sent by a job (D-781). */
  @RequireAbility('update', 'Conversation')
  @Post('conversations/:id/voice')
  async voice(@Req() request: FastifyRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.media.sendVoiceMessage(
      requireContext(request),
      auditable(request),
      parse(idSchema, id),
      parse(inboxVoiceSchema, body),
      acknowledgedIn(request.headers),
    );
  }

  /** The calls ringing for the caller, and the one they are on (the call bar). */
  @RequireAbility('read', 'Conversation')
  @Get('calls/live')
  async live(@Req() request: FastifyRequest) {
    scopeHasNoRowDimension(request, 'the caller’s own ringing calls, by their user id');
    return this.calls.live(requireContext(request));
  }

  @RequireAbility('read', 'Conversation')
  @Get('calls/:id')
  async call(@Req() request: FastifyRequest, @Param('id') id: string) {
    return this.calls.one(requireContext(request), parse(idSchema, id));
  }

  /** Pick a ringing call up: one agent wins; WhatsApp's SDP offer goes to them alone. */
  @RequireAbility('update', 'Conversation')
  @Post('calls/:id/claim')
  @HttpCode(200)
  async claim(@Req() request: FastifyRequest, @Param('id') id: string) {
    return this.calls.claim(requireContext(request), auditable(request), parse(idSchema, id));
  }

  /** The browser's session for Meta: `pre_accept`, then `accept` (D-787). */
  @RequireAbility('update', 'Conversation')
  @Post('calls/:id/answer')
  @HttpCode(200)
  async answer(@Req() request: FastifyRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.calls.answer(
      requireContext(request),
      auditable(request),
      parse(idSchema, id),
      parse(inboxCallAnswerSchema, body),
    );
  }

  @RequireAbility('update', 'Conversation')
  @Post('calls/:id/release')
  @HttpCode(200)
  async release(@Req() request: FastifyRequest, @Param('id') id: string) {
    return this.calls.release(requireContext(request), auditable(request), parse(idSchema, id));
  }

  @RequireAbility('update', 'Conversation')
  @Post('calls/:id/decline')
  @HttpCode(200)
  async decline(@Req() request: FastifyRequest, @Param('id') id: string) {
    return this.calls.decline(requireContext(request), auditable(request), parse(idSchema, id));
  }

  @RequireAbility('update', 'Conversation')
  @Post('calls/:id/hang-up')
  @HttpCode(200)
  async hangUp(@Req() request: FastifyRequest, @Param('id') id: string) {
    return this.calls.hangUp(requireContext(request), auditable(request), parse(idSchema, id));
  }

  /** A missed call dealt with: the call-back item closes (D-788). */
  @RequireAbility('update', 'Conversation')
  @Post('calls/:id/callback-done')
  @HttpCode(200)
  async callbackDone(@Req() request: FastifyRequest, @Param('id') id: string) {
    return this.calls.callbackDone(
      requireContext(request),
      auditable(request),
      parse(idSchema, id),
      acknowledgedIn(request.headers),
    );
  }
}
