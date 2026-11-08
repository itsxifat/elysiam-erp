import { randomUUID } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { MembershipRole, RoleGrant } from '@elysium/contracts';
import {
  INVITE_LINK_SECONDS,
  loadTwoFactorPolicy,
  PASSWORD_LINK_SECONDS,
  requiresTwoFactor,
  twoFactorStanding,
  withOrg,
  type Tx,
} from '@elysium/db';
import {
  isCollectable,
  isRemovableSuperAdmin,
  isSuperAdminCandidate,
  planCredentialReset,
  planRoleChange,
  resetAllowedByLimits,
  type ResetKind,
  type TwoFactorPolicy,
  type ResetPlan,
  type ResetTarget,
} from '@elysium/domain/iam';
import { z } from 'zod';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import type { ActiveContext } from '../../platform/http/context.js';
import {
  ApprovalsService,
  type ApprovalExecutor,
  type OwnedApprovalType,
  type RejectionHandler,
} from '../approvals/approvals.service.js';
import * as repo from './users.repository.js';
import {
  makeSuperAdmin,
  removeSuperAdmin,
  requireSuperAdmin,
  requireSuperAdminToRemove,
  stepDown,
  type NominationOutcome,
  type RemovalOutcome,
} from './super-admin.js';
import { activeSuperAdmins, superAdminIds } from './super-admin.repository.js';
import { pgCode, usersHttpError } from './users.errors.js';

/**
 * Staff accounts for a brand's admin (gaps-users-auth, architecture §6, §25).
 *
 * Who works here and what they may do; a leaver switched off; a new hire's invite sent
 * again; a forgotten password or a lost phone reset. Every rule about *whose* sign-in an
 * admin may touch is `planCredentialReset` in `packages/domain`, so it can be walked as a
 * property; this service gathers the facts it needs and carries out what it decides.
 *
 * **One transaction per action, facts read inside it** (the ledger audit's W4–W6). Each
 * action takes the person lock (`lockPerson`, one per person across brands), reads the
 * facts, decides, and acts —
 * minting a link included — before committing, so no promotion, second brand or parallel
 * reset slips between the check and the write, and a failure leaves nothing half done.
 *
 * **Links are tokens the admin holds.** There is no email adapter (D-212), so a password
 * link is handed to the admin to pass on, as invites always were (D-057). Whoever holds
 * the link could set the password; it is recorded as a grant (D-406). A reset the rules
 * allow happens at once (D-954): no second admin.
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
  /**
   * An owner (D-473), listed as a super admin (D-658). Their name and email are empty for
   * everyone but another owner: the console shows "Owner".
   */
  readonly isOwner: boolean;
  /**
   * Holds or held a role here, so the Staff screen's actions reach them. A super admin with
   * no role here, or an owner, is listed but managed nowhere on this screen.
   */
  readonly hasRoleHere: boolean;
  /** Also works in another brand: only a super admin resets their sign-in (D-405). */
  readonly inOtherBrand: boolean;
  readonly isSelf: boolean;
  /** The caller may make this person a super admin now (D-954): a super admin, an active admin. */
  readonly canMakeSuperAdmin: boolean;
  /** The caller may remove this person's super admin power now (D-954). */
  readonly canRemoveSuperAdmin: boolean;
  /** This is the caller's own row and they may step down: another super admin remains. */
  readonly canStepDown: boolean;
}

/** Owners first, then super admins, then everyone else; by name within each. */
function rank(row: StaffRow): number {
  if (row.isOwner) return 0;
  return row.isSuperAdmin ? 1 : 2;
}

/** Who asked for a reset, as this caller may see them: an owner is "Owner" (D-473). */
function requesterView(
  person: { readonly name: string; readonly is_owner: boolean } | undefined,
  viewer: { readonly isOwner?: boolean | undefined },
): { requestedByName: string | null; requestedByOwner: boolean } {
  if (person === undefined) return { requestedByName: null, requestedByOwner: false };
  if (person.is_owner) {
    return {
      requestedByName: viewer.isOwner === true ? person.name : null,
      requestedByOwner: true,
    };
  }
  return { requestedByName: person.name, requestedByOwner: false };
}

