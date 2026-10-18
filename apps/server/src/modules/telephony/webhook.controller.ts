import { Body, Controller, HttpCode, Param, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import { AuditExempt } from '../../platform/audit/audit.interceptor.js';
import { Public } from '../../platform/auth/abilities.js';
import { envoRawBodyOf } from './raw-body.js';
import { TelephonyWebhookService } from './webhook.service.js';

const SIGNED =
  'Envo has no session: each delivery carries X-Envo-Signature, an HMAC-SHA256 of `${t}.${body}` under the connection’s sealed webhook secret, checked over the raw bytes and within five minutes before anything is stored (D-832).';
const RECORDED =
  'No person acts: the body is stored in telephony.webhook_events and applied by telephony.process_webhook, whose rows (telephony.calls) are the record.';

/**
 * Envo's webhooks (M47, D-832): one public address per connection,
 * `/webhooks/envo/<org id>/<connection id>`, pasted into the Envo webhook's URL. The brand and
 * the connection are in the path, as M42's Meta webhook has the brand; authenticity is the
 * signature. The brands' nginx already forwards `/webhooks/` to the API.
 */
@Controller('webhooks/envo')
export class EnvoWebhookController {
  constructor(private readonly webhooks: TelephonyWebhookService) {}

  /**
   * 200 for a body stored, already stored or deliberately ignored (Envo retries anything else
   * twice, within about twenty seconds), 401 for a bad, missing or old signature.
   */
  @Public(SIGNED)
  @AuditExempt(RECORDED)
  @Post(':orgId/:connectionId')
  @HttpCode(200)
  async receive(
    @Req() request: FastifyRequest,
    @Param('orgId') orgId: string,
    @Param('connectionId') connectionId: string,
    @Body() body: unknown,
  ) {
    const signature = request.headers['x-envo-signature'];
    const delivery = request.headers['x-envo-delivery'];
    return this.webhooks.accept(
      orgId,
      connectionId,
      envoRawBodyOf(request),
      typeof signature === 'string' ? signature : undefined,
      typeof delivery === 'string' ? delivery : undefined,
      body,
    );
  }
}
