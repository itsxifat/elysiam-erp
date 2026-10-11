import { BadRequestException, Body, Controller, Get, Param, Post, Put, Req } from '@nestjs/common';
import { deskProfileSchema, presenceBeatSchema, presencePauseSchema } from '@elysium/contracts';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';

import { ALREADY_AUDITED, type AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { RequireAbility } from '../../platform/auth/abilities.js';
import { requireContext } from '../../platform/http/context.js';
import { TeamService } from './team.service.js';

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

const userIdSchema = z.string().trim().min(1).max(64);

/**
 * Presence at the desks and each person's desk profile (M41, D-713, D-714, D-723).
 *
 * * `update Presence` / `read Presence` (`own`): the caller's own heartbeat, "Not taking
 *   orders" and the dock's read of both. Held by the roles that work a desk.
 * * `read User` / `update User`: the Staff page's desk profiles, org_admin's like the roles.
 */
@Controller('v1/team')
export class TeamController {
  constructor(private readonly team: TeamService) {}

  /**
   * The console's report about its own tab, about every thirty seconds.
   *
   * A report that changes nothing (the person is as active or as idle as thirty seconds ago)
   * writes no audit row, like a session's last-active stamp and the intake's replays: the
   * service audits every change in its own transaction, and this tells the audit net the rest
   * is not a change worth a row (D-713).
   */
  @RequireAbility('update', 'Presence')
  @Post('presence')
  async beat(@Req() request: FastifyRequest, @Body() body: unknown) {
    const input = parse(presenceBeatSchema, body);
    const outcome = await this.team.beat(requireContext(request), auditable(request), input);
    if (!outcome.changed) auditable(request)[ALREADY_AUDITED] = true;
    return outcome.view;
  }

  @RequireAbility('update', 'Presence')
  @Post('presence/pause')
  async pause(@Req() request: FastifyRequest, @Body() body: unknown) {
    const { paused } = parse(presencePauseSchema, body);
    return this.team.pause(requireContext(request), auditable(request), paused);
  }

  @RequireAbility('read', 'Presence')
  @Get('me')
  async me(@Req() request: FastifyRequest) {
    return this.team.me(requireContext(request), request);
  }

  @RequireAbility('read', 'User')
  @Get('profiles')
  async profiles(@Req() request: FastifyRequest) {
    return this.team.profiles(requireContext(request), request);
  }

  @RequireAbility('update', 'User')
  @Put('profiles/:userId')
  async saveProfile(
    @Req() request: FastifyRequest,
    @Param('userId') userId: string,
    @Body() body: unknown,
  ) {
    const input = parse(deskProfileSchema, body);
    return this.team.saveProfile(
      requireContext(request),
      auditable(request),
      parse(userIdSchema, userId),
      input,
    );
  }
}