export interface OpenResetView {
  readonly id: string;
  readonly userId: string;
  readonly kind: 'password' | 'two_factor';
  readonly status: 'pending_approval' | 'approved';
  readonly requestedBy: string;
  /** Null for an owner unless the caller is one too (D-473): the console shows "Owner". */
  readonly requestedByName: string | null;
  readonly requestedByOwner: boolean;
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

/** Everything the rules ask about the person being acted on, read in the acting transaction. */
interface Target {
  readonly userId: string;
  readonly name: string;
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

/** The rules' view of a person. */
function resetTarget(target: Target): ResetTarget {
  return {
    userId: target.userId,
    isSuperAdmin: target.isSuperAdmin,
    activeHere: target.accountActive && target.activeRoles.length > 0,
    inOtherBrand: target.inOtherBrand,
    hasPasswordAccount: target.hasPassword,
    twoFactorEnabled: target.twoFactorEnabled,
  };
}

/**
 * The database refused a promotion or removal the service had just checked (migration 0170):
 * a race lost to another super admin's change, answered with a 409 to read again.
 */
function promotionRaceLost(error: unknown): unknown {
  const code = pgCode(error);
  if (code === '42501' || code === '23514') {
    return usersHttpError(
      'CONFLICT',
      'The super admins changed a moment ago. Read the Staff screen again and retry.',
    );
  }
  return error;
}

const NOT_FOUND = (): never => {
  throw usersHttpError('USER_NOT_FOUND', 'No such person in this organization.');
};

@Injectable()
export class UsersService {
  private readonly resets: OwnedApprovalType;

  constructor(
    private readonly audit: AuditService,
    private readonly approvals: ApprovalsService,
  ) {
    this.resets = this.approvals.registerExecutor('credential_reset', this.executeReset);
    this.approvals.registerRejectionHandler('credential_reset', this.rejectReset);
  }

  private inOrg<T>(context: ActiveContext, work: (tx: Tx) => Promise<T>): Promise<T> {
    return withOrg({ orgId: context.orgId, userId: context.userId }, work);
  }

  // --- reading --------------------------------------------------------------------------

  /**
   * Everyone who holds or held a role in this brand, every super admin — owners among them,
   * as "Owner" (D-658) — and the resets still open.
   */
  async list(context: ActiveContext): Promise<{
    items: StaffRow[];
    resets: OpenResetView[];
    /** The caller may invite a super admin: any super admin (D-954). */
    canStartSuperAdmin: boolean;
  }> {
    return this.inOrg(context, async (tx) => {
      const memberships = await repo.membershipsInOrg(tx, context.orgId);
      const resets = await repo.openResets(tx, context.orgId);
      const userIds = [
        ...new Set([...memberships.map((row) => row.user_id), ...(await superAdminIds(tx))]),
      ];
      const found = await repo.people(tx, [
        ...new Set([...userIds, ...resets.map((row) => row.requested_by)]),
      ]);
      const byId = new Map(found.map((person) => [person.id, person]));
      const elsewhere = await repo.activeElsewhere(tx, userIds, context.orgId);
      const superAdmins = await activeSuperAdmins(tx);
      const policy = await loadTwoFactorPolicy(tx, context.orgId);

      const items: StaffRow[] = [];
      for (const userId of userIds) {
        const person = byId.get(userId);
        if (person === undefined) continue;
        // An owner holds no role here (D-473), and is listed only as a super admin.
        if (person.is_owner && !person.is_super_admin) continue;
        const held = person.is_owner ? [] : memberships.filter((row) => row.user_id === userId);
        items.push(this.view(context, person, held, elsewhere.has(userId), superAdmins, policy));
      }
      items.sort(
        (a, b) =>
          rank(a) - rank(b) || a.name.localeCompare(b.name) || a.email.localeCompare(b.email),
      );

      return {
        items,
        canStartSuperAdmin: context.isSuperAdmin,
        resets: resets
          .filter((row) => row.kind !== 'invite')
          .map((row) => ({
            id: row.id,
            userId: row.user_id,
            kind: row.kind as 'password' | 'two_factor',
            status: row.status as 'pending_approval' | 'approved',
            requestedBy: row.requested_by,
            ...requesterView(byId.get(row.requested_by), context),
            reason: row.reason,
            approvalRequestId: row.approval_request_id,
            createdAt: iso(row.created_at) ?? '',
            decidedAt: iso(row.decided_at),
            mine: row.requested_by === context.userId,
          })),
      };
    });
  }

