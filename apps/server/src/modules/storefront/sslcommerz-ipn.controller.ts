import { Controller, HttpCode, Inject, Param, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';

import { AuditExempt } from '../../platform/audit/audit.interceptor.js';
import { Public } from '../../platform/auth/abilities.js';
import type { RateLimitStore } from '../../platform/http/rate-limit.js';
import { createLogger } from '../../platform/logging/logger.js';
import { PaymentsService } from './payments.service.js';
import { STOREFRONT_RATE_LIMITER } from './signature.guard.js';

const ORG_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * SSLCommerz's IPN (M34, D-525): `POST /storefront/ipn/sslcommerz/<org id>`, the `ipn_url` each
 * session names.
 *
 * Public, because SSLCommerz's servers post it and sign nothing a website key could check. So
 * nothing in it is believed: the handler looks only for a transaction id that is one of the
 * brand's sessions and the `val_id` beside it, and hands those to the worker, which asks
 * SSLCommerz's Order Validation API and accepts only what that says (amount, currency,
 * transaction). Every answer is the same 200, so a prober learns nothing about which
 * transactions exist; addresses are rate-limited first. The brand is in the path because the
 * request has no other way to name its tenant under FORCE RLS (the media path's arrangement).
 */
@Controller('storefront/ipn')
export class SslcommerzIpnController {
  private cachedLogger: Logger | undefined;

  private get logger(): Logger {
    this.cachedLogger ??= createLogger('storefront');
    return this.cachedLogger;
  }

  constructor(
    private readonly payments: PaymentsService,
    @Inject(STOREFRONT_RATE_LIMITER) private readonly limiter: RateLimitStore,
  ) {}

  @Public(
    'SSLCommerz posts its IPN unsigned; nothing in it is trusted, and a payment is accepted only on what the Order Validation API answers (D-525).',
  )
  @AuditExempt(
    'Enqueues a validation; the payment session, the advance and its journal are the record.',
  )
  @Post('sslcommerz/:orgId')
  @HttpCode(200)
  async ipn(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Param('orgId') orgId: string,
  ) {
    const decision = await this.limiter.hit(`storefront:ipn:${request.ip}`, 120, 60);
    if (!decision.allowed) {
      void reply.status(429).header('retry-after', String(decision.retryAfterSeconds ?? 60));
      return { received: false };
    }
    const body = request.body;
    if (ORG_ID.test(orgId) && typeof body === 'object' && body !== null) {
      const fields = Object.fromEntries(
        Object.entries(body as Record<string, unknown>).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      );
      try {
        await this.payments.ipn(orgId.toLowerCase(), fields);
      } catch (error) {
        this.logger.error(
          { err: error instanceof Error ? error.message : String(error) },
          'an IPN could not be queued',
        );
      }
    }
    return { received: true };
  }
}
