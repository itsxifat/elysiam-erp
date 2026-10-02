import { randomUUID } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { resetNeedsSecondPerson, type MembershipRole, type RoleGrant } from '@elysium/contracts';
import {
  INVITE_LINK_SECONDS,
  PASSWORD_LINK_SECONDS,
  requiresTwoFactor,
  withGlobal,
  withOrg,
  withUser,
  type Auth,
  type Tx,
} from '@elysium/db';
import {
  isCollectable,
  planCredentialReset,
  planRoleChange,
  resetAllowedByLimits,
  type ResetKind,
  type ResetTarget,
} from '@elysium/domain/iam';
import { z } from 'zod';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import type { ActiveContext } from '../../platform/http/context.js';
import {
  ApprovalsService,
  type ApprovalExecutor,
  type RejectionHandler,
} from '../approvals/approvals.service.js';
import { AUTH, PASSWORD_TOKENS, type PasswordTokenStore } from './iam.service.js';
import * as repo from './users.repository.js';
import { pgCode, usersHttpError } from './users.errors.js';

/**
 * Staff accounts for a brand's admin (gaps-users-auth, architecture §6, §25).
 *
 * Who works here and what they may do; a leaver switched off; a new hire's invite sent
 * again; a forgotten password or a lost phone reset. Every rule about *whose* sign-in an
 * admin may touch is `planCredentialReset` in `packages/domain`, so it can be walked as a
 * property; this service gathers the facts it needs and carries out what it decides.
 *
 * **Links are tokens the admin holds.** There is no email adapter (D-212), so a password
 * link is handed to the admin to pass on, as invites always were (D-057). Whoever holds
 * the link can set the password, so every link records its issuer as the granter of the
 * person's roles here (D-077, D-406), and a reset of anyone who can approve at org tier
 * waits for a second admin (D-404).
 */

/** What a `credential_reset` approval carries: whose sign-in, which part, which row. */
const resetPayloadSchema = z.object({
  resetId: z.string().uuid(),
  userId: z.string().min(1),
  kind: z.enum(['password', 'two_factor']),
});

export type StaffStatus = 'active' | 'invited' | 'deactivated' | 'disabled';

export interface StaffRow {
  readonly userId: string;
  readonly name: string;
  readonly email: string;
  readonly status: StaffStatus;
  readonly roles: readonly RoleGrant[];
  /** Roles held here before, now switched off: what a deactivated person used to do. */
  readonly formerRoles: readonly MembershipRole[];
  readonly twoFactorEnabled: boolean;
  readonly twoFactorRequired: boolean;
  readonly lastSignInAt: string | null;
  readonly hasPassword: boolean;
  /** When the newest unused password link stops working. */
  readonly linkExpiresAt: string | null;
  readonly isSuperAdmin: boolean;
  /** Also works in another brand: only a super admin resets their sign-in (D-405). */
  readonly inOtherBrand: boolean;
  readonly isSelf: boolean;
  /** A password or second-factor reset of this person needs a second admin (D-404). */
  readonly resetNeedsApproval: boolean;
}

export interface OpenResetView {
  readonly id: string;
  readonly userId: string;
  readonly kind: 'password' | 'two_factor';
  readonly status: 'pending_approval' | 'approved';
  readonly requestedBy: string;
  readonly requestedByName: string | null;
  readonly reason: string;
  readonly approvalRequestId: string | null;
  readonly createdAt: string;
  readonly decidedAt: string | null;
  /** The caller asked for it: theirs to collect once approved, never theirs to decide. */
  readonly mine: boolean;
}

export type LinkOutcome =
  | {
      readonly outcome: 'issued';
      readonly kind: 'invite' | 'password';
      readonly token: string;
      readonly expiresAt: string;
    }
  | {
      readonly outcome: 'pending_approval';
      readonly resetId: string;
      readonly approvalRequestId: string;
    };

export type TwoFactorOutcome =
  | { readonly outcome: 'completed'; readonly resetId: string; readonly sessionsEnded: number }
  | {
      readonly outcome: 'pending_approval';
      readonly resetId: string;
      readonly approvalRequestId: string;
    };