  async get(context: ActiveContext, userId: string): Promise<StaffRow> {
    return this.inOrg(context, async (tx) => {
      const held = await repo.membershipsOfUser(tx, context.orgId, userId);
      const [person] = await repo.people(tx, [userId]);
      if (held.length === 0 || person === undefined || person.is_owner) return NOT_FOUND();
      const elsewhere = await repo.activeElsewhere(tx, [userId], context.orgId);
      const superAdmins = await activeSuperAdmins(tx);
      const policy = await loadTwoFactorPolicy(tx, context.orgId);
      return this.view(context, person, held, elsewhere.has(userId), superAdmins, policy);
    });
  }

  private view(
    context: ActiveContext,
    person: repo.PersonRow,
    held: readonly repo.MembershipRow[],
    inOtherBrand: boolean,
    superAdmins: readonly string[],
    policy: TwoFactorPolicy,
  ): StaffRow {
    const active = held.filter((row) => row.is_active);
    // A super admin reaches every brand with or without a role here (section 6).
    const reachesHere = active.length > 0 || person.is_super_admin;
    const status: StaffStatus = !person.is_active
      ? 'disabled'
      : !reachesHere
        ? 'deactivated'
        : person.has_password || person.is_owner
          ? 'active'
          : 'invited';
    // An owner is "Owner" to everyone but another owner (D-473, D-476).
    const masked = person.is_owner && context.isOwner !== true;
    const candidate = {
      userId: person.id,
      isActive: person.is_active,
      isSuperAdmin: person.is_super_admin,
      isOwner: person.is_owner,
      activeAdminHere: active.some((row) => row.role === 'org_admin'),
    };
    const self = person.id === context.userId;
    // The brand is never left without a super admin (owners aside).
    const othersRemain = superAdmins.some((id) => id !== person.id);
    return {
      userId: person.id,
      name: masked ? '' : person.name,
      email: masked ? '' : person.email,
      status,
      roles: active.map((row) => ({ role: row.role, branchIds: [...row.branch_ids] })),
      formerRoles: held.filter((row) => !row.is_active).map((row) => row.role),
      // An owner's link is minted behind the mother's second factor (D-473).
      twoFactorEnabled: person.two_factor_enabled || person.is_owner,
      // This brand's own policy (M40, D-691): the roles its super admin made required.
      twoFactorRequired: requiresTwoFactor(
        active.map((row) => row.role),
        person.is_super_admin,
        policy,
      ),
      lastSignInAt: iso(person.last_sign_in_at),
      hasPassword: person.has_password,
      linkExpiresAt: iso(person.link_expires_at),
      isSuperAdmin: person.is_super_admin,
      isOwner: person.is_owner,
      hasRoleHere: held.length > 0,
      inOtherBrand,
      isSelf: self,
      canMakeSuperAdmin: context.isSuperAdmin && !self && isSuperAdminCandidate(candidate),
      canRemoveSuperAdmin:
        context.isSuperAdmin && !self && isRemovableSuperAdmin(candidate) && othersRemain,
      canStepDown: self && context.isSuperAdmin && isRemovableSuperAdmin(candidate) && othersRemain,
    };
  }

  // --- super admins (D-954: a super admin's permission, at once) ----------------------------

  /** Make an active admin here a super admin, at once. */
  async makeSuperAdmin(
    context: ActiveContext,
    request: AuditableRequest,
    userId: string,
  ): Promise<NominationOutcome> {
    requireSuperAdmin(context);
    try {
      return await this.inOrg(context, async (tx) =>
        makeSuperAdmin(tx, this.audit, context, userId, request),
      );
    } catch (error) {
      throw promotionRaceLost(error);
    }
  }

