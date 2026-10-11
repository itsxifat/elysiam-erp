import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import {
  credentialResetSchema,
  deactivateUserSchema,
  serializeFor,
  setRolesSchema,
  userIdParamSchema,
} from '@elysium/contracts';
import type { FastifyRequest } from 'fastify';
import type { z } from 'zod';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { RequireAbility } from '../../platform/auth/abilities.js';
import { requireContext } from '../../platform/http/context.js';
import { NoIdempotencyReplay } from '../../platform/http/idempotency.interceptor.js';
import { UsersService } from './users.service.js';

function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new BadRequestException(
      parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
    );
  }
  return parsed.data;
}

const auditable = (request: FastifyRequest): AuditableRequest =>
  request as unknown as AuditableRequest;

/**
 * A brand's staff, for its admin (gaps-users-auth, architecture §6, §25).
 *
 * One subject, `User`, which §6 gives to org_admin at `org` (and super admin through
 * `manage all`): reading the list is `read`, every change is `update`. Inviting is the
 * older `POST /v1/users` beside these, which `create User` guards.
 *
 * A reset of someone who can approve at org tier is decided through
 * `POST /v1/approvals/:id/decide` and takes effect through this module's executor;
 * there is no second door into that decision here.
 */
@Controller('v1/users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @RequireAbility('read', 'User')
  @Get()
  async list(@Req() request: FastifyRequest) {
    const context = requireContext(request);
    return serializeFor(context, 'User', await this.users.list(context));
  }

  /** Replace what a person may do in this brand: one entry per role, with its branches. */
  @RequireAbility('update', 'User')
  @Put(':id/roles')
  async setRoles(@Req() request: FastifyRequest, @Param('id') id: string, @Body() body: unknown) {
    const userId = parse(userIdParamSchema, id);
    const input = parse(setRolesSchema, body);
    const context = requireContext(request);
    return serializeFor(
      context,
      'User',
      await this.users.setRoles(context, auditable(request), userId, input.roles),
    );
  }

  /** Switch a leaver off: their roles here end, and so do their sessions. */
  @RequireAbility('update', 'User')
  @Post(':id/deactivate')
  async deactivate(@Req() request: FastifyRequest, @Param('id') id: string, @Body() body: unknown) {
    const userId = parse(userIdParamSchema, id);
    const input = parse(deactivateUserSchema, body ?? {});
    return this.users.deactivate(requireContext(request), auditable(request), userId, input.reason);
  }

  /** A password link: an invite sent again, a reset, or an approved reset collected. */
  @RequireAbility('update', 'User')
  @Post(':id/password-link')
  @Header('Cache-Control', 'no-store')
  @NoIdempotencyReplay()
  async passwordLink(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const userId = parse(userIdParamSchema, id);
    const input = parse(credentialResetSchema, body);
    return this.users.passwordLink(
      requireContext(request),
      auditable(request),
      userId,
      input.reason,
    );
  }

  /** Remove a lost phone's second factor; the person enrols again at next sign-in. */
  @RequireAbility('update', 'User')
  @Post(':id/two-factor/reset')
  async resetTwoFactor(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const userId = parse(userIdParamSchema, id);
    const input = parse(credentialResetSchema, body);
    return this.users.resetTwoFactor(
      requireContext(request),
      auditable(request),
      userId,
      input.reason,
    );
  }

  /**
   * Turn a person's two-step sign-in off (M40, D-697): refused (409 `TWO_FACTOR_REQUIRED`)
   * when a role they hold requires it, or they are a super admin. Otherwise a reset by another
   * name: the same rules, limits and second admin as `two-factor/reset`.
   */
  @RequireAbility('update', 'User')
  @Post(':id/two-factor/turn-off')
  async turnOffTwoFactor(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const userId = parse(userIdParamSchema, id);
    const input = parse(credentialResetSchema, body);
    return this.users.turnOffTwoFactor(
      requireContext(request),
      auditable(request),
      userId,
      input.reason,
    );
  }

  /**
   * End every session a person has (M40, D-696). Not on yourself: My account does that.
   */
  @RequireAbility('update', 'User')
  @Post(':id/sign-out-everywhere')
  async signOutEverywhere(@Req() request: FastifyRequest, @Param('id') id: string) {
    const userId = parse(userIdParamSchema, id);
    return this.users.signOutEverywhere(requireContext(request), auditable(request), userId);
  }

  /**
   * Vouch for an admin (D-654 to D-656). Refused, not stored, when the vote would not count:
   * the reason names the invitation chain, the shared inviter or the missing second factor.
   */
  @RequireAbility('update', 'User')
  @Post(':id/trust')
  async vote(@Req() request: FastifyRequest, @Param('id') id: string) {
    const userId = parse(userIdParamSchema, id);
    return this.users.vote(requireContext(request), auditable(request), userId);
  }

  /** Withdraw the caller's own vote for an admin. */
  @RequireAbility('update', 'User')
  @Delete(':id/trust')
  async withdrawVote(@Req() request: FastifyRequest, @Param('id') id: string) {
    const userId = parse(userIdParamSchema, id);
    return this.users.withdrawVote(requireContext(request), auditable(request), userId);
  }

  /**
   * A super admin's yes for making an active admin here a super admin (D-659). With at most
   * one super admin in the brand it promotes at once; with two or more, the promotion waits
   * until every one of them has said yes, and the last vote makes it. Anyone else is refused
   * by the handler: only a super admin changes who is one.
   */
  @RequireAbility('update', 'User')
  @Post(':id/super-admin')
  async voteSuperAdmin(@Req() request: FastifyRequest, @Param('id') id: string) {
    const userId = parse(userIdParamSchema, id);
    return this.users.voteSuperAdmin(requireContext(request), auditable(request), userId);
  }

  /**
   * Give up your own super admin power, at once (D-685). Refused for the last super admin
   * and for an owner; your sessions end, this one included. Declared before the `:id`
   * routes only for reading order: `me` is a static segment, so it never reaches them.
   */
  @RequireAbility('update', 'User')
  @Post('me/step-down')
  async stepDown(@Req() request: FastifyRequest) {
    return this.users.stepDown(requireContext(request), auditable(request));
  }

  /**
   * A super admin's yes for removing another super admin (D-686). Only the first super admin
   * or an owner starts one; it removes once every other super admin but the target has said
   * yes, at once while that is at most one. The first super admin is removed only by
   * stepping down. Anyone who is not a super admin is refused by the handler.
   */
  @RequireAbility('update', 'User')
  @Post(':id/super-admin-removal')
  async removeSuperAdmin(@Req() request: FastifyRequest, @Param('id') id: string) {
    const userId = parse(userIdParamSchema, id);
    return this.users.removeSuperAdmin(requireContext(request), auditable(request), userId);
  }

  /** Withdraw a pending super admin removal: every vote for it goes. */
  @RequireAbility('update', 'User')
  @Delete(':id/super-admin-removal')
  async withdrawSuperAdminRemoval(@Req() request: FastifyRequest, @Param('id') id: string) {
    const userId = parse(userIdParamSchema, id);
    return this.users.withdrawSuperAdminRemoval(
      requireContext(request),
      auditable(request),
      userId,
    );
  }

  /** Withdraw a pending super admin nomination: every vote for the person goes. */
  @RequireAbility('update', 'User')
  @Delete(':id/super-admin')
  async withdrawSuperAdmin(@Req() request: FastifyRequest, @Param('id') id: string) {
    const userId = parse(userIdParamSchema, id);
    return this.users.withdrawSuperAdminNomination(
      requireContext(request),
      auditable(request),
      userId,
    );
  }
}
