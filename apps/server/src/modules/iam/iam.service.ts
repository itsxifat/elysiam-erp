import { randomUUID } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import {
  INVITE_LINK_SECONDS,
  withGlobal,
  withOrg,
  withUser,
  type Auth,
  type MembershipRole,
  type RequestContext,
} from '@elysium/db';
import { sql } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { AuditService } from '../../platform/audit/audit.service.js';

/** What the auth plugin hangs off the request once a session is resolved. */
export interface AuthenticatedRequest extends FastifyRequest {
  authUser?: { id: string; email: string };
  authSessionId?: string;
  requestId?: string;
}

/** What the auth module hands the service: the live Better Auth instance. */
export const AUTH = Symbol('ELYSIUM_AUTH');

/**
 * The tokens Better Auth minted but has nowhere to send yet.
 *
 * There is no email adapter yet (D-012, D-212), so an invite
 * token is handed back to the admin who created the user, and this is where it
 * waits in between — taken exactly once, so it cannot be read twice by accident.
 */
export const PASSWORD_TOKENS = Symbol('ELYSIUM_PASSWORD_TOKENS');

export class PasswordTokenStore {
  private readonly byEmail = new Map<string, string>();

  put(email: string, token: string): void {
    this.byEmail.set(email.trim().toLowerCase(), token);
  }

  take(email: string): string | undefined {
    const key = email.trim().toLowerCase();
    const token = this.byEmail.get(key);
    this.byEmail.delete(key);
    return token;
  }
}

/**
 * Is this a foreign-key violation? (SQLSTATE 23503)
 *
 * Drizzle wraps the driver error, so the code lives down the `cause` chain
 * rather than on the error it throws.
 */
function isForeignKeyViolation(cause: unknown): boolean {
  for (let error = cause; error !== null && error !== undefined;) {
    if (typeof error === 'object' && 'code' in error && error.code === '23503') return true;
    error = (error as { cause?: unknown }).cause;
  }
  return false;
}

@Injectable()
export class IamService {
  constructor(
    @Inject(AUTH) private readonly auth: Auth,
    @Inject(PASSWORD_TOKENS) private readonly tokens: PasswordTokenStore,
    private readonly audit: AuditService,
  ) {}

  requireUserId(request: FastifyRequest): string {
    const userId = (request as AuthenticatedRequest).authUser?.id;
    if (userId === undefined || userId === '') {
      // 401, not 400: the request is well formed, the caller is just nobody.
      throw new UnauthorizedException('Not signed in.');
    }
    return userId;
  }

  requestId(request: FastifyRequest): string {
    return (request as AuthenticatedRequest).requestId ?? randomUUID();
  }

  /**
   * Record the chosen org on the session row.
   *
   * On the session rather than in a cookie, so the client cannot change which
   * org it is acting in without a round trip that re-checks membership. A
   * client-controlled org id would make every RLS policy in the system
   * advisory.
   */
  async setActiveOrg(request: FastifyRequest, orgId: string): Promise<void> {
    const typed = request as AuthenticatedRequest;
    const sessionId = typed.authSessionId;
    const userId = typed.authUser?.id;
    if (sessionId === undefined || userId === undefined) {
      throw new BadRequestException('No session.');
    }

    const previous = await withGlobal(async (tx) => {
      const [row] = await tx.execute<{ active_org_id: string | null }>(
        sql`select active_org_id from iam.sessions where id = ${sessionId} for update`,
      );
      await tx.execute(
        sql`update iam.sessions set active_org_id = ${orgId}, updated_at = now() where id = ${sessionId}`,
      );
      return row?.active_org_id ?? null;
    });

    /*
     * Audited into the org being *entered* (§25).
     *
     * The interceptor could not do this: it writes into `request.context.orgId`,
     * which on a first switch does not exist — no context is built until a
     * session has an org — and on a later switch is the org being left. So the
     * one mutation that changes which rows the database returns was either
     * unaudited or recorded in the wrong brand's log. The org admin who needs to
     * see "who started acting in my org, and when" is the target's.
     *
     * The previous org is recorded only as "none", "this" or "another": the
     * target's admin learning *which* sister brand the user came from would be
     * a small cross-tenant disclosure for no audit benefit.
     *
     * Not in the same transaction as the switch: the session row is global and
     * the log is tenant-scoped, reached through different connection settings.
     * Written straight after, so a failure here surfaces as a 500 on a switch
     * that did happen — loud, which is the right direction for an audit gap.
     */
    await withOrg({ orgId, userId }, async (tx) => {
      await this.audit.record(tx, {
        orgId,
        actorUserId: userId,
        operation: 'update',
        action: 'iam.active_org_switched',
        entityType: 'Session',
        entityId: sessionId,
        before: { activeOrg: previous === null ? 'none' : previous === orgId ? 'this' : 'another' },
        after: { activeOrgId: orgId },
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
        requestId: typed.requestId ?? null,
        request: request as unknown as AuditableRequest,
      });
    });
  }

