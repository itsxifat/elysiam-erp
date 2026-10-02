import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Header,
  Post,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { createUserSchema, switchOrgSchema } from '@elysium/contracts';
import {
  availableOrgs,
  canEnterOrg,
  resolveContext,
  resolveLoginBranding,
  type RequestContext,
} from '@elysium/db';
import type { FastifyRequest } from 'fastify';

import { AuthenticatedOnly, Public, RequireAbility } from '../../platform/auth/abilities.js';
import { serverEnv } from '../../platform/config/env.js';
import { NoIdempotencyReplay } from '../../platform/http/idempotency.interceptor.js';
import { IamService } from './iam.service.js';

/**
 * Identity endpoints (architecture §6).
 *
 * Nothing here decides what a user may *do* — that is M02b. These answer only
 * who they are, which orgs they may enter, and which one they are currently in.
 */
@Controller('v1')
export class IamController {
  constructor(private readonly iam: IamService) {}

  /**
   * Branding for a login screen (D-035).
   *
   * Unauthenticated by necessity: it runs before anyone has signed in. It
   * therefore returns only what a login page may show — display name, accent,
   * logo — and never anything that would make it an org enumeration oracle
   * beyond the brand names, which are public.
   *
   * `host` is the *caller's* hostname, not this server's. The console is served
   * from `oura-lifestyle.<domain>` while the API answers on `api.<domain>`, so
   * reading our own Host header would resolve every branded login to the org
   * called "api". Accepting it from the client is no wider a door than the
   * `slug` parameter beside it, and both return only public brand facts.
   */
  @Public('Runs before anyone has signed in, and returns only public brand facts.')
  @Get('auth/login-branding')
  async loginBranding(
    @Req() request: FastifyRequest,
    @Query('slug') slug?: string,
    @Query('host') host?: string,
  ) {
    const env = serverEnv();
    return resolveLoginBranding({
      host: host ?? request.headers.host,
      slug,
      appDomain: env.APP_DOMAIN,
    });
  }

  /** The orgs this user may enter, for the switcher. */
  @AuthenticatedOnly('Answers which orgs you may enter, which is prior to being in one.')
  @Get('me/orgs')
  async myOrgs(@Req() request: FastifyRequest) {
    const userId = this.iam.requireUserId(request);
    return { orgs: await availableOrgs(userId) };
  }

  /** Who the caller is, right now, in the org they are acting in. */
  @AuthenticatedOnly('Answers who the caller is. There is no other subject it could be about.')
  @Get('me')
  me(@Req() request: FastifyRequest): RequestContext {
    const context = (request as FastifyRequest & { context?: RequestContext }).context;
    if (context === undefined) {
      throw new UnauthorizedException('No active organization. Choose one first.');
    }
    return context;
  }

  /**
   * Switch the active org.
   *
   * Membership is re-checked here rather than trusted from the request: a
   * session outlives a membership, and the whole point of the switcher is that
   * it changes which rows the database will return.
   */
  @AuthenticatedOnly('Changes which org you are in. Membership is the check, not an ability.')
  @Post('me/active-org')
  async switchOrg(@Req() request: FastifyRequest, @Body() body: unknown) {
    const userId = this.iam.requireUserId(request);

    // The shared schema, not a hand-rolled check: the console validates against
    // this same object, so the two cannot drift apart (packages/contracts).
    const parsed = switchOrgSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('orgId must be a uuid.');
    const { orgId } = parsed.data;

    if (!(await canEnterOrg(userId, orgId))) {
      // Deliberately the same error whether the org does not exist or the user
      // simply has no membership in it. Distinguishing them would turn this
      // into a membership oracle.
      throw new ForbiddenException('You do not have access to that organization.');
    }

    await this.iam.setActiveOrg(request, orgId);

    const context = await resolveContext({
      userId,
      orgId,
      requestId: this.iam.requestId(request),
    });

    return { orgId, roles: context?.roles ?? [] };
  }

  /**
   * Create a user, grant them a role, and return the invite they redeem.
   *
   * org_admin only — the service enforces it, because "who may call this" is a
   * fact about the operation rather than about the transport. It shipped
   * unguarded with a comment deferring the check to M02b, and an audit
   * reproduced a `sales` user granting themselves org_admin in one request.
   */
  @RequireAbility('create', 'User')
  @Post('users')
  // The response carries the invite token: never cached, never stored for replay.
  @Header('Cache-Control', 'no-store')
  @NoIdempotencyReplay()
  async createUser(@Req() request: FastifyRequest, @Body() body: unknown) {
    const context = (request as FastifyRequest & { context?: RequestContext }).context;
    if (context?.orgId == null) {
      throw new UnauthorizedException('No active organization.');
    }
    const orgId = context.orgId;

    const parsed = createUserSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(
        parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
      );
    }

    return this.iam.createUserWithMembership({
      caller: context,
      orgId,
      ...parsed.data,
    });
  }
}
