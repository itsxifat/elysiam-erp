import { BadRequestException, Body, Controller, HttpCode, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { ALREADY_AUDITED, type AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { Public } from '../../platform/auth/abilities.js';
import { instanceOf, problemFor, PROBLEM_CONTENT_TYPE } from '../../platform/http/problem.js';
import { trackingRequestSchema } from './courier.schemas.js';
import { TrackingService } from './tracking.service.js';

/**
 * The public tracking page's one endpoint (M15).
 *
 * `POST /v1/track` rather than a `GET` with the digits in the query string: a query string
 * lands in access logs, proxy logs and browser history, and four digits of a phone number
 * plus the order number they unlock are exactly the pair invariant 10 keeps out of logs.
 *
 * `@Public`, so it is in no route-matrix manifest — there is no role to vary. It reads no
 * session and grants nothing from a cookie; what authorises an answer is knowing the phone's
 * last four digits, checked in the service.
 *
 * Every non-match answers **200** with the same body (`TRACKING_NOT_FOUND`), never a 404: a
 * 404 would carry problem+json with the request's own path and id in it, and two misses would
 * then not even be byte-identical to each other. Only two answers differ, and neither says
 * anything about an order: a 400 for a body that is not the right shape at all, and a 429
 * when the rate limit is spent, which is counted the same whether the order exists or not.
 */
@Controller('v1/track')
export class TrackingController {
  constructor(private readonly tracking: TrackingService) {}

  @Public(
    'A buyer tracking their parcel has no account; the last four digits of the order’s phone are what authorise an answer (M15).',
  )
  @Post()
  @HttpCode(200)
  async track(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    /*
     * A read, sent as a `POST` only to keep the digits out of URLs. The audit interceptor
     * treats every successful `POST` as a mutation and, finding no org on a public request,
     * logs an error that a mutation escaped the audit log — once per tracking lookup. There is
     * no mutation to audit, so this says so, the way a service that audits itself does.
     */
    (request as unknown as AuditableRequest)[ALREADY_AUDITED] = true;

    const parsed = trackingRequestSchema.safeParse(body);
    if (!parsed.success) {
      // About the shape of the body, identical for every order: not an oracle.
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'Send the brand, the order number and the last four digits of the phone.',
      });
    }

    const result = await this.tracking.track({ ...parsed.data, ip: request.ip });
    if (result.limited) {
      void reply
        .status(429)
        .header('retry-after', String(result.retryAfterSeconds))
        .header('content-type', PROBLEM_CONTENT_TYPE);
      return problemFor({
        status: 429,
        code: 'RATE_LIMITED',
        detail: 'Too many attempts. Wait a few minutes and try again.',
        instance: instanceOf(request.url),
      });
    }

    // Nothing about this answer may be cached by anything between here and the buyer.
    void reply.header('cache-control', 'no-store');
    return result.answer;
  }
}
