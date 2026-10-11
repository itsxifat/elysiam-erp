import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { businessDate } from '@elysium/domain';
import {
  accountNameSchema,
  activityQuerySchema,
  backupCodesRenewSchema,
  brandUpdateSchema,
  confirmAuthenticatorSchema,
  inviteOwnerSchema,
  monthQuerySchema,
  newAuthenticatorSchema,
  passwordChangeSchema,
  pullRequestSchema,
  rangeQuerySchema,
  sessionIdParamSchema,
  twoFactorResetRequestSchema,
  uuidParamSchema,
  type AccountSessionWire,
  type AccountWire,
  type ActivityWire,
  type AuthenticatorSetupWire,
  type BackupCodesWire,
  type BrandFiguresWire,
  type BrandLiveResult,
  type BrandStatusWire,
  type ConnectionTestWire,
  type LeaderboardWire,
  type LinkWire,
  type MeWire,
  type OverviewWire,
  type OwnerLinkWire,
  type PersonWire,
  type ProfitAndLossWire,
  type TwoFactorResetWire,
  type WalletsWire,
} from '@elysium/mother-shared';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';

import {
  accountOf,
  changePassword,
  confirmNewAuthenticator,
  listMySessions,
  renameSelf,
  renewBackupCodes,
  signOutOtherSessions,
  signOutSession,
  startNewAuthenticator,
  type AccountCrypto,
} from '../account/account.js';
import { recordAudit } from '../audit/audit.js';
import { brandLive, ownerLinkFor, testConnection } from '../brands/live.js';
import { brandStatusWire, listBrands, requireBrand, updateBrand } from '../brands/registry.js';
import { motherSql } from '../db/client.js';
import {
  decideTwoFactorReset,
  invitePerson,
  listPeople,
  listResets,
  reissueInvite,
  removePerson,
  requestTwoFactorReset,
} from '../people/people.js';
import { brandFigures, leaderboard, overview, profitAndLoss, wallets } from '../reports/reports.js';
import { ACCOUNT_CRYPTO, RUNTIME, type MotherRuntime } from '../runtime.js';
import { actorOf, parseWith, Public, sessionOf } from './nest.js';

/**
 * The mother's HTTP API (D-480). Every route but the health checks needs a signed-in owner
 * with a second factor (`OwnerGuard`); every input is parsed with `@elysium/mother-shared`'s
 * schemas; every change is audited by the service that makes it.
 *
 * A brand is added, its read connection changed and its owner-link key made or replaced
 * only on the server, by the operator's `brands` commands (D-690, D-700): there is no route
 * for any of the three, so a stolen session cannot point the mother at another database or
 * swap the key that signs owners into a brand.
 */

const id = (value: string): string => parseWith(uuidParamSchema, value);

@Controller('v1/health')
export class HealthController {
  @Public()
  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Public()
  @Get('ready')
  async ready(): Promise<{ status: 'ok' }> {
    await motherSql()`select 1`;
    return { status: 'ok' };
  }
}

@Controller('v1')
export class MeController {
  @Get('me')
  me(@Req() request: FastifyRequest): MeWire {
    const actor = actorOf(request);
    return { id: actor.userId, name: actor.name, email: actor.email };
  }
}

@Controller('v1')
export class OverviewController {
  constructor(@Inject(RUNTIME) private readonly runtime: MotherRuntime) {}

  @Get('overview')
  async overview(@Query() query: unknown): Promise<OverviewWire> {
    return overview(parseWith(rangeQuerySchema, query));
  }

  @Get('leaderboard')
  async leaderboard(@Query() query: unknown): Promise<LeaderboardWire> {
    const month =
      (query as { month?: unknown } | null)?.month ??
      businessDate(this.runtime.clock()).slice(0, 7);
    return leaderboard(parseWith(monthQuerySchema, { month }).month, this.runtime.weights);
  }
}

@Controller('v1/brands')
export class BrandsController {
  constructor(@Inject(RUNTIME) private readonly runtime: MotherRuntime) {}

  @Get()
  async list(): Promise<{ brands: BrandStatusWire[] }> {
    return { brands: (await listBrands()).map(brandStatusWire) };
  }

  @Get(':id')
  async one(@Param('id') brandId: string): Promise<BrandStatusWire> {
    return brandStatusWire(await requireBrand(id(brandId)));
  }

