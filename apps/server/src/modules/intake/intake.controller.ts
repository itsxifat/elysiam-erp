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
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { ALREADY_AUDITED } from '../../platform/audit/audit.interceptor.js';
import { Public, RequireAbility } from '../../platform/auth/abilities.js';
import { requireContext } from '../../platform/http/context.js';
import { IDEMPOTENCY_REPLAYED_HEADER } from '../../platform/http/idempotency.js';
import { IntakeError } from './intake.errors.js';
import { issueSiteKeySchema, siteKeyIdSchema } from './intake.schemas.js';
import { IntakeService } from './intake.service.js';
import { rawBodyOf } from './raw-body.js';

function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message);
  return parsed.data;
}

const auditable = (request: FastifyRequest): AuditableRequest =>
  request as unknown as AuditableRequest;

/**
 * The public order intake (architecture §23; M11 acceptance check 3).
 *
 * `@Public` because a landing page's server has no session. What authenticates it is the
 * site key and the HMAC over the raw body, checked in `IntakeService.receive` before
 * anything else in the request is read — see that method for the order of the checks.
 *
 * `passthrough` on the reply so the handler can set `Retry-After` and
 * `Idempotency-Replayed` and still return a body through the ordinary interceptors: the
 * serializer holds a public response to "no cost field, ever" like any other.
 */
@Controller('public/v1')
export class PublicIntakeController {
  constructor(private readonly intake: IntakeService) {}

  @Public(
    'A landing page has no session; the per-site key and the HMAC over the raw body are what authenticate it (§23).',
  )
  @Post('orders')
  @HttpCode(201)
  async receive(@Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    const raw = rawBodyOf(request);
    if (raw === undefined) {
      // The preParsing hook did not run for this request — a non-JSON content type that
      // Fastify refused to parse would have been answered before here, so this is a wiring
      // fault. Refusing is the only safe answer: there are no bytes to verify.
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'Send the order as application/json.',
      });
    }

    try {
      const outcome = await this.intake.receive(request, raw);
      if (outcome.replayed) {
        void reply.header(IDEMPOTENCY_REPLAYED_HEADER, 'true');
        // A replay changed nothing, so there is nothing to audit — and without this the
        // audit net would log a successful mutation with no org as a missing audit row.
        auditable(request)[ALREADY_AUDITED] = true;
      }
      return outcome.receipt;
    } catch (error) {
      if (error instanceof IntakeError) {
        if (error.retryAfter !== undefined) {
          void reply.header('retry-after', String(error.retryAfter));
        }
        throw error.toHttp();
      }
      throw error;
    }
  }
}

/**
 * Site keys, for the people who set up landing pages (M11).
 *
 * `LandingPage` is the subject because a key is a landing page's credential, and §6 already
 * says who owns landing pages: org_admin and marketing create and update them, sales and
 * branch managers only read. Issuing and revoking are `create` and `update`; listing is
 * `read`, which shows labels and public key ids and never a secret — there is none to show.
 *
 * Every holder of these grants holds them at `org`, and a site key has no `created_by`
 * scope of its own to narrow, so the guard's filter is already applied.
 */
@Controller('v1/intake/site-keys')
export class SiteKeysController {
  constructor(private readonly intake: IntakeService) {}

  @RequireAbility('read', 'LandingPage')
  @Get()
  async list(@Req() request: FastifyRequest) {
    return this.intake.listKeys(requireContext(request));
  }

  @RequireAbility('create', 'LandingPage')
  @Post()
  async issue(@Req() request: FastifyRequest, @Body() body: unknown) {
    const input = parse(issueSiteKeySchema, body);
    return this.intake.issueKey(requireContext(request), auditable(request), input);
  }

  @RequireAbility('update', 'LandingPage')
  @Post(':id/revoke')
  async revoke(@Req() request: FastifyRequest, @Param('id') id: string) {
    return this.intake.revokeKey(
      requireContext(request),
      auditable(request),
      parse(siteKeyIdSchema, id),
    );
  }
}
