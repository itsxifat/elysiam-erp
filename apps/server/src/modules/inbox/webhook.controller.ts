import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { AuditExempt } from '../../platform/audit/audit.interceptor.js';
import { Public } from '../../platform/auth/abilities.js';
import { metaRawBodyOf } from './raw-body.js';
import { InboxWebhookService } from './webhook.service.js';

const SIGNED =
  'Meta has no session: each event notification carries X-Hub-Signature-256, an HMAC-SHA256 of the raw body under the brand’s sealed app secret, checked before anything is stored; the subscription check compares the brand’s sealed verify token (D-732).';
const RECORDED =
  'No person acts: the body is stored in inbox.webhook_events and threaded by inbox.process_webhook, whose rows (messages, conversations) are the record.';

/**
 * Meta's webhooks for the brand's inbox (M42, D-732): one public address per brand,
 * `/webhooks/meta/<org id>`, for Messenger, Instagram and WhatsApp alike. The brand is in the
 * path, as ncom's and the courier's webhooks have it; authenticity is the signature. The nginx
 * site forwards `/webhooks/` to the API (`infra/brand/nginx-brand.conf`).
 */
@Controller('webhooks/meta')
export class MetaWebhookController {
  constructor(private readonly webhooks: InboxWebhookService) {}

  /** Meta's subscription check: echo `hub.challenge` when the verify token matches. */
  @Public(SIGNED)
  @Get(':orgId')
  async verify(
    @Param('orgId') orgId: string,
    @Query() query: Record<string, unknown>,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const challenge = await this.webhooks.verifySubscription(orgId, query);
    await reply
      .status(200)
      .header('content-type', 'text/plain; charset=utf-8')
      .header('cache-control', 'no-store')
      .send(challenge);
  }

  /**
   * An event notification. 200 for a body stored or already stored (Meta retries anything else,
   * for up to 36 hours), 401 for a bad signature.
   */
  @Public(SIGNED)
  @AuditExempt(RECORDED)
  @Post(':orgId')
  @HttpCode(200)
  async receive(
    @Req() request: FastifyRequest,
    @Param('orgId') orgId: string,
    @Body() body: unknown,
  ) {
    const signature = request.headers['x-hub-signature-256'];
    return this.webhooks.accept(
      orgId,
      metaRawBodyOf(request),
      typeof signature === 'string' ? signature : undefined,
      body,
    );
  }
}