  /**
   * Create a user, give them one role in this org, and issue an invite.
   *
   * Three things here are load-bearing, and the first two exist because an
   * audit reproduced the attacks they prevent.
   *
   * **Only an org_admin may call this, and only an org_admin may grant
   * org_admin.** The route used to be guarded by nothing but membership, with a
   * comment deferring the check to M02b. But the route shipped, and
   * `org_admin` is a `read:cost` role and an approvals checker: a `sales` user
   * could post their own address with `role: "org_admin"`, the existing-user
   * branch would reuse their identity, and they held full org admin in one
   * request. Reproduced, 201.
   *
   * **An existing identity is only reused when it is safe to reuse.** Users are
   * global by design (§6): one person works for three brands. But matching on
   * email alone meant an attacker who had registered an address first would
   * inherit whatever role was later invited to it. Self-service registration is
   * closed now, and on top of that a row that holds credentials but no
   * membership anywhere is refused rather than adopted.
   *
   * **The invited user gets a way in.** Creating a user row with no credential
   * produced an account nobody could ever sign in to. The invite token is Better
   * Auth's own password-reset token, so the redemption path is its
   * `/api/auth/reset-password` endpoint rather than something hand-rolled.
   */
  async createUserWithMembership(input: {
    caller: RequestContext;
    orgId: string;
    email: string;
    name: string;
    role: MembershipRole;
    branchIds: readonly string[];
  }): Promise<{ userId: string; membershipId: string; created: boolean; inviteToken?: string }> {
    const isAdmin = input.caller.isSuperAdmin || input.caller.roles.includes('org_admin');
    if (!isAdmin) {
      throw new ForbiddenException('Only an organisation admin can create users.');
    }

    const email = input.email;

    const existing = await withGlobal(async (tx) =>
      tx.execute<{ id: string; email_verified: boolean }>(
        sql`select id, email_verified from iam.users where email = ${email}`,
      ),
    );

    let userId = existing[0]?.id;
    const created = userId === undefined;

    if (userId !== undefined) {
      await this.refuseUnclaimedAccount(userId);
    } else {
      userId = `usr_${randomUUID()}`;
      const id = userId;
      await withGlobal(async (tx) => {
        await tx.execute(sql`
          insert into iam.users (id, email, name, email_verified)
          values (${id}, ${email}, ${input.name}, false)
        `);
      });
    }

    const resolvedUserId = userId;

    const membershipId = await withOrg(
      { orgId: input.orgId, userId: input.caller.userId },
      async (tx) => {
        const inserted = await tx.execute<{ id: string }>(sql`
          insert into iam.memberships (org_id, user_id, role, granted_by)
          values (
            ${input.orgId}, ${resolvedUserId}, ${input.role}::iam.membership_role,
            ${input.caller.userId}
          )
          -- Reactivating is granting again, so the granter is recorded again:
          -- maker-checker reads it (D-077).
          on conflict (org_id, user_id, role) do update
            set is_active = true, granted_by = excluded.granted_by
          returning id
        `);

        const id = inserted[0]?.id;
        if (id === undefined) throw new ConflictException('Could not create the membership.');

        for (const branchId of input.branchIds) {
          // The composite foreign key (D-047) rejects a branch belonging to
          // another org. Caught here so it surfaces as a 400 rather than the
          // 500 an unhandled constraint violation produced.
          try {
            await tx.execute(sql`
              insert into iam.membership_branches (org_id, membership_id, branch_id)
              values (${input.orgId}, ${id}, ${branchId})
              on conflict (membership_id, branch_id) do nothing
            `);
          } catch (cause) {
            // Only the constraint violation becomes a 400. A deadlock or a lost
            // connection is not the caller's input being wrong, and blaming it
            // on them would send someone hunting a branch id that is fine.
            if (!isForeignKeyViolation(cause)) throw cause;
            throw new BadRequestException(`Branch ${branchId} is not in this organisation.`);
          }
        }

        return id;
      },
    );

    const invite = created ? await this.issueInvite(resolvedUserId, email) : undefined;

    return {
      userId: resolvedUserId,
      membershipId,
      created,
      ...(invite === undefined
        ? {}
        : { inviteToken: invite.token, inviteExpiresAt: invite.expiresAt.toISOString() }),
    };
  }