  @Patch(':id')
  async update(
    @Req() request: FastifyRequest,
    @Param('id') brandId: string,
    @Body() body: unknown,
  ): Promise<BrandStatusWire> {
    const input = parseWith(brandUpdateSchema, body);
    const row = await updateBrand(id(brandId), input, actorOf(request));
    return brandStatusWire(row);
  }

  @Get(':id/figures')
  async figures(@Param('id') brandId: string, @Query() query: unknown): Promise<BrandFiguresWire> {
    return brandFigures(id(brandId), parseWith(rangeQuerySchema, query));
  }

  @Get(':id/live')
  async live(@Param('id') brandId: string): Promise<BrandLiveResult> {
    return brandLive(this.runtime.pools, id(brandId), this.runtime.clock);
  }

  @Post(':id/test')
  @HttpCode(200)
  async test(
    @Req() request: FastifyRequest,
    @Param('id') brandId: string,
  ): Promise<ConnectionTestWire> {
    return testConnection(this.runtime.pools, id(brandId), actorOf(request));
  }

  @Post(':id/pull')
  @HttpCode(202)
  async pull(
    @Req() request: FastifyRequest,
    @Param('id') brandId: string,
    @Body() body: unknown,
  ): Promise<{ queued: true }> {
    const brand = await requireBrand(id(brandId));
    const { full } = parseWith(pullRequestSchema, body ?? {});
    const actor = actorOf(request);
    await this.runtime.enqueuePull({ brandId: brand.id, trigger: 'owner', full });
    await recordAudit({
      actorUserId: actor.userId,
      action: 'brand.pull_requested',
      entityType: 'brand',
      entityId: brand.id,
      detail: { slug: brand.slug, full },
      ipAddress: actor.ipAddress,
      requestId: actor.requestId,
    });
    return { queued: true };
  }

  @Post(':id/owner-link')
  @HttpCode(200)
  async ownerLink(
    @Req() request: FastifyRequest,
    @Param('id') brandId: string,
  ): Promise<OwnerLinkWire> {
    return ownerLinkFor(this.runtime.secrets(), id(brandId), actorOf(request), this.runtime.clock);
  }
}

@Controller('v1/accounts')
export class AccountsController {
  @Get('wallets')
  async wallets(): Promise<WalletsWire> {
    return wallets();
  }

  @Get('profit-and-loss')
  async profitAndLoss(@Query() query: unknown): Promise<ProfitAndLossWire> {
    return profitAndLoss(parseWith(rangeQuerySchema, query));
  }
}

@Controller('v1')
export class PeopleController {
  constructor(@Inject(RUNTIME) private readonly runtime: MotherRuntime) {}

  @Get('people')
  async list(): Promise<{ people: PersonWire[]; resets: TwoFactorResetWire[] }> {
    const [people, resets] = await Promise.all([listPeople(), listResets()]);
    return { people, resets };
  }

  @Post('people')
  async invite(@Req() request: FastifyRequest, @Body() body: unknown): Promise<LinkWire> {
    const input = parseWith(inviteOwnerSchema, body);
    const { link, expiresAt } = await invitePerson(this.runtime.publicUrl, input, actorOf(request));
    return { link, expiresAt };
  }

  @Post('people/:id/invite-link')
  async reissue(@Req() request: FastifyRequest, @Param('id') userId: string): Promise<LinkWire> {
    return reissueInvite(this.runtime.publicUrl, personId(userId), actorOf(request));
  }

  @Post('people/:id/remove')
  @HttpCode(200)
  async remove(@Req() request: FastifyRequest, @Param('id') userId: string): Promise<{ ok: true }> {
    await removePerson(personId(userId), actorOf(request));
    return { ok: true };
  }

  @Post('people/:id/two-factor-resets')
  async requestReset(
    @Req() request: FastifyRequest,
    @Param('id') userId: string,
    @Body() body: unknown,
  ): Promise<{ id: string }> {
    const { reason } = parseWith(twoFactorResetRequestSchema, body);
    return requestTwoFactorReset(personId(userId), reason, actorOf(request));
  }

  @Post('two-factor-resets/:id/approve')
  @HttpCode(200)
  async approve(
    @Req() request: FastifyRequest,
    @Param('id') resetId: string,
  ): Promise<{ ok: true }> {
    await decideTwoFactorReset(id(resetId), 'approve', actorOf(request));
    return { ok: true };
  }

  @Post('two-factor-resets/:id/reject')
  @HttpCode(200)
  async reject(
    @Req() request: FastifyRequest,
    @Param('id') resetId: string,
  ): Promise<{ ok: true }> {
    await decideTwoFactorReset(id(resetId), 'reject', actorOf(request));
    return { ok: true };
  }
}

const personIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
const personId = (value: string): string => parseWith(personIdSchema, value);

@Controller('v1/activity')
export class ActivityController {
  @Get()
  async list(@Query() query: unknown): Promise<ActivityWire> {
    const { before, limit } = parseWith(activityQuerySchema, query);
    const sql = motherSql();
    const rows = await sql<
      {
        id: number;
        occurred_at: Date;
        actor_user_id: string | null;
        actor_name: string | null;
        action: string;
        entity_type: string;
        entity_id: string | null;
        detail: Record<string, unknown>;
      }[]
    >`
      select a.id, a.occurred_at, a.actor_user_id, u.name as actor_name, a.action,
             a.entity_type, a.entity_id, a.detail
      from mother.audit_log a
      left join auth.users u on u.id = a.actor_user_id
      ${before === undefined ? sql`` : sql`where a.id < ${before}`}
      order by a.id desc
      limit ${limit + 1}
    `;
    const page = rows.slice(0, limit);
    return {
      items: page.map((row) => ({
        id: Number(row.id),
        occurredAt: row.occurred_at.toISOString(),
        actor: row.actor_user_id === null ? null : { id: row.actor_user_id, name: row.actor_name },
        action: row.action,
        entityType: row.entity_type,
        entityId: row.entity_id,
        detail: row.detail,
      })),
      next: rows.length > limit ? Number(page.at(-1)?.id ?? 0) : null,
    };
  }
}

/**
 * My account (M40, D-701 to D-705): the signed-in owner's own name, password, two-step
 * sign-in and devices. Every change checks what it needs and is audited by `account.ts`.
 */
@Controller('v1/account')
export class AccountController {
  constructor(@Inject(ACCOUNT_CRYPTO) private readonly crypto: AccountCrypto) {}

  @Get()
  async account(@Req() request: FastifyRequest): Promise<AccountWire> {
    return accountOf(this.crypto, actorOf(request).userId);
  }

  @Patch()
  async rename(@Req() request: FastifyRequest, @Body() body: unknown): Promise<AccountWire> {
    const actor = actorOf(request);
    await renameSelf(actor, parseWith(accountNameSchema, body));
    return accountOf(this.crypto, actor.userId);
  }

  @Post('password')
  @HttpCode(200)
  async password(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<{ signedOutOtherDevices: number }> {
    const input = parseWith(passwordChangeSchema, body);
    return changePassword(this.crypto, actorOf(request), sessionOf(request), input);
  }

  @Post('two-factor/new-app')
  @HttpCode(200)
  async newApp(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<AuthenticatorSetupWire> {
    const input = parseWith(newAuthenticatorSchema, body);
    return startNewAuthenticator(this.crypto, actorOf(request), sessionOf(request), input);
  }

  @Post('two-factor/new-app/confirm')
  @HttpCode(200)
  async confirmNewApp(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<{ signedOutOtherDevices: number }> {
    const input = parseWith(confirmAuthenticatorSchema, body);
    return confirmNewAuthenticator(this.crypto, actorOf(request), sessionOf(request), input);
  }

  @Post('two-factor/backup-codes')
  @HttpCode(200)
  async backupCodes(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<BackupCodesWire> {
    return renewBackupCodes(this.crypto, actorOf(request), parseWith(backupCodesRenewSchema, body));
  }

  @Get('sessions')
  async sessions(@Req() request: FastifyRequest): Promise<{ sessions: AccountSessionWire[] }> {
    return { sessions: await listMySessions(actorOf(request).userId, sessionOf(request)) };
  }

  @Post('sessions/sign-out-others')
  @HttpCode(200)
  async signOutOthers(@Req() request: FastifyRequest): Promise<{ signedOut: number }> {
    return signOutOtherSessions(actorOf(request), sessionOf(request));
  }

  @Post('sessions/:id/sign-out')
  @HttpCode(200)
  async signOut(
    @Req() request: FastifyRequest,
    @Param('id') target: string,
  ): Promise<{ ok: true }> {
    await signOutSession(
      actorOf(request),
      sessionOf(request),
      parseWith(sessionIdParamSchema, target),
    );
    return { ok: true };
  }
}

export const CONTROLLERS = [
  HealthController,
  MeController,
  AccountController,
  OverviewController,
  BrandsController,
  AccountsController,
  PeopleController,
  ActivityController,
];
