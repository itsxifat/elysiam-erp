import { randomUUID } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { resetNeedsSecondPerson, type MembershipRole, type RoleGrant } from '@elysium/contracts';
import {
  INVITE_LINK_SECONDS,
  PASSWORD_LINK_SECONDS,
  requiresTwoFactor,
  withOrg,
  type Tx,
} from '@elysium/db';
import {
  isCollectable,
  isRemovableSuperAdmin,
  isSuperAdminCandidate,
  nominationTally,
  removalTally,
  planCredentialReset,
  planRoleChange,
  resetAllowedByLimits,
  type ResetKind,
  type TrustRefusalCode,
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
  castVote,
  lockTrust,
  loadTrust,
  withdrawVote,
  type TrustFacts,
} from './trust.repository.js';
import {
  requireSuperAdmin,
  requireSuperAdminToRemove,
  stepDown,
  voteRemoval,
  voteSuperAdmin,
  type NominationOutcome,
  type RemovalOutcome,
} from './super-admin.js';
import {
  loadNominations,
  lockSuperAdmins,
  superAdminIds,
  withdrawNomination,
  withdrawRemoval,
  type NominationFacts,
} from './super-admin.repository.js';
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
 * the link could set the password, so they join the person's grant lineage (D-406,
 * D-410), and a reset of anyone whose account can raise or decide an approval, ever,
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
  /** A password or second-factor reset of this person needs a second admin (D-404). */
  readonly resetNeedsApproval: boolean;
  /** For an active admin who is not a super admin: the admins' trust in them (D-654). */
  readonly trust: TrustView | null;
  /**
   * For an active admin who could be made a super admin (D-659): shown to a super admin, and
   * to everyone while a nomination is pending. Null otherwise.
   */
  readonly superAdminNomination: NominationView | null;
  /**
   * For an active super admin who is not an owner (D-686): shown to a super admin, and to
   * everyone while a removal is pending. Null otherwise.
   */
  readonly superAdminRemoval: RemovalView | null;
}

/** Removing one super admin, or stepping down, as the caller sees it (D-685, D-686). */
export interface RemovalView {
  /** Some super admin has said yes to removing them, and it waits for the rest. */
  readonly pending: boolean;
  /** Yes votes from the super admins whose vote is required. */
  readonly votes: number;
  /** Every other active super admin, owners aside; 0 while that is at most one. */
  readonly needed: number;
  /** At most one other super admin: the next yes removes at once. */
  readonly immediate: boolean;
  /** The caller has said yes already. */
  readonly votedByMe: boolean;
  /** This is the first super admin: removed only by stepping down. */
  readonly isFirst: boolean;
  /** The caller may say yes now: a super admin, not the target, the target not the first. */
  readonly canVote: boolean;
  /** The caller may withdraw the removal (any super admin but the target, while pending). */
  readonly canWithdraw: boolean;
  /** The caller may start a removal: the first super admin or an owner (D-666). */
  readonly canStart: boolean;
  /** This is the caller's own row and they may step down: another super admin remains. */
  readonly canStepDown: boolean;
}

/** Making one admin a super admin, as the caller sees it (D-659). */
export interface NominationView {
  /** Some super admin has said yes, and the promotion waits for the rest. */
  readonly pending: boolean;
  /** Yes votes from the super admins whose vote is required. */
  readonly votes: number;
  /** Every active super admin, owners aside; 0 while there is at most one. */
  readonly needed: number;
  /** At most one super admin: the next yes promotes at once. */
  readonly immediate: boolean;
  /** The caller has said yes already. */
  readonly votedByMe: boolean;
  /** The caller may say yes now (a super admin, not the candidate). */
  readonly canVote: boolean;
  /** The caller may withdraw the nomination (any super admin, while one is pending). */
  readonly canWithdraw: boolean;
  /** The caller may start a nomination: the first super admin or an owner (D-666). */
  readonly canStart: boolean;
}