/** Everything the rules ask about the person being acted on. */
interface Target {
  readonly userId: string;
  readonly name: string;
  readonly email: string;
  readonly isSuperAdmin: boolean;
  readonly accountActive: boolean;
  readonly twoFactorEnabled: boolean;
  readonly hasPassword: boolean;
  readonly held: readonly repo.MembershipRow[];
  readonly activeRoles: readonly MembershipRole[];
  readonly inOtherBrand: boolean;
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function resetTarget(target: Target): ResetTarget {
  return {
    userId: target.userId,
    isSuperAdmin: target.isSuperAdmin,
    activeHere: target.accountActive && target.activeRoles.length > 0,
    inOtherBrand: target.inOtherBrand,
    hasPasswordAccount: target.hasPassword,
    twoFactorEnabled: target.twoFactorEnabled,
    needsSecondPerson: resetNeedsSecondPerson(target.activeRoles, target.isSuperAdmin),
  };
}

@Injectable()
export class UsersService {
  constructor(
    @Inject(AUTH) private readonly auth: Auth,
    @Inject(PASSWORD_TOKENS) private readonly tokens: PasswordTokenStore,
    private readonly audit: AuditService,
    private readonly approvals: ApprovalsService,
  ) {
    this.approvals.registerExecutor('credential_reset', this.executeReset);
    this.approvals.registerRejectionHandler('credential_reset', this.rejectReset);
  }

  // --- reading --------------------------------------------------------------------------

  /** Everyone who holds or held a role in this brand, and the resets still open. */
  async list(context: ActiveContext): Promise<{ items: StaffRow[]; resets: OpenResetView[] }> {
    const { memberships, resets } = await withOrg(
      { orgId: context.orgId, userId: context.userId },
      async (tx) => ({
        memberships: await repo.membershipsInOrg(tx, context.orgId),
        resets: await repo.openResets(tx, context.orgId),
      }),
    );

    const userIds = [...new Set(memberships.map((row) => row.user_id))];
    const requesterIds = resets.map((row) => row.requested_by);
    const found = await withGlobal(async (tx) =>
      repo.people(tx, [...new Set([...userIds, ...requesterIds])]),
    );
    const byId = new Map(found.map((person) => [person.id, person]));

    const elsewhere = new Map<string, boolean>();
    for (const userId of userIds) {
      elsewhere.set(userId, await this.activeElsewhere(userId, context.orgId));
    }

    const items: StaffRow[] = [];
    for (const userId of userIds) {
      const person = byId.get(userId);
      if (person === undefined) continue;
      const held = memberships.filter((row) => row.user_id === userId);
      items.push(this.view(context, person, held, elsewhere.get(userId) === true));
    }
    items.sort((a, b) => a.name.localeCompare(b.name) || a.email.localeCompare(b.email));

    return {
      items,
      resets: resets
        .filter((row) => row.kind !== 'invite')
        .map((row) => ({
          id: row.id,
          userId: row.user_id,
          kind: row.kind as 'password' | 'two_factor',
          status: row.status as 'pending_approval' | 'approved',
          requestedBy: row.requested_by,
          requestedByName: byId.get(row.requested_by)?.name ?? null,
          reason: row.reason,
          approvalRequestId: row.approval_request_id,
          createdAt: iso(row.created_at) ?? '',
          decidedAt: iso(row.decided_at),
          mine: row.requested_by === context.userId,
        })),
    };
  }

  private view(
    context: ActiveContext,
    person: repo.PersonRow,
    held: readonly repo.MembershipRow[],
    inOtherBrand: boolean,
  ): StaffRow {
    const active = held.filter((row) => row.is_active);
    const roles = active.map((row) => ({ role: row.role, branchIds: [...row.branch_ids] }));
    const status: StaffStatus = !person.is_active
      ? 'disabled'
      : active.length === 0
        ? 'deactivated'
        : person.has_password
          ? 'active'
          : 'invited';
    return {
      userId: person.id,
      name: person.name,
      email: person.email,
      status,
      roles,
      formerRoles: held.filter((row) => !row.is_active).map((row) => row.role),
      twoFactorEnabled: person.two_factor_enabled,
      twoFactorRequired: requiresTwoFactor(
        active.map((row) => row.role),
        person.is_super_admin,
      ),
      lastSignInAt: iso(person.last_sign_in_at),
      hasPassword: person.has_password,
      linkExpiresAt: iso(person.link_expires_at),
      isSuperAdmin: person.is_super_admin,
      inOtherBrand,
      isSelf: person.id === context.userId,
      resetNeedsApproval:
        !context.isSuperAdmin &&
        resetNeedsSecondPerson(
          active.map((row) => row.role),
          person.is_super_admin,
        ),
    };
  }

