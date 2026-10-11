import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  Patch,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import {
  confirmWithCodeSchema,
  replacementCodeSchema,
  sessionIdParamSchema,
  updateProfileSchema,
} from '@elysium/contracts';
import type { FastifyRequest } from 'fastify';
import type { z } from 'zod';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { AuthenticatedOnly } from '../../platform/auth/abilities.js';
import { requireContext } from '../../platform/http/context.js';
import { NoIdempotencyReplay } from '../../platform/http/idempotency.interceptor.js';
import { AccountService } from './account.service.js';
import type { AuthenticatedRequest } from './iam.service.js';

function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new BadRequestException({
      code: 'VALIDATION_FAILED',
      message: parsed.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; '),
    });
  }
  return parsed.data;
}

const auditable = (request: FastifyRequest): AuditableRequest =>
  request as unknown as AuditableRequest;

/** The session this request rode in on: "this device" on the devices list. */
function sessionIdOf(request: FastifyRequest): string {
  const id = (request as AuthenticatedRequest).authSessionId;
  if (id === undefined || id === '') throw new UnauthorizedException('Not signed in.');
  return id;
}

/** The caller's own cookie, for Better Auth to check a password or a backup code against. */
function cookieOf(request: FastifyRequest): string {
  return typeof request.headers.cookie === 'string' ? request.headers.cookie : '';
}

/**
 * My account (M40, D-693 to D-695): the caller's own name, devices and second factor.
 *
 * Every route is `@AuthenticatedOnly`: there is no subject to check an ability against,
 * because each one acts on the caller and only the caller — the service names the caller's
 * own id in every statement. Password changes go to Better Auth's own
 * `/api/auth/change-password`, audited by the auth bridge; these are the parts Better Auth has
 * no endpoint for, or none that asks enough (its password-only two-factor paths are closed).
 */
@Controller('v1/account')
export class AccountController {
  constructor(private readonly account: AccountService) {}

  @AuthenticatedOnly('Your own account, and nobody else’s: there is no subject to check.')
  @Get()
  async overview(@Req() request: FastifyRequest) {
    return this.account.overview(requireContext(request));
  }

  @AuthenticatedOnly('Changes your own name, and nobody else’s.')
  @Patch('profile')
  async updateProfile(@Req() request: FastifyRequest, @Body() body: unknown) {
    const input = parse(updateProfileSchema, body);
    return this.account.updateProfile(requireContext(request), auditable(request), input.name);
  }

  @AuthenticatedOnly('Lists your own signed-in devices, and nobody else’s.')
  @Get('sessions')
  async sessions(@Req() request: FastifyRequest) {
    return { items: await this.account.sessions(requireContext(request), sessionIdOf(request)) };
  }

  @AuthenticatedOnly('Signs out one of your own devices; another person’s matches nothing.')
  @Delete('sessions/:id')
  async endSession(@Req() request: FastifyRequest, @Param('id') id: string) {
    const sessionId = parse(sessionIdParamSchema, id);
    return this.account.endSession(
      requireContext(request),
      auditable(request),
      sessionIdOf(request),
      sessionId,
    );
  }

  @AuthenticatedOnly('Signs out your own other devices.')
  @Post('sessions/sign-out-others')
  @HttpCode(200)
  async endOtherSessions(@Req() request: FastifyRequest) {
    return this.account.endOtherSessions(
      requireContext(request),
      auditable(request),
      sessionIdOf(request),
    );
  }

  /** The answer carries the new phone's secret: never cached, never stored for replay. */
  @AuthenticatedOnly('Starts moving your own two-step sign-in to a new phone.')
  @Post('two-factor/replace')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @NoIdempotencyReplay()
  async startReplacement(@Req() request: FastifyRequest, @Body() body: unknown) {
    const input = parse(confirmWithCodeSchema, body);
    return this.account.startReplacement(
      requireContext(request),
      auditable(request),
      cookieOf(request),
      input,
    );
  }

  @AuthenticatedOnly('Finishes moving your own two-step sign-in to a new phone.')
  @Post('two-factor/replace/confirm')
  @HttpCode(200)
  @NoIdempotencyReplay()
  async confirmReplacement(@Req() request: FastifyRequest, @Body() body: unknown) {
    const input = parse(replacementCodeSchema, body);
    return this.account.confirmReplacement(requireContext(request), auditable(request), input.code);
  }

  /** Ten new recovery codes, shown once: never cached, never stored for replay. */
  @AuthenticatedOnly('Makes new recovery codes for your own two-step sign-in.')
  @Post('two-factor/recovery-codes')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @NoIdempotencyReplay()
  async recoveryCodes(@Req() request: FastifyRequest, @Body() body: unknown) {
    const input = parse(confirmWithCodeSchema, body);
    return this.account.recoveryCodes(
      requireContext(request),
      auditable(request),
      cookieOf(request),
      input,
    );
  }

  @AuthenticatedOnly(
    'Turns your own two-step sign-in off, only where nothing requires it (the brand policy decides).',
  )
  @Post('two-factor/turn-off')
  @HttpCode(200)
  @NoIdempotencyReplay()
  async turnOff(@Req() request: FastifyRequest, @Body() body: unknown) {
    const input = parse(confirmWithCodeSchema, body);
    return this.account.turnOff(
      requireContext(request),
      auditable(request),
      cookieOf(request),
      input,
    );
  }
}