/** The admins' trust in one admin, as the caller sees it (D-654 to D-656). */
export interface TrustView {
  /** Votes from independent admins who may vote now. */
  readonly votes: number;
  /** Two thirds of those who may vote, rounded up, never fewer than two. */
  readonly needed: number;
  readonly trusted: boolean;
  /** The caller has a vote recorded for this person, counted or not: theirs to withdraw. */
  readonly votedByMe: boolean;
  /** The caller's vote would count. */
  readonly canVote: boolean;
  /** Why it would not, when it would not: the words, and a code the console translates. */
  readonly reason: string | null;
  readonly reasonCode: TrustRefusalCode | null;
}

/** Whether a person can be vouched for: an active admin here, not a super admin. */
function isTrustCandidate(person: repo.PersonRow, held: readonly repo.MembershipRow[]): boolean {
  return (
    person.is_active &&
    !person.is_super_admin &&
    !person.is_owner &&
    held.some((row) => row.is_active && row.role === 'org_admin')
  );
}

function nominationView(
  context: ActiveContext,
  facts: NominationFacts,
  candidateId: string,
): NominationView | null {
  const voters = facts.votes.get(candidateId) ?? [];
  const pending = voters.length > 0;
  if (!context.isSuperAdmin && !pending) return null;
  const tally = nominationTally(facts.superAdmins, voters);
  const votedByMe = voters.includes(context.userId);
  const mayAct = context.isSuperAdmin && candidateId !== context.userId;
  const canStart = mayAct && facts.starters.has(context.userId);
  return {
    pending,
    votes: tally.votes,
    needed: tally.needed,
    immediate: tally.immediate,
    votedByMe,
    // A yes already given counts; pressing again only matters once every vote is in.
    canVote: mayAct && (pending || canStart) && (!votedByMe || tally.complete),
    canWithdraw: mayAct && pending,
    canStart,
  };
}

function removalView(
  context: ActiveContext,
  facts: NominationFacts,
  targetId: string,
): RemovalView | null {
  const voters = facts.removals.get(targetId) ?? [];
  const pending = voters.length > 0;
  if (!context.isSuperAdmin && !pending) return null;
  const tally = removalTally(facts.superAdmins, targetId, voters);
  const self = targetId === context.userId;
  const isFirst = facts.first === targetId;
  const othersRemain = facts.superAdmins.some((id) => id !== targetId);
  const mayAct = context.isSuperAdmin && !self && !isFirst && othersRemain;
  const canStart = mayAct && facts.starters.has(context.userId);
  const votedByMe = voters.includes(context.userId);
  return {
    pending,
    votes: tally.votes,
    needed: tally.needed,
    immediate: tally.immediate,
    votedByMe,
    isFirst,
    canVote: mayAct && (pending || canStart) && (!votedByMe || tally.complete),
    canWithdraw: mayAct && pending,
    canStart,
    canStepDown: self && context.isSuperAdmin && othersRemain,
  };
}

/** Owners first, then super admins, then everyone else; by name within each. */
function rank(row: StaffRow): number {
  if (row.isOwner) return 0;
  return row.isSuperAdmin ? 1 : 2;
}