  /**
   * Refuse to adopt an account that was created outside the invite flow.
   *
   * A user row that holds credentials but belongs to no org is not a colleague
   * joining a second brand — it is either leftover data or somebody who got
   * there first. Reusing it attaches the new role to whatever password that row
   * already has.
   */
  private async refuseUnclaimedAccount(userId: string): Promise<void> {
    // `iam.accounts` is global, so `withGlobal` is right for it.
    const [row] = await withGlobal(async (tx) =>
      tx.execute<{ credentials: number }>(
        sql`select count(*) as credentials from iam.accounts where user_id = ${userId}`,
      ),
    );

    const credentials = Number(row?.credentials ?? 0);
    if (credentials === 0) return;

    // `iam.memberships` is NOT global, and this is the whole point of the
    // check: "does this person belong to any org" is a question about their own
    // memberships, across orgs, with none chosen. That is exactly the D-050
    // self policy, reached through `withUser` — the same lens
    // `mustEnrolTwoFactor` uses for the same shape of question.
    //
    // It was `withGlobal` here, which clears `app.user_id` as well as
    // `app.org_id`, so both policies evaluated `col = NULL` and the count came
    // back 0 for everyone. The guard collapsed to "refuse anyone who has a
    // password", and a colleague joining a second brand — the case §5
    // exception 4 exists for — was rejected outright. Verified against the
    // database: a user with two memberships counted as zero.
    // Deliberately not filtered on `is_active`: a revoked membership still
    // means this person was one of ours. Someone re-hired, or moving between
    // sister brands after leaving one, should have their identity reused rather
    // than be treated as a squatter on their own address.
    const memberships = await withUser({ userId }, async (tx) =>
      tx.execute<{ count: number }>(
        sql`select count(*) as count from iam.memberships where user_id = ${userId}`,
      ),
    );

    if (Number(memberships[0]?.count ?? 0) > 0) return;

    throw new ConflictException(
      'That address already has an account that belongs to no organisation. Have it removed before inviting it.',
    );
  }

  /**
   * Mint the token the invited user redeems to set their password.
   *
   * Through Better Auth's own `request-password-reset`, so the token, its
   * expiry and the redemption endpoint are the library's rather than a second
   * implementation of the same thing with its own bugs.
   */
  private async issueInvite(
    userId: string,
    email: string,
  ): Promise<{ token: string; expiresAt: Date } | undefined> {
    // One person, one working link (D-402): nothing minted earlier may still open.
    await withGlobal(async (tx) =>
      tx.execute(sql`
        delete from iam.verifications
        where identifier like 'reset-password:%' and value = ${userId}
      `),
    );
    this.tokens.take(email);

    await this.auth.api.requestPasswordReset({
      body: { email, redirectTo: '/accept-invite' },
      headers: new Headers(),
    });

    const token = this.tokens.take(email);
    if (token === undefined) return undefined;

    // Better Auth gives every link an hour; an invite gets three days (D-402).
    const [row] = await withGlobal(async (tx) =>
      tx.execute<{ expires_at: Date }>(sql`
        update iam.verifications
        set expires_at = now() + make_interval(secs => ${INVITE_LINK_SECONDS}), updated_at = now()
        where identifier = ${`reset-password:${token}`}
        returning expires_at
      `),
    );
    return { token, expiresAt: row === undefined ? new Date() : new Date(row.expires_at) };
  }
}