  private async activeElsewhere(userId: string, orgId: string): Promise<boolean> {
    return withUser({ userId }, async (tx) => repo.activeElsewhere(tx, userId, orgId));
  }

  /**
   * The person, as the rules need them. 404 for anyone with no role here, ever: an
   * admin of one brand learns nothing about another brand's people from this route.
   */
  private async target(context: ActiveContext, userId: string): Promise<Target> {
    const held = await withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) =>
      repo.membershipsOfUser(tx, context.orgId, userId),
    );
    if (held.length === 0) {
      throw usersHttpError('USER_NOT_FOUND', 'No such person in this organization.');
    }
    const [person] = await withGlobal(async (tx) => repo.people(tx, [userId]));
    if (person === undefined) {
      throw usersHttpError('USER_NOT_FOUND', 'No such person in this organization.');
    }
    return {
      userId,
      name: person.name,
      email: person.email,
      isSuperAdmin: person.is_super_admin,
      accountActive: person.is_active,
      twoFactorEnabled: person.two_factor_enabled,
      hasPassword: person.has_password,
      held,
      activeRoles: held.filter((row) => row.is_active).map((row) => row.role),
      inOtherBrand: await this.activeElsewhere(userId, context.orgId),
    };
  }

  /** Nobody manages their own access, and only a super admin manages a super admin. */
  private guardManage(context: ActiveContext, target: Target): void {
    if (target.userId === context.userId) {
      throw usersHttpError(
        'USER_SELF_MANAGEMENT',
        'Nobody changes their own access. Ask another admin.',
      );
    }
    if (target.isSuperAdmin && !context.isSuperAdmin) {
      throw usersHttpError('USER_PROTECTED', 'Only a super admin can change a super admin.');
    }
  }

  async get(context: ActiveContext, userId: string): Promise<StaffRow> {
    const held = await withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) =>
      repo.membershipsOfUser(tx, context.orgId, userId),
    );
    const [person] = await withGlobal(async (tx) => repo.people(tx, [userId]));
    if (held.length === 0 || person === undefined) {
      throw usersHttpError('USER_NOT_FOUND', 'No such person in this organization.');
    }
    return this.view(context, person, held, await this.activeElsewhere(userId, context.orgId));
  }

  // --- roles ----------------------------------------------------------------------------

  /**
   * Replace what a person may do in this brand (D-400).
   *
   * Takes effect on their next request: the context is rebuilt from memberships every
   * time, and a newly privileged role meets the enrolment wall at once (§6). Every role
   * granted or reshaped names the acting admin as its granter (D-077).
   */
  async setRoles(
    context: ActiveContext,
    request: AuditableRequest,
    userId: string,
    wanted: readonly RoleGrant[],
  ): Promise<StaffRow> {
    const target = await this.target(context, userId);
    this.guardManage(context, target);

    try {
      await withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const held = await repo.membershipsOfUser(tx, context.orgId, userId, { lock: true });
        const change = planRoleChange(
          held.map((row) => ({ role: row.role, active: row.is_active, branchIds: row.branch_ids })),
          wanted,
        );

        for (const role of [...change.grant, ...change.reshape]) {
          const membershipId = await repo.grantRole(tx, {
            orgId: context.orgId,
            userId,
            role,
            grantedBy: context.userId,
          });
          const branchIds = wanted.find((entry) => entry.role === role)?.branchIds ?? [];
          await repo.setBranches(tx, context.orgId, membershipId, branchIds);
        }
        await repo.revokeRoles(tx, context.orgId, userId, change.revoke);

        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'update',
          action: 'iam.roles_changed',
          entityType: 'User',
          entityId: userId,
          before: {
            roles: held
              .filter((row) => row.is_active)
              .map((row) => ({ role: row.role, branchIds: row.branch_ids })),
          },
          after: {
            roles: wanted.map((entry) => ({ role: entry.role, branchIds: entry.branchIds })),
            granted: change.grant,
            reshaped: change.reshape,
            revoked: change.revoke,
          },
          requestId: context.requestId,
          request,
        });
      });
    } catch (error) {
      // The composite foreign key: a branch of another brand, or of none (D-047).
      if (pgCode(error) === '23503') {
        throw new BadRequestException({
          code: 'VALIDATION_FAILED',
          message: 'One of those branches is not in this organization.',
        });
      }
      throw error;
    }

    return this.get(context, userId);
  }

  // --- deactivation ---------------------------------------------------------------------

  /**
   * Switch a leaver off in this brand (D-401).
   *
   * Their roles here end, their open resets are cancelled (and the approvals waiting on
   * them withdrawn), and their sessions end at once — every session, with every unused
   * link and remembered device, when this was the last brand they worked in; otherwise
   * only the sessions acting in this one. Nothing they wrote is touched.
   */
  async deactivate(
    context: ActiveContext,
    request: AuditableRequest,
    userId: string,
    reason: string | undefined,
  ): Promise<{
    userId: string;
    status: StaffStatus;
    sessionsEnded: number;
    resetsCancelled: number;
  }> {
    const target = await this.target(context, userId);
    this.guardManage(context, target);
    if (target.activeRoles.length === 0) {
      throw usersHttpError('USER_INACTIVE', 'This person is already deactivated here.');
    }

    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      await repo.membershipsOfUser(tx, context.orgId, userId, { lock: true });
      const revoked = await repo.revokeRoles(tx, context.orgId, userId, 'all');

      const open = await repo.openResetsTouching(tx, context.orgId, userId);
      for (const reset of open) {
        await repo.moveReset(tx, context.orgId, reset.id, { status: 'cancelled' });
        if (reset.status === 'pending_approval' && reset.approval_request_id !== null) {
          await this.approvals.cancelRaisedByModule(tx, context, {
            id: reset.approval_request_id,
            type: 'credential_reset',
            reason: 'The person was deactivated.',
            request,
          });
        }
      }

      const sessionsEnded = target.inOtherBrand
        ? await repo.endSessions(tx, userId, { orgId: context.orgId })
        : await repo.endSessions(tx, userId, 'all');
      const linksVoided = target.inOtherBrand
        ? 0
        : await repo.voidLinks(tx, userId, { devices: true });

      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: 'update',
        action: 'iam.user_deactivated',
        entityType: 'User',
        entityId: userId,
        before: { roles: target.activeRoles },
        after: {
          roles: [],
          revoked,
          reason: reason ?? null,
          sessionsEnded,
          linksVoided,
          resetsCancelled: open.length,
          stillInAnotherBrand: target.inOtherBrand,
        },
        requestId: context.requestId,
        request,
      });

      return {
        userId,
        status: 'deactivated' as const,
        sessionsEnded,
        resetsCancelled: open.length,
      };
    });
  }

  // --- password links -------------------------------------------------------------------

  /**
   * A password link for this person (D-402 to D-406), in one of three ways:
   *
   * - **collect** an approved reset this admin asked for, within 24 hours;
   * - **issue** at once — an invite sent again for someone who never set a password, a
   *   reset by a super admin, or a reset of someone who cannot approve anything;
   * - **ask** a second admin, for anyone who can approve at org tier.
   */
  async passwordLink(
    context: ActiveContext,
    request: AuditableRequest,
    userId: string,
    reason: string,
  ): Promise<LinkOutcome> {
    const target = await this.target(context, userId);

    const open = await withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      await repo.expireStaleResets(tx, context.orgId);
      return repo.openResetFor(tx, context.orgId, userId, 'password');
    });

    if (open !== undefined) {
      const collectable =
        open.status === 'approved' &&
        open.requested_by === context.userId &&
        open.decided_at !== null &&
        isCollectable(new Date(open.decided_at), new Date());
      if (!collectable) {
        throw usersHttpError(
          'CREDENTIAL_RESET_PENDING',
          open.status === 'pending_approval'
            ? 'A password reset for this person is already waiting for a second admin.'
            : 'A password reset for this person was approved for the admin who asked for it.',
        );
      }
      return this.collect(context, request, target, open);
    }

    const plan = planCredentialReset({
      actor: { userId: context.userId, isSuperAdmin: context.isSuperAdmin },
      target: resetTarget(target),
      kind: 'password',
    });
    if (plan.decision === 'refuse') throw usersHttpError(plan.code, plan.reason);
    await this.checkLimits(context, userId);

    if (plan.decision === 'approval') {
      return this.askSecondAdmin(context, request, target, 'password', reason);
    }

    const kind = plan.effect === 'invite' ? 'invite' : 'password';
    const link = await this.mint(target, kind);
    try {
      await withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const resetId = randomUUID();
        await this.applyPasswordLink(tx, context, target, kind);
        await repo.insertReset(tx, {
          id: resetId,
          orgId: context.orgId,
          userId,
          kind,
          status: 'completed',
          requestedBy: context.userId,
          reason,
          approvalRequestId: null,
          linkExpiresAt: link.expiresAt,
        });
        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'update',
          action: kind === 'invite' ? 'iam.invite_reissued' : 'iam.password_link_issued',
          entityType: 'User',
          entityId: userId,
          before: null,
          after: { resetId, reason, expiresAt: link.expiresAt.toISOString(), approvedBy: null },
          requestId: context.requestId,
          request,
        });
      });
    } catch (error) {
      await withGlobal(async (tx) => repo.deleteLink(tx, link.token)).catch(() => undefined);
      throw error;
    }

    return {
      outcome: 'issued',
      kind,
      token: link.token,
      expiresAt: link.expiresAt.toISOString(),
    };
  }

  /** Hand the admin who asked the link a second admin approved (D-404). */
  private async collect(
    context: ActiveContext,
    request: AuditableRequest,
    target: Target,
    reset: repo.ResetRow,
  ): Promise<LinkOutcome> {
    // The facts may have changed since the approval: re-ask the rules, short of the
    // second person they already had.
    const plan = planCredentialReset({
      actor: { userId: context.userId, isSuperAdmin: context.isSuperAdmin },
      target: resetTarget(target),
      kind: 'password',
    });
    if (plan.decision === 'refuse') {
      await withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) =>
        repo.moveReset(tx, context.orgId, reset.id, { status: 'cancelled' }),
      );
      throw usersHttpError(plan.code, plan.reason);
    }

    const link = await this.mint(target, 'password');
    try {
      await withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const current = await repo.resetById(tx, context.orgId, reset.id);
        if (current?.status !== 'approved' || current.requested_by !== context.userId) {
          throw usersHttpError('CONFLICT', 'That reset is no longer waiting to be collected.');
        }
        await this.applyPasswordLink(tx, context, target, 'password');
        await repo.moveReset(tx, context.orgId, reset.id, {
          status: 'completed',
          linkExpiresAt: link.expiresAt,
        });
        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'update',
          action: 'iam.password_link_issued',
          entityType: 'User',
          entityId: target.userId,
          before: null,
          after: {
            resetId: reset.id,
            reason: reset.reason,
            expiresAt: link.expiresAt.toISOString(),
            approvedBy: reset.decided_by,
          },
          requestId: context.requestId,
          request,
        });
      });
    } catch (error) {
      await withGlobal(async (tx) => repo.deleteLink(tx, link.token)).catch(() => undefined);
      throw error;
    }

    return {
      outcome: 'issued',
      kind: 'password',
      token: link.token,
      expiresAt: link.expiresAt.toISOString(),
    };
  }

  /**
   * What issuing a link does to the person, in the caller's transaction: the old password
   * stops working, every session ends, and the issuer becomes the granter of their roles
   * here (D-402, D-406). For an invite there is no password and no session to end.
   */
  private async applyPasswordLink(
    tx: Tx,
    context: ActiveContext,
    target: Target,
    kind: 'invite' | 'password',
  ): Promise<void> {
    if (kind === 'password') {
      await repo.voidPassword(tx, target.userId);
      await repo.endSessions(tx, target.userId, 'all');
    }
    await repo.recordGranter(tx, context.orgId, target.userId, context.userId);
  }

  /**
   * Mint a password link through Better Auth's own reset flow, so the token, its storage
   * and the redemption endpoint are the library's. Every earlier link is voided first —
   * one person, one working link — and the new one is given its lifetime (D-402).
   */
  private async mint(
    target: Target,
    kind: 'invite' | 'password',
  ): Promise<{ token: string; expiresAt: Date }> {
    await withGlobal(async (tx) => repo.voidLinks(tx, target.userId, { devices: false }));
    this.tokens.take(target.email);
    await this.auth.api.requestPasswordReset({
      body: { email: target.email, redirectTo: '/accept-invite' },
      headers: new Headers(),
    });
    const token = this.tokens.take(target.email);
    if (token === undefined) throw new Error('Better Auth minted no password link.');

    const expiresAt = await withGlobal(async (tx) =>
      repo.setLinkExpiry(
        tx,
        token,
        kind === 'invite' ? INVITE_LINK_SECONDS : PASSWORD_LINK_SECONDS,
      ),
    );
    if (expiresAt === null) throw new Error('The password link vanished as it was minted.');
    return { token, expiresAt };
  }

  // --- second factors -------------------------------------------------------------------

  /**
   * Remove a lost phone's second factor (D-403). Their sessions and remembered devices
   * end with it, and the next sign-in meets the enrolment wall if their role needs one.
   */
  async resetTwoFactor(
    context: ActiveContext,
    request: AuditableRequest,
    userId: string,
    reason: string,
  ): Promise<TwoFactorOutcome> {
    const target = await this.target(context, userId);

    const open = await withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) =>
      repo.openResetFor(tx, context.orgId, userId, 'two_factor'),
    );
    if (open !== undefined) {
      throw usersHttpError(
        'CREDENTIAL_RESET_PENDING',
        'A two-step verification reset for this person is already waiting for a second admin.',
      );
    }

    const plan = planCredentialReset({
      actor: { userId: context.userId, isSuperAdmin: context.isSuperAdmin },
      target: resetTarget(target),
      kind: 'two_factor',
    });
    if (plan.decision === 'refuse') throw usersHttpError(plan.code, plan.reason);
    await this.checkLimits(context, userId);

    if (plan.decision === 'approval') {
      return this.askSecondAdmin(context, request, target, 'two_factor', reason);
    }

    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const resetId = randomUUID();
      const sessionsEnded = await this.removeTwoFactor(tx, target.userId);
      await repo.insertReset(tx, {
        id: resetId,
        orgId: context.orgId,
        userId,
        kind: 'two_factor',
        status: 'completed',
        requestedBy: context.userId,
        reason,
        approvalRequestId: null,
        linkExpiresAt: null,
      });
      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: 'update',
        action: 'iam.two_factor_reset',
        entityType: 'User',
        entityId: userId,
        before: { twoFactorEnabled: true },
        after: { twoFactorEnabled: false, resetId, reason, sessionsEnded, approvedBy: null },
        requestId: context.requestId,
        request,
      });
      return { outcome: 'completed' as const, resetId, sessionsEnded };
    });
  }

  private async removeTwoFactor(tx: Tx, userId: string): Promise<number> {
    await repo.removeSecondFactor(tx, userId);
    await repo.voidLinks(tx, userId, { devices: true });
    return repo.endSessions(tx, userId, 'all');
  }

  // --- the second admin -----------------------------------------------------------------

  private async checkLimits(context: ActiveContext, userId: string): Promise<void> {
    const counts = await withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) =>
      repo.resetCounts(tx, context.orgId, context.userId, userId),
    );
    if (!resetAllowedByLimits(counts)) {
      throw usersHttpError(
        'RATE_LIMITED',
        'Too many sign-in resets. An admin may ask for 20 an hour, and one person may be reset 5 times a day.',
      );
    }
  }

  /**
   * Raise the `credential_reset` approval, then record the reset that waits on it.
   *
   * Two transactions, as a loan repayment's are: `ApprovalsService.request` opens its
   * own. If the second fails — another admin asked in the same moment and the unique
   * index refused this one — the approval is withdrawn rather than left naming nothing.
   */
  private async askSecondAdmin(
    context: ActiveContext,
    request: AuditableRequest,
    target: Target,
    kind: ResetKind,
    reason: string,
  ): Promise<{ outcome: 'pending_approval'; resetId: string; approvalRequestId: string }> {
    const resetId = randomUUID();
    const raised = await this.approvals.request(context, {
      type: 'credential_reset',
      amountPoisha: null,
      payload: { resetId, userId: target.userId, kind },
      reason: `${kind === 'password' ? 'Password link' : 'Two-step verification reset'} for ${target.name}: ${reason}`,
      raisedByModule: true,
      request,
    });
    if (raised.status !== 'pending') {
      throw new ConflictException('A sign-in reset always waits for a second admin.');
    }

    try {
      await withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        await repo.insertReset(tx, {
          id: resetId,
          orgId: context.orgId,
          userId: target.userId,
          kind,
          status: 'pending_approval',
          requestedBy: context.userId,
          reason,
          approvalRequestId: raised.id,
          linkExpiresAt: null,
        });
        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'create',
          action: 'iam.credential_reset_requested',
          entityType: 'User',
          entityId: target.userId,
          before: null,
          after: { resetId, kind, reason, approvalRequestId: raised.id },
          requestId: context.requestId,
          request,
        });
      });
    } catch (error) {
      await withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) =>
        this.approvals.cancelRaisedByModule(tx, context, {
          id: raised.id,
          type: 'credential_reset',
          reason: 'The reset could not be recorded.',
        }),
      ).catch(() => undefined);
      if (pgCode(error) === '23505') {
        throw usersHttpError(
          'CREDENTIAL_RESET_PENDING',
          'Another admin asked for the same reset a moment ago.',
        );
      }
      throw error;
    }

    return { outcome: 'pending_approval', resetId, approvalRequestId: raised.id };
  }

  /** The reset an approval names, checked against the approval itself. */
  private async waitingReset(
    tx: Tx,
    context: ActiveContext,
    approval: { readonly id: string; readonly payload: Record<string, unknown> },
  ): Promise<repo.ResetRow> {
    const parsed = resetPayloadSchema.safeParse(approval.payload);
    const reset = parsed.success
      ? await repo.resetById(tx, context.orgId, parsed.data.resetId)
      : undefined;
    if (
      !parsed.success ||
      reset?.status !== 'pending_approval' ||
      reset.approval_request_id !== approval.id ||
      reset.user_id !== parsed.data.userId ||
      reset.kind !== parsed.data.kind
    ) {
      throw new ConflictException(
        'That approval names no sign-in reset waiting for it; reject it instead.',
      );
    }
    // The approvals service keeps the requester out; this keeps the subject out (D-404).
    if (reset.user_id === context.userId) {
      throw new ForbiddenException('Nobody decides a reset of their own sign-in.');
    }
    return reset;
  }

  /** Approved: a second factor goes now; a password link waits to be collected. */
  private readonly executeReset: ApprovalExecutor = async (tx, { context, approval, request }) => {
    const reset = await this.waitingReset(tx, context, approval);

    if (reset.kind === 'two_factor') {
      const sessionsEnded = await this.removeTwoFactor(tx, reset.user_id);
      await repo.moveReset(tx, context.orgId, reset.id, {
        status: 'completed',
        decidedBy: context.userId,
      });
      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: 'approve',
        action: 'iam.two_factor_reset',
        entityType: 'User',
        entityId: reset.user_id,
        before: { twoFactorEnabled: true },
        after: {
          twoFactorEnabled: false,
          resetId: reset.id,
          reason: reset.reason,
          sessionsEnded,
          requestedBy: reset.requested_by,
          approvedBy: context.userId,
        },
        requestId: context.requestId,
        ...(request === undefined ? {} : { request }),
      });
      return;
    }

    await repo.moveReset(tx, context.orgId, reset.id, {
      status: 'approved',
      decidedBy: context.userId,
    });
    await this.audit.record(tx, {
      orgId: context.orgId,
      actorUserId: context.userId,
      operation: 'approve',
      action: 'iam.password_reset_approved',
      entityType: 'User',
      entityId: reset.user_id,
      before: null,
      after: { resetId: reset.id, requestedBy: reset.requested_by, approvedBy: context.userId },
      requestId: context.requestId,
      ...(request === undefined ? {} : { request }),
    });
  };

  private readonly rejectReset: RejectionHandler = async (tx, { context, approval, request }) => {
    const reset = await this.waitingReset(tx, context, approval);
    await repo.moveReset(tx, context.orgId, reset.id, {
      status: 'rejected',
      decidedBy: context.userId,
    });
    await this.audit.record(tx, {
      orgId: context.orgId,
      actorUserId: context.userId,
      operation: 'reject',
      action: 'iam.credential_reset_rejected',
      entityType: 'User',
      entityId: reset.user_id,
      before: null,
      after: { resetId: reset.id, kind: reset.kind, requestedBy: reset.requested_by },
      requestId: context.requestId,
      ...(request === undefined ? {} : { request }),
    });
  };
}