function trustView(
  context: ActiveContext,
  facts: TrustFacts,
  candidateId: string,
  voters: readonly string[] = facts.votes.get(candidateId) ?? [],
): TrustView {
  const tally = facts.graph.tally(candidateId, voters);
  const standing = facts.graph.standing(context.userId, candidateId);
  return {
    votes: tally.votes,
    needed: tally.needed,
    trusted: tally.trusted,
    votedByMe: voters.includes(context.userId),
    canVote: standing.ok,
    reason: standing.ok ? null : standing.reason,
    reasonCode: standing.ok ? null : standing.code,
  };
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

/**
 * The rules' view of a person. "Needs a second admin" is decided over every role they
 * have **ever** held here, not only the ones they hold now: otherwise an admin demotes an
 * accountant, resets them alone and promotes them back (the ledger audit's C1).
 */
function resetTarget(target: Target): ResetTarget {
  return {
    userId: target.userId,
    isSuperAdmin: target.isSuperAdmin,
    activeHere: target.accountActive && target.activeRoles.length > 0,
    inOtherBrand: target.inOtherBrand,
    hasPasswordAccount: target.hasPassword,
    twoFactorEnabled: target.twoFactorEnabled,
    needsSecondPerson: resetNeedsSecondPerson(
      target.held.map((row) => row.role),
      target.isSuperAdmin,
    ),
  };
}

/**
 * The database refused a vote or a promotion the service had just checked (migration 0128):
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
    /** The caller may invite or start a super admin (D-666). */
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
      const trust = await loadTrust(tx, context.orgId);
      const nominations = await loadNominations(tx, context.orgId);

      const items: StaffRow[] = [];
      for (const userId of userIds) {
        const person = byId.get(userId);
        if (person === undefined) continue;
        // An owner holds no role here (D-473), and is listed only as a super admin.
        if (person.is_owner && !person.is_super_admin) continue;
        const held = person.is_owner ? [] : memberships.filter((row) => row.user_id === userId);
        items.push(this.view(context, person, held, elsewhere.has(userId), trust, nominations));
      }
      items.sort(
        (a, b) =>
          rank(a) - rank(b) || a.name.localeCompare(b.name) || a.email.localeCompare(b.email),
      );

      return {
        items,
        canStartSuperAdmin: context.isSuperAdmin && nominations.starters.has(context.userId),
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
      const trust = await loadTrust(tx, context.orgId);
      const nominations = await loadNominations(tx, context.orgId);
      return this.view(context, person, held, elsewhere.has(userId), trust, nominations);
    });
  }

  private view(
    context: ActiveContext,
    person: repo.PersonRow,
    held: readonly repo.MembershipRow[],
    inOtherBrand: boolean,
    trust: TrustFacts,
    nominations: NominationFacts,
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
    return {
      userId: person.id,
      name: masked ? '' : person.name,
      email: masked ? '' : person.email,
      status,
      roles: active.map((row) => ({ role: row.role, branchIds: [...row.branch_ids] })),
      formerRoles: held.filter((row) => !row.is_active).map((row) => row.role),
      // An owner's link is minted behind the mother's second factor (D-473).
      twoFactorEnabled: person.two_factor_enabled || person.is_owner,
      twoFactorRequired: requiresTwoFactor(
        active.map((row) => row.role),
        person.is_super_admin,
      ),
      lastSignInAt: iso(person.last_sign_in_at),
      hasPassword: person.has_password,
      linkExpiresAt: iso(person.link_expires_at),
      isSuperAdmin: person.is_super_admin,
      isOwner: person.is_owner,
      hasRoleHere: held.length > 0,
      inOtherBrand,
      isSelf: person.id === context.userId,
      resetNeedsApproval:
        !context.isSuperAdmin &&
        resetNeedsSecondPerson(
          held.map((row) => row.role),
          person.is_super_admin,
        ),
      trust: isTrustCandidate(person, held) ? trustView(context, trust, person.id) : null,
      superAdminNomination: isSuperAdminCandidate(candidate)
        ? nominationView(context, nominations, person.id)
        : null,
      superAdminRemoval: isRemovableSuperAdmin(candidate)
        ? removalView(context, nominations, person.id)
        : null,
    };
  }

  // --- super admins making super admins (D-659) -------------------------------------------

  /**
   * A super admin's yes for making an active admin here a super admin. While the brand has at
   * most one super admin it promotes at once; with two or more, the last of their votes does.
   */
  async voteSuperAdmin(
    context: ActiveContext,
    request: AuditableRequest,
    userId: string,
  ): Promise<NominationOutcome> {
    requireSuperAdmin(context);
    try {
      return await this.inOrg(context, async (tx) =>
        voteSuperAdmin(tx, this.audit, context, userId, request),
      );
    } catch (error) {
      throw promotionRaceLost(error);
    }
  }

  /** Withdraw a pending nomination: every vote for the person goes. Any super admin may. */
  async withdrawSuperAdminNomination(
    context: ActiveContext,
    request: AuditableRequest,
    userId: string,
  ): Promise<{ userId: string; withdrawnVotes: number }> {
    requireSuperAdmin(context);
    return this.inOrg(context, async (tx) => {
      await lockSuperAdmins(tx);
      const voters = await withdrawNomination(tx, context.orgId, userId);
      if (voters.length === 0) {
        throw usersHttpError(
          'SUPER_ADMIN_NOT_CANDIDATE',
          'There is no nomination for this person to withdraw.',
        );
      }
      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: 'delete',
        action: 'iam.super_admin_nomination_withdrawn',
        entityType: 'User',
        entityId: userId,
        before: { voters },
        after: null,
        requestId: context.requestId,
        request,
      });
      return { userId, withdrawnVotes: voters.length };
    });
  }

  // --- removing a super admin (D-685 to D-689) --------------------------------------------

  /**
   * A super admin's yes for removing another: started by the first super admin or an owner,
   * complete once every other super admin but the target has said yes (at once while that
   * is at most one). The removed person's sessions end; an admin role here stays.
   */
  async removeSuperAdmin(
    context: ActiveContext,
    request: AuditableRequest,
    userId: string,
  ): Promise<RemovalOutcome> {
    requireSuperAdminToRemove(context);
    try {
      return await this.inOrg(context, async (tx) =>
        voteRemoval(tx, this.audit, context, userId, request),
      );
    } catch (error) {
      throw promotionRaceLost(error);
    }
  }

  /** Withdraw a pending removal: every vote for it goes. Any super admin but the target. */
  async withdrawSuperAdminRemoval(
    context: ActiveContext,
    request: AuditableRequest,
    userId: string,
  ): Promise<{ userId: string; withdrawnVotes: number }> {
    requireSuperAdminToRemove(context);
    if (userId === context.userId) {
      throw usersHttpError(
        'USER_SELF_MANAGEMENT',
        'Nobody withdraws the removal of themselves. Another super admin may.',
      );
    }
    return this.inOrg(context, async (tx) => {
      await lockSuperAdmins(tx);
      const voters = await withdrawRemoval(tx, context.orgId, userId);
      if (voters.length === 0) {
        throw usersHttpError(
          'SUPER_ADMIN_NOT_REMOVABLE',
          'There is no removal of this person to withdraw.',
        );
      }
      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: 'delete',
        action: 'iam.super_admin_removal_withdrawn',
        entityType: 'User',
        entityId: userId,
        before: { voters },
        after: null,
        requestId: context.requestId,
        request,
      });
      return { userId, withdrawnVotes: voters.length };
    });
  }

  /** Give up your own super admin power at once; never the last super admin (D-685). */
  async stepDown(
    context: ActiveContext,
    request: AuditableRequest,
  ): Promise<{ userId: string; sessionsEnded: number }> {
    requireSuperAdminToRemove(context);
    try {
      const done = await this.inOrg(context, async (tx) =>
        stepDown(tx, this.audit, context, request),
      );
      return { userId: done.userId, sessionsEnded: done.sessionsEnded };
    } catch (error) {
      throw promotionRaceLost(error);
    }
  }

  // --- trust votes ------------------------------------------------------------------------

  /**
   * Vouch for an admin (D-654 to D-656). Only a vote that would count is recorded: the voter
   * is an active admin or super admin with two-step sign-in, and neither invited the other
   * nor shares an inviter with them, however far up. Under the candidate's trust lock, which
   * an approval decision counting them also takes; audited in the same transaction.
   */
  async vote(
    context: ActiveContext,
    request: AuditableRequest,
    userId: string,
  ): Promise<{ userId: string; trust: TrustView }> {
    return this.inOrg(context, async (tx) => {
      await lockTrust(tx, context.orgId, userId, 'exclusive');
      const held = await repo.membershipsOfUser(tx, context.orgId, userId);
      const [person] = await repo.people(tx, [userId]);
      if (held.length === 0 || person === undefined || person.is_owner) return NOT_FOUND();
      if (!isTrustCandidate(person, held)) {
        throw usersHttpError(
          'TRUST_NOT_CANDIDATE',
          'Only an active admin of this brand is vouched for. A super admin needs no votes.',
        );
      }

      const facts = await loadTrust(tx, context.orgId);
      const standing = facts.graph.standing(context.userId, userId);
      if (!standing.ok) {
        throw usersHttpError(
          standing.code === 'self' ? 'USER_SELF_MANAGEMENT' : 'TRUST_VOTE_REFUSED',
          standing.reason,
        );
      }

      const before = facts.votes.get(userId) ?? [];
      const cast = await castVote(tx, context.orgId, context.userId, userId);
      const view = trustView(context, facts, userId, cast ? [...before, context.userId] : before);
      if (cast) {
        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'create',
          action: 'iam.trust_voted',
          entityType: 'User',
          entityId: userId,
          before: null,
          after: {
            voter: context.userId,
            votes: view.votes,
            needed: view.needed,
            trusted: view.trusted,
          },
          requestId: context.requestId,
          request,
        });
      }
      return { userId, trust: view };
    });
  }

  /** Withdraw the caller's vote; it stops counting at once. Audited in the same transaction. */
  async withdrawVote(
    context: ActiveContext,
    request: AuditableRequest,
    userId: string,
  ): Promise<{ userId: string; trust: TrustView }> {
    return this.inOrg(context, async (tx) => {
      await lockTrust(tx, context.orgId, userId, 'exclusive');
      const removed = await withdrawVote(tx, context.orgId, context.userId, userId);
      if (!removed) {
        throw usersHttpError('CONFLICT', 'There is no vote of yours for this person to withdraw.');
      }
      const facts = await loadTrust(tx, context.orgId);
      const view = trustView(context, facts, userId);
      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: 'delete',
        action: 'iam.trust_withdrawn',
        entityType: 'User',
        entityId: userId,
        before: { voter: context.userId },
        after: { votes: view.votes, needed: view.needed, trusted: view.trusted },
        requestId: context.requestId,
        request,
      });
      return { userId, trust: view };
    });
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
   * granted or reshaped adds the acting admin to the person's lineage (D-077, D-410).
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
        if (!collectable) {
          throw usersHttpError(
            'CREDENTIAL_RESET_PENDING',
            open.status === 'pending_approval'
              ? 'A password reset for this person is already waiting for a second admin.'
              : 'A password reset for this person was approved for the admin who asked for it.',
          );
        }
        return this.collect(tx, context, request, target, open);
      }

      const plan = this.plan(context, target, 'password');
      await this.checkLimits(tx, context, userId);

      if (plan.decision === 'approval') {
        return this.askSecondAdmin(tx, context, request, target, 'password', reason);
      }
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
    return this.inOrg(context, async (tx) => {
      const target = await this.target(tx, context.orgId, userId);
      const open = await repo.openResetFor(tx, context.orgId, userId, 'two_factor');
      if (open !== undefined) {
        throw usersHttpError(
          'CREDENTIAL_RESET_PENDING',
          'A two-step verification reset for this person is already waiting for a second admin.',
        );
      }

      const plan = this.plan(context, target, 'two_factor');
      await this.checkLimits(tx, context, userId);
      if (plan.decision === 'approval') {
        return this.askSecondAdmin(tx, context, request, target, 'two_factor', reason);
      }

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

  /**
   * Raise the `credential_reset` approval and record the reset that waits on it, in the
   * same transaction (the ledger audit's W3): both commit, or neither does, so no
   * approval ever names a reset that is not there.
   */
  private async askSecondAdmin(
    tx: Tx,
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
      tx,
    });
    if (raised.status !== 'pending') {
      throw new ConflictException('A sign-in reset always waits for a second admin.');
    }
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
    return { outcome: 'pending_approval', resetId, approvalRequestId: raised.id };
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
