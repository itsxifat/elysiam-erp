import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Post,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import {
  availableOrgs,
  canEnterOrg,
  resolveContext,
  resolveLoginBranding,
  type RequestContext,
} from '@elysium/db';
import type { FastifyRequest } from 'fastify';

import { serverEnv } from '../../platform/config/env.js';
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
  @Get('me/orgs')
  async myOrgs(@Req() request: FastifyRequest) {
    const userId = this.iam.requireUserId(request);
    return { orgs: await availableOrgs(userId) };
  }

  /** Who the caller is, right now, in the org they are acting in. */
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
  @Post('me/active-org')
  async switchOrg(@Req() request: FastifyRequest, @Body() body: { orgId?: string }) {
    const userId = this.iam.requireUserId(request);
    const orgId = body.orgId;

    if (typeof orgId !== 'string' || orgId === '') {
      throw new BadRequestException('orgId is required.');
    }

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
   * Create a user and grant them a role.
   *
   * Guarded by nothing but membership today; M02b adds the ability check that
   * limits this to org_admin. Until then it is registered so the shape is
   * settled, and the route-matrix gate M02b introduces will fail loudly if it
   * is still unguarded then.
   */
  @Post('users')
  async createUser(
    @Req() request: FastifyRequest,
    @Body()
    body: {
      email?: string;
      name?: string;
      role?: string;
      branchIds?: string[];
    },
  ) {
    const context = (request as FastifyRequest & { context?: RequestContext }).context;
    if (context?.orgId == null) {
      throw new UnauthorizedException('No active organization.');
    }

    return this.iam.createUserWithMembership({
      orgId: context.orgId,
      email: body.email ?? '',
      name: body.name ?? '',
      role: body.role ?? '',
      branchIds: body.branchIds ?? [],
    });
  }
}