  /** Remove another super admin's super admin power, at once; an admin role here stays. */
  async removeSuperAdmin(
    context: ActiveContext,
    request: AuditableRequest,
    userId: string,
  ): Promise<RemovalOutcome> {
    requireSuperAdminToRemove(context);
    try {
      return await this.inOrg(context, async (tx) =>
        removeSuperAdmin(tx, this.audit, context, userId, request),
      );
    } catch (error) {
      throw promotionRaceLost(error);
    }
  }

  /** Give up your own super admin power at once; never the last super admin (D-685). */
  async stepDown(
    context: ActiveContext,
    request: AuditableRequest,
  ): Promise<{ userId: string; sessionsEnded: number }> {
    requireSuperAdminToRemove(context);
    try {
      return await this.inOrg(context, async (tx) => stepDown(tx, this.audit, context, request));
    } catch (error) {
      throw promotionRaceLost(error);
    }
  }

  /**
   * The person, as the rules need them, under the person lock. 404 for anyone with no
   * role here, ever: an admin of one brand learns nothing about another brand's people.
   */
  private async target(tx: Tx, orgId: string, userId: string): Promise<Target> {
    await repo.lockPerson(tx, userId);
    const held = await repo.membershipsOfUser(tx, orgId, userId, { lock: true });
    if (held.length === 0) return NOT_FOUND();
    const [person] = await repo.people(tx, [userId]);
    if (person === undefined) return NOT_FOUND();
    const elsewhere = await repo.activeElsewhere(tx, [userId], orgId);
    return {
      userId,
      name: person.name,
      isSuperAdmin: person.is_super_admin,
      accountActive: person.is_active,
      twoFactorEnabled: person.two_factor_enabled,
      hasPassword: person.has_password,
      held,
      activeRoles: held.filter((row) => row.is_active).map((row) => row.role),
      inOtherBrand: elsewhere.has(userId),
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

  // --- roles ----------------------------------------------------------------------------

  /**
   * Replace what a person may do in this brand (D-400).
   *
   * Takes effect on their next request: the context is rebuilt from memberships every
   * time, and a newly privileged role meets the enrolment wall at once (§6). Every role
   * granted or reshaped records the acting admin as its granter.
   */
  async setRoles(
    context: ActiveContext,
    request: AuditableRequest,
    userId: string,
    wanted: readonly RoleGrant[],
  ): Promise<StaffRow> {
    try {
      await this.inOrg(context, async (tx) => {
        const target = await this.target(tx, context.orgId, userId);
        this.guardManage(context, target);
        const change = planRoleChange(
          target.held.map((row) => ({
            role: row.role,
            active: row.is_active,
            branchIds: row.branch_ids,
          })),
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
        if (change.grant.length + change.reshape.length > 0) {
          await repo.addGranter(tx, {
            orgId: context.orgId,
            userId,
            grantedBy: context.userId,
            reason: 'role_granted',
          });
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
            roles: target.held
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
   * link and remembered device, when this was the last brand they work in; otherwise
   * only the sessions acting in this one. Nothing they wrote is touched.
   *
   * The approvals are withdrawn first, before the person lock, in a fixed order, to keep
   * the order a decision also follows (approval row, then person): a checker approving one
   * of these resets at the same moment either finishes first or finds it withdrawn. A
   * reset raised in the moment between is not withdrawn under the person lock — that would
   * take an approval row after it — but answered with a 409 to retry, whose first pass
   * then withdraws it in order (the re-audit's W1).
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
    return this.inOrg(context, async (tx) => {
      const waiting = (
        await repo.openResetsTouching(tx, context.orgId, userId, { lock: false })
      ).filter((row) => row.status === 'pending_approval' && row.approval_request_id !== null);
      const withdraw = async (approvalId: string) =>
        this.resets.cancel(tx, context, {
          id: approvalId,
          reason: 'The person was deactivated.',
          request,
        });
      const withdrawn = new Set<string>();
      for (const reset of waiting) {
        if (reset.approval_request_id === null) continue;
        await withdraw(reset.approval_request_id);
        withdrawn.add(reset.approval_request_id);
      }

      const target = await this.target(tx, context.orgId, userId);
      this.guardManage(context, target);
      if (target.activeRoles.length === 0) {
        throw usersHttpError('USER_INACTIVE', 'This person is already deactivated here.');
      }
      const revoked = await repo.revokeRoles(tx, context.orgId, userId, 'all');

      const open = await repo.openResetsTouching(tx, context.orgId, userId, { lock: true });
      for (const reset of open) {
        if (
          reset.status === 'pending_approval' &&
          (reset.approval_request_id === null || !withdrawn.has(reset.approval_request_id))
        ) {
          throw usersHttpError(
            'CONFLICT',
            'A sign-in reset for this person was asked for a moment ago. Deactivate them again.',
          );
        }
        await repo.moveReset(tx, context.orgId, reset.id, { status: 'cancelled' });
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
   *   reset by a super admin, or a reset of someone who never could raise or decide an
   *   approval here;
   * - **ask** a second admin, for everyone else.
   */
  async passwordLink(
    context: ActiveContext,
    request: AuditableRequest,
    userId: string,
    reason: string,
  ): Promise<LinkOutcome> {
    const result = await this.inOrg<
      LinkOutcome | { refused: Extract<ResetPlan, { decision: 'refuse' }> }
    >(context, async (tx) => {
      const target = await this.target(tx, context.orgId, userId);
      await repo.expireStaleResets(tx, context.orgId, userId);
      const open = await repo.openResetFor(tx, context.orgId, userId, 'password');

      if (open !== undefined) {
        const collectable =
          open.status === 'approved' &&
          open.requested_by === context.userId &&
          open.decided_at !== null &&
          isCollectable(new Date(open.decided_at), new Date());
        // Migration 0170 closed every reset left open before D-954; none opens since.
        if (!collectable) {
          throw usersHttpError(
            'CREDENTIAL_RESET_PENDING',
            'An older password reset for this person is still open.',
          );
        }
        return this.collect(tx, context, request, target, open);
      }

      const plan = this.plan(context, target, 'password');
      await this.checkLimits(tx, context, userId);

      const kind: 'invite' | 'password' = plan.effect === 'invite' ? 'invite' : 'password';
      const link = await this.issueLink(tx, context, target, kind);
      const resetId = randomUUID();
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
      return {
        outcome: 'issued' as const,
        kind,
        token: link.token,
        expiresAt: link.expiresAt.toISOString(),
      };
    });

    if ('refused' in result) throw usersHttpError(result.refused.code, result.refused.reason);
    return result;
  }

  /**
   * Hand the admin who asked the link a second admin approved (D-404). The rules are asked
   * again first, short of the second person they already had: if the person has since
   * left or joined another brand, the reset is cancelled — and stays cancelled, which is
   * why the refusal is returned rather than thrown inside the transaction.
   */
  private async collect(
    tx: Tx,
    context: ActiveContext,
    request: AuditableRequest,
    target: Target,
    reset: repo.ResetRow,
  ): Promise<LinkOutcome | { refused: Extract<ResetPlan, { decision: 'refuse' }> }> {
    const plan = planCredentialReset({
      actor: { userId: context.userId, isSuperAdmin: context.isSuperAdmin },
      target: resetTarget(target),
      kind: 'password',
    });
    if (plan.decision === 'refuse') {
      await repo.moveReset(tx, context.orgId, reset.id, { status: 'cancelled' });
      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: 'update',
        action: 'iam.credential_reset_cancelled',
        entityType: 'User',
        entityId: target.userId,
        before: { resetId: reset.id, status: 'approved' },
        after: { resetId: reset.id, status: 'cancelled', why: plan.code },
        requestId: context.requestId,
        request,
      });
      return { refused: plan };
    }

    const link = await this.issueLink(tx, context, target, 'password');
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
    return {
      outcome: 'issued',
      kind: 'password',
      token: link.token,
      expiresAt: link.expiresAt.toISOString(),
    };
  }

  /**
   * Mint a link and do what issuing one does to the person, in the caller's transaction:
   * every earlier link stops working; for a reset, the old password too, with every
   * session and pending second-factor challenge; and the issuer joins the person's
   * lineage here, because they could set the password themselves (D-402, D-406).
   */
  private async issueLink(
    tx: Tx,
    context: ActiveContext,
    target: Target,
    kind: 'invite' | 'password',
  ): Promise<{ token: string; expiresAt: Date }> {
    await repo.voidLinks(tx, target.userId, { devices: kind === 'password' });
    if (kind === 'password') {
      await repo.voidPassword(tx, target.userId);
      await repo.endSessions(tx, target.userId, 'all');
    }
    await repo.addGranter(tx, {
      orgId: context.orgId,
      userId: target.userId,
      grantedBy: context.userId,
      reason: 'link_issued',
    });
    return repo.mintLink(
      tx,
      target.userId,
      kind === 'invite' ? INVITE_LINK_SECONDS : PASSWORD_LINK_SECONDS,
    );
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
    return this.removeFactorFor(context, request, userId, reason, 'reset');
  }

  /**
   * Turn a person's two-step sign-in off for good (M40, D-697): only when nothing requires it
   * of them — no role in any brand under that brand's policy, not a super admin — and otherwise
   * exactly a reset: the same rules, limits, reset log and second admin (D-403 to D-406). For
   * someone whose role requires it, the lost-phone reset stays the way.
   */
  async turnOffTwoFactor(
    context: ActiveContext,
    request: AuditableRequest,
    userId: string,
    reason: string,
  ): Promise<TwoFactorOutcome> {
    return this.removeFactorFor(context, request, userId, reason, 'turn_off');
  }

  private async removeFactorFor(
    context: ActiveContext,
    request: AuditableRequest,
    userId: string,
    reason: string,
    mode: 'reset' | 'turn_off',
  ): Promise<TwoFactorOutcome> {
    const action = mode === 'reset' ? 'iam.two_factor_reset' : 'iam.two_factor_turned_off';
    return this.inOrg(context, async (tx) => {
      const target = await this.target(tx, context.orgId, userId);
      const open = await repo.openResetFor(tx, context.orgId, userId, 'two_factor');
      // Migration 0170 closed every reset left open before D-954; none opens since.
      if (open !== undefined) {
        throw usersHttpError(
          'CREDENTIAL_RESET_PENDING',
          'An older two-step verification reset for this person is still open.',
        );
      }
      this.plan(context, target, 'two_factor');
      // Asked only once the person is known to work here and the actor may act on them
      // (the ledger audit's W2): before that, the answer would say what another brand requires.
      if (mode === 'turn_off') {
        const standing = await twoFactorStanding(userId);
        if (standing.requirement.required) {
          throw usersHttpError(
            'TWO_FACTOR_REQUIRED',
            standing.requirement.isSuperAdmin
              ? 'Super admins always use two-step sign-in. Reset it instead if their phone is lost.'
              : 'A role this person holds requires two-step sign-in. Reset it instead if their phone is lost.',
          );
        }
      }
      await this.checkLimits(tx, context, userId);

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
        action,
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

  // --- signing a person out ---------------------------------------------------------------

  /**
   * End a person's sessions (M40, D-696): every one of them. Ending only those acting in this
   * brand would last one click for someone who also works elsewhere — any other session of
   * theirs can switch straight back (the ledger audit's W5) — and ending a session takes
   * nothing from them: their password and second factor are untouched, and they simply sign in
   * again. Not yourself (My account signs out your devices); a super admin only by a super
   * admin; an owner never, from here (they hold no role, so they are not found).
   */
  async signOutEverywhere(
    context: ActiveContext,
    request: AuditableRequest,
    userId: string,
  ): Promise<{ userId: string; sessionsEnded: number; scope: 'all' }> {
    if (userId === context.userId) {
      throw usersHttpError(
        'USER_SELF_MANAGEMENT',
        'Sign your own devices out from My account → Devices.',
      );
    }
    return this.inOrg(context, async (tx) => {
      const target = await this.target(tx, context.orgId, userId);
      this.guardManage(context, target);
      const scope = 'all' as const;
      const sessionsEnded = await repo.endSessions(tx, userId, 'all');
      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: 'delete',
        action: 'iam.user_signed_out_everywhere',
        entityType: 'User',
        entityId: userId,
        before: null,
        after: { sessionsEnded, scope },
        requestId: context.requestId,
        request,
      });
      return { userId, sessionsEnded, scope };
    });
  }

  private async removeTwoFactor(tx: Tx, userId: string): Promise<number> {
    await repo.removeSecondFactor(tx, userId);
    await repo.voidLinks(tx, userId, { devices: true });
    return repo.endSessions(tx, userId, 'all');
  }

  // --- the rules and the second admin -----------------------------------------------------

  /** Ask the rules; a refusal is the answer, with its own code. */
  private plan(
    context: ActiveContext,
    target: Target,
    kind: ResetKind,
  ): Exclude<ResetPlan, { decision: 'refuse' }> {
    const plan = planCredentialReset({
      actor: { userId: context.userId, isSuperAdmin: context.isSuperAdmin },
      target: resetTarget(target),
      kind,
    });
    if (plan.decision === 'refuse') throw usersHttpError(plan.code, plan.reason);
    return plan;
  }

  /** The reset limits, counted under the person lock so parallel asks cannot pass them. */
  private async checkLimits(tx: Tx, context: ActiveContext, userId: string): Promise<void> {
    const counts = await repo.resetCounts(tx, context.orgId, context.userId, userId);
    if (!resetAllowedByLimits(counts)) {
      throw usersHttpError(
        'RATE_LIMITED',
        'Too many sign-in resets. An admin may ask for 20 an hour, and one person may be reset 5 times a day.',
      );
    }
  }

  /** The reset an approval names, if the approval names one that is still waiting. */
  private async waitingReset(
    tx: Tx,
    context: ActiveContext,
    approval: { readonly id: string; readonly payload: Record<string, unknown> },
  ): Promise<repo.ResetRow | null> {
    const parsed = resetPayloadSchema.safeParse(approval.payload);
    if (!parsed.success) return null;
    // The person lock after the approval row decide already holds: the one lock order.
    await repo.lockPerson(tx, parsed.data.userId);
    const reset = await repo.resetById(tx, context.orgId, parsed.data.resetId);
    if (
      reset?.status !== 'pending_approval' ||
      reset.approval_request_id !== approval.id ||
      reset.user_id !== parsed.data.userId ||
      reset.kind !== parsed.data.kind
    ) {
      return null;
    }
    // The approvals service keeps the requester out; this keeps the subject out (D-404).
    if (reset.user_id === context.userId) {
      throw new ForbiddenException('Nobody decides a reset of their own sign-in.');
    }
    return reset;
  }

  /**
   * Approved: a second factor goes now; a password link waits to be collected. The rules
   * are asked again first, with the admin who asked as the actor: if the person has left,
   * joined another brand, or lost the factor meanwhile, the approval cannot take effect
   * and the checker rejects it instead.
   */
  private readonly executeReset: ApprovalExecutor = async (tx, { context, approval, request }) => {
    const reset = await this.waitingReset(tx, context, approval);
    if (reset === null) {
      throw new ConflictException(
        'That approval names no sign-in reset waiting for it; reject it instead.',
      );
    }
    const target = await this.target(tx, context.orgId, reset.user_id);
    const asker = await repo.membershipsOfUser(tx, context.orgId, reset.requested_by);
    if (!asker.some((row) => row.is_active && row.role === 'org_admin')) {
      throw new ConflictException(
        'The admin who asked for this reset no longer manages staff here. Reject it instead.',
      );
    }
    const plan = planCredentialReset({
      actor: { userId: reset.requested_by, isSuperAdmin: false },
      target: resetTarget(target),
      kind: reset.kind === 'two_factor' ? 'two_factor' : 'password',
    });
    if (plan.decision === 'refuse') {
      throw new ConflictException(`${plan.reason} Reject this reset instead.`);
    }

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

  /**
   * Rejected: the reset ends with nothing changed. An approval that names no waiting reset
   * is rejected without complaint, so nothing can leave one stuck in every admin's queue.
   */
  private readonly rejectReset: RejectionHandler = async (tx, { context, approval, request }) => {
    const reset = await this.waitingReset(tx, context, approval);
    if (reset === null) return;
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
