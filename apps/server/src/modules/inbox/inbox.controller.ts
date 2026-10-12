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
  Query,
  Req,
} from '@nestjs/common';
import {
  INBOX_CHANNEL_KINDS,
  inboxAddressSchema,
  inboxChannelUpdateSchema,
  inboxHandOverSchema,
  inboxInterestSchema,
  inboxListQuerySchema,
  inboxMetaAppSchema,
  inboxNoteSchema,
  inboxPhoneFlagsQuerySchema,
  inboxPhoneSchema,
  inboxReplySchema,
  inboxStageSchema,
  inboxTagsSchema,
  inboxThreadQuerySchema,
} from '@elysium/contracts';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { RequireAbility } from '../../platform/auth/abilities.js';
import { requireContext } from '../../platform/http/context.js';
import { InboxChannelsService } from './channels.service.js';
import { ConversationOffersService } from './conversation-offers.service.js';
import { ConversationsService } from './conversations.service.js';
import { acknowledgedIn } from './ownership.js';
import { ContactPanelService } from './panel.service.js';

const idSchema = z.string().uuid('No such record.');
const kindSchema = z.enum(INBOX_CHANNEL_KINDS);

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
const acknowledged = (request: FastifyRequest): boolean => acknowledgedIn(request.headers);

/**
 * The unified inbox over HTTP (M42, D-730 to D-749).
 *
 * `read Conversation` for every read and `update Conversation` for every write, held by sales and
 * org_admin across the brand (D-736). A write on a conversation someone else has needs
 * `x-acknowledge-owner: 1` (D-737); without it the answer is 409 `INBOX_OWNER_ACK_REQUIRED`.
 * The panel's writes go through the conversation, so the rule covers them as well. The brand's
 * Meta channels are `read`/`update InboxChannel` (org_admin).
 */
@Controller('v1/inbox')
export class InboxController {
  constructor(
    private readonly conversations: ConversationsService,
    private readonly panel: ContactPanelService,
    private readonly channels: InboxChannelsService,
    private readonly offers: ConversationOffersService,
  ) {}

  @RequireAbility('read', 'Conversation')
  @Get('conversations')
  async list(@Req() request: FastifyRequest, @Query() query: unknown) {
    return this.conversations.list(
      requireContext(request),
      parse(inboxListQuerySchema, query ?? {}),
    );
  }

  @RequireAbility('read', 'Conversation')
  @Get('conversations/:id')
  async thread(@Req() request: FastifyRequest, @Param('id') id: string, @Query() query: unknown) {
    return this.conversations.thread(
      requireContext(request),
      parse(idSchema, id),
      parse(inboxThreadQuerySchema, query ?? {}),
    );
  }

  @RequireAbility('read', 'Conversation')
  @Get('conversations/:id/panel')
  async contactPanel(@Req() request: FastifyRequest, @Param('id') id: string) {
    return this.panel.panel(requireContext(request), parse(idSchema, id));
  }

  /** The order desk's new-order form, prefilled from the chat (D-742). */
  @RequireAbility('read', 'Conversation')
  @Get('conversations/:id/order-draft')
  async orderDraft(@Req() request: FastifyRequest, @Param('id') id: string) {
    return this.panel.orderDraft(requireContext(request), parse(idSchema, id));
  }

  /** M44a (D-764): unread counts for the tab's title: the caller's own and nobody's. */
  @RequireAbility('read', 'Conversation')
  @Get('unread')
  async unread(@Req() request: FastifyRequest) {
    return this.conversations.unread(requireContext(request));
  }

  /** Who a conversation can be handed to. */
  @RequireAbility('read', 'Conversation')
  @Get('team')
  async team(@Req() request: FastifyRequest) {
    return this.conversations.team(requireContext(request));
  }

  /** The order desk's fraud warning for a phone (D-738). */
  @RequireAbility('read', 'Conversation')
  @Get('phone-flags')
  async phoneFlags(@Req() request: FastifyRequest, @Query() query: unknown) {
    const { phone } = parse(inboxPhoneFlagsQuerySchema, query ?? {});
    return this.panel.phoneFlags(requireContext(request), phone);
  }

  // --- D-748: auto-offer, the person's card ----------------------------------------------------

  /** The caller's live conversation offers: contact, channel, last message and the countdown. */
  @RequireAbility('read', 'Conversation')
  @Get('offers/mine')
  async myOffers(@Req() request: FastifyRequest) {
    return this.offers.mine(requireContext(request), request);
  }

  @RequireAbility('update', 'Conversation')
  @Post('offers/:id/accept')
  async acceptOffer(@Req() request: FastifyRequest, @Param('id') id: string) {
    return this.offers.accept(requireContext(request), auditable(request), parse(idSchema, id));
  }

  @RequireAbility('update', 'Conversation')
  @Post('offers/:id/decline')
  async declineOffer(@Req() request: FastifyRequest, @Param('id') id: string) {
    return this.offers.decline(requireContext(request), auditable(request), parse(idSchema, id));
  }

  // --- ownership and status -----------------------------------------------------------------

  @RequireAbility('update', 'Conversation')
  @Post('conversations/:id/take')
  @HttpCode(200)
  async take(@Req() request: FastifyRequest, @Param('id') id: string) {
    return this.conversations.take(
      requireContext(request),
      auditable(request),
      parse(idSchema, id),
      acknowledged(request),
    );
  }

  @RequireAbility('update', 'Conversation')
  @Post('conversations/:id/release')
  @HttpCode(200)
  async release(@Req() request: FastifyRequest, @Param('id') id: string) {
    return this.conversations.release(
      requireContext(request),
      auditable(request),
      parse(idSchema, id),
      acknowledged(request),
    );
  }

  @RequireAbility('update', 'Conversation')
  @Post('conversations/:id/hand-over')
  @HttpCode(200)
  async handOver(@Req() request: FastifyRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.conversations.handOver(
      requireContext(request),
      auditable(request),
      parse(idSchema, id),
      parse(inboxHandOverSchema, body),
      acknowledged(request),
    );
  }

  @RequireAbility('update', 'Conversation')
  @Post('conversations/:id/close')
  @HttpCode(200)
  async close(@Req() request: FastifyRequest, @Param('id') id: string) {
    return this.conversations.setStatus(
      requireContext(request),
      auditable(request),
      parse(idSchema, id),
      'closed',
      acknowledged(request),
    );
  }

  @RequireAbility('update', 'Conversation')
  @Post('conversations/:id/reopen')
  @HttpCode(200)
  async reopen(@Req() request: FastifyRequest, @Param('id') id: string) {
    return this.conversations.setStatus(
      requireContext(request),
      auditable(request),
      parse(idSchema, id),
      'open',
      acknowledged(request),
    );
  }

  @RequireAbility('update', 'Conversation')
  @Post('conversations/:id/read')
  @HttpCode(200)
  async markRead(@Req() request: FastifyRequest, @Param('id') id: string) {
    return this.conversations.markRead(
      requireContext(request),
      auditable(request),
      parse(idSchema, id),
    );
  }

  /** A reply: refused outside the 24-hour window, sent by a job after the commit (D-734). */
  @RequireAbility('update', 'Conversation')
  @Post('conversations/:id/messages')
  async reply(@Req() request: FastifyRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.conversations.reply(
      requireContext(request),
      auditable(request),
      parse(idSchema, id),
      parse(inboxReplySchema, body),
      acknowledged(request),
    );
  }

  // --- the contact panel ----------------------------------------------------------------------

  @RequireAbility('update', 'Conversation')
  @Put('conversations/:id/contact/phone')
  async savePhone(@Req() request: FastifyRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.panel.savePhone(
      requireContext(request),
      auditable(request),
      parse(idSchema, id),
      parse(inboxPhoneSchema, body),
      acknowledged(request),
    );
  }

  @RequireAbility('update', 'Conversation')
  @Put('conversations/:id/contact/address')
  async saveAddress(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.panel.saveAddress(
      requireContext(request),
      auditable(request),
      parse(idSchema, id),
      parse(inboxAddressSchema, body),
      acknowledged(request),
    );
  }

  @RequireAbility('update', 'Conversation')
  @Put('conversations/:id/contact/stage')
  async setStage(@Req() request: FastifyRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.panel.setStage(
      requireContext(request),
      auditable(request),
      parse(idSchema, id),
      parse(inboxStageSchema, body),
      acknowledged(request),
    );
  }

  @RequireAbility('update', 'Conversation')
  @Put('conversations/:id/contact/tags')
  async setTags(@Req() request: FastifyRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.panel.setTags(
      requireContext(request),
      auditable(request),
      parse(idSchema, id),
      parse(inboxTagsSchema, body),
      acknowledged(request),
    );
  }

  @RequireAbility('update', 'Conversation')
  @Post('conversations/:id/notes')
  async addNote(@Req() request: FastifyRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.panel.addNote(
      requireContext(request),
      auditable(request),
      parse(idSchema, id),
      parse(inboxNoteSchema, body),
      acknowledged(request),
    );
  }

  @RequireAbility('update', 'Conversation')
  @Post('conversations/:id/interests')
  async addInterest(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.panel.addInterest(
      requireContext(request),
      auditable(request),
      parse(idSchema, id),
      parse(inboxInterestSchema, body),
      acknowledged(request),
    );
  }

  @RequireAbility('update', 'Conversation')
  @Delete('conversations/:id/interests/:interestId')
  async removeInterest(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Param('interestId') interestId: string,
  ) {
    return this.panel.removeInterest(
      requireContext(request),
      auditable(request),
      parse(idSchema, id),
      parse(idSchema, interestId),
      acknowledged(request),
    );
  }

  // --- Settings → Inbox ---------------------------------------------------------------------

  @RequireAbility('read', 'InboxChannel')
  @Get('channels')
  async listChannels(@Req() request: FastifyRequest) {
    return this.channels.list(requireContext(request));
  }

  @RequireAbility('update', 'InboxChannel')
  @Put('channels/:kind')
  async saveChannel(
    @Req() request: FastifyRequest,
    @Param('kind') kind: string,
    @Body() body: unknown,
  ) {
    return this.channels.saveChannel(
      requireContext(request),
      auditable(request),
      parse(kindSchema, kind),
      parse(inboxChannelUpdateSchema, body),
    );
  }

  @RequireAbility('update', 'InboxChannel')
  @Put('meta-app')
  async saveApp(@Req() request: FastifyRequest, @Body() body: unknown) {
    return this.channels.saveApp(
      requireContext(request),
      auditable(request),
      parse(inboxMetaAppSchema, body),
    );
  }
}
