import type { Tx } from '@elysium/db';
import {
  NOMINATION_REFUSAL_REASONS,
  REMOVAL_REFUSAL_REASONS,
  nominationRefusal,
  nominationTally,
  removalRefusal,
  removalTally,
  startRefusal,
  stepDownRefusal,
  type NominationRefusalCode,
  type RemovalRefusalCode,
} from '@elysium/domain/iam';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import type { AuditService } from '../../platform/audit/audit.service.js';
import {
  castRemovalVote,
  castSuperAdminVote,
  demoteSuperAdmin,
  loadNominations,
  lockSuperAdmins,
  promoteSuperAdmin,
  withdrawRemoval,
} from './super-admin.repository.js';
import { usersHttpError } from './users.errors.js';
import { endSessions, membershipsOfUser, people } from './users.repository.js';

/**
 * A super admin's yes for making an admin a super admin (D-659), shared by the Staff
 * screen's "Make super admin" and an invite sent as a super admin (`POST /v1/users`).
 *
 * In the caller's `withOrg` transaction, under the one super admin lock: the rule
 * (`nominationRefusal`, `nominationTally` in `packages/domain`) is asked, the yes recorded,
 * and — while the brand has at most one super admin, or once every one of them has said yes —
 * the candidate promoted through `iam.promote_super_admin`, which checks the rule again in
 * the database. Each vote and the promotion are audited in the same transaction.
 */

export interface NominationActor {
  readonly orgId: string;
  readonly userId: string;
  readonly isSuperAdmin: boolean;
  readonly requestId: string | null;
}

export interface NominationOutcome {
  readonly userId: string;
  /** Promoted now, or waiting for the other super admins' votes. */
  readonly outcome: 'promoted' | 'pending';
  readonly votes: number;
  readonly needed: number;
}

const REFUSAL_CODE: Readonly<
  Record<
    NominationRefusalCode,
    'USER_PROTECTED' | 'USER_SELF_MANAGEMENT' | 'SUPER_ADMIN_NOT_CANDIDATE'
  >
> = {
  not_super_admin: 'USER_PROTECTED',
  not_first_super_admin: 'USER_PROTECTED',
  self: 'USER_SELF_MANAGEMENT',
  already_super_admin: 'SUPER_ADMIN_NOT_CANDIDATE',
  not_admin_here: 'SUPER_ADMIN_NOT_CANDIDATE',
};

/** Refuse a caller who is not a super admin, before anything is read or written. */
export function requireSuperAdmin(actor: { readonly isSuperAdmin: boolean }): void {
  if (!actor.isSuperAdmin) {
    throw usersHttpError(REFUSAL_CODE.not_super_admin, NOMINATION_REFUSAL_REASONS.not_super_admin);
  }
}

export async function voteSuperAdmin(
  tx: Tx,
  audit: AuditService,
  actor: NominationActor,
  candidateId: string,
  request: AuditableRequest | undefined,
): Promise<NominationOutcome> {
  requireSuperAdmin(actor);
  await lockSuperAdmins(tx);

  const [person] = await people(tx, [candidateId]);
  const held = await membershipsOfUser(tx, actor.orgId, candidateId);
  if (person === undefined || (held.length === 0 && !person.is_super_admin)) {
    throw usersHttpError('USER_NOT_FOUND', 'No such person in this organization.');
  }
  const refusal = nominationRefusal(actor, {
    userId: candidateId,
    isActive: person.is_active,
    isSuperAdmin: person.is_super_admin,
    isOwner: person.is_owner,
    activeAdminHere: held.some((row) => row.is_active && row.role === 'org_admin'),
  });
  if (refusal !== null) {
    throw usersHttpError(REFUSAL_CODE[refusal], NOMINATION_REFUSAL_REASONS[refusal]);
  }

  const facts = await loadNominations(tx, actor.orgId);
  const before = facts.votes.get(candidateId) ?? [];
  if (before.length === 0) {
    const notFirst = startRefusal(actor.userId, facts.starters);
    if (notFirst !== null) {
      throw usersHttpError(REFUSAL_CODE[notFirst], NOMINATION_REFUSAL_REASONS[notFirst]);
    }
  }
  const cast = await castSuperAdminVote(tx, actor.orgId, actor.userId, candidateId);
  const voters = cast ? [...before, actor.userId] : before;
  const tally = nominationTally(facts.superAdmins, voters);
  const audited = request === undefined ? {} : { request };

  if (cast) {
    await audit.record(tx, {
      orgId: actor.orgId,
      actorUserId: actor.userId,
      operation: 'create',
      action: before.length === 0 ? 'iam.super_admin_nominated' : 'iam.super_admin_voted',
      entityType: 'User',
      entityId: candidateId,
      before: null,
      after: {
        voter: actor.userId,
        votes: tally.votes,
        needed: tally.needed,
        immediate: tally.immediate,
      },
      requestId: actor.requestId,
      ...audited,
    });
  }

  if (!tally.complete) {
    return { userId: candidateId, outcome: 'pending', votes: tally.votes, needed: tally.needed };
  }

  await promoteSuperAdmin(tx, candidateId);
  await audit.record(tx, {
    orgId: actor.orgId,
    actorUserId: actor.userId,
    operation: 'update',
    action: 'iam.super_admin_promoted',
    entityType: 'User',
    entityId: candidateId,
    before: { isSuperAdmin: false },
    after: {
      isSuperAdmin: true,
      // Who said yes: the last voter alone while the brand had one super admin or none.
      voters: [...new Set(voters)],
      superAdminsBefore: facts.superAdmins.length,
    },
    requestId: actor.requestId,
    ...audited,
  });
  return { userId: candidateId, outcome: 'promoted', votes: tally.votes, needed: tally.needed };
}

// --- removing a super admin (D-685 to D-689) -----------------------------------------------

export interface RemovalOutcome {
  readonly userId: string;
  /** Removed now, or waiting for the other super admins' votes. */
  readonly outcome: 'removed' | 'pending';
  readonly votes: number;
  readonly needed: number;
  /** The removed person's sessions ended, so the change applies at once. */
  readonly sessionsEnded: number;
}

const REMOVAL_CODE: Readonly<
  Record<
    RemovalRefusalCode,
    'USER_PROTECTED' | 'USER_SELF_MANAGEMENT' | 'SUPER_ADMIN_NOT_REMOVABLE' | 'SUPER_ADMIN_LAST'
  >
> = {
  not_super_admin: 'USER_PROTECTED',
  not_first_super_admin: 'USER_PROTECTED',
  self: 'USER_SELF_MANAGEMENT',
  not_removable: 'SUPER_ADMIN_NOT_REMOVABLE',
  first_super_admin: 'SUPER_ADMIN_NOT_REMOVABLE',
  last_super_admin: 'SUPER_ADMIN_LAST',
};

function refuseRemoval(code: RemovalRefusalCode): never {
  throw usersHttpError(REMOVAL_CODE[code], REMOVAL_REFUSAL_REASONS[code]);
}

/** Refuse a caller who is not a super admin from removing anyone, before anything is read. */
export function requireSuperAdminToRemove(actor: { readonly isSuperAdmin: boolean }): void {
  if (!actor.isSuperAdmin) refuseRemoval('not_super_admin');
}

/**
 * A super admin's yes for removing another super admin (D-686). The first yes starts it, and
 * only the first super admin or an owner may (D-666); it removes once every other active super
 * admin but the target has said yes — at once while that is at most one of them. The flag is
 * cleared through `iam.demote_super_admin`, which checks the rule again in the database; the
 * person's sessions end in the same transaction (D-687). Each vote and the removal audited.
 */
export async function voteRemoval(
  tx: Tx,
  audit: AuditService,
  actor: NominationActor,
  targetId: string,
  request: AuditableRequest | undefined,
): Promise<RemovalOutcome> {
  requireSuperAdminToRemove(actor);
  await lockSuperAdmins(tx);

  const [person] = await people(tx, [targetId]);
  const held = await membershipsOfUser(tx, actor.orgId, targetId);
  if (person === undefined || (held.length === 0 && !person.is_super_admin)) {
    throw usersHttpError('USER_NOT_FOUND', 'No such person in this organization.');
  }
  const facts = await loadNominations(tx, actor.orgId);
  const refusal = removalRefusal(
    actor,
    {
      userId: targetId,
      isActive: person.is_active,
      isSuperAdmin: person.is_super_admin,
      isOwner: person.is_owner,
    },
    facts,
  );
  if (refusal !== null) refuseRemoval(refusal);

  const before = facts.removals.get(targetId) ?? [];
  if (before.length === 0 && startRefusal(actor.userId, facts.starters) !== null) {
    refuseRemoval('not_first_super_admin');
  }
  const cast = await castRemovalVote(tx, actor.orgId, actor.userId, targetId);
  const voters = cast ? [...before, actor.userId] : before;
  const tally = removalTally(facts.superAdmins, targetId, voters);
  const audited = request === undefined ? {} : { request };

  if (cast) {
    await audit.record(tx, {
      orgId: actor.orgId,
      actorUserId: actor.userId,
      operation: 'create',
      action:
        before.length === 0 ? 'iam.super_admin_removal_started' : 'iam.super_admin_removal_voted',
      entityType: 'User',
      entityId: targetId,
      before: null,
      after: {
        voter: actor.userId,
        votes: tally.votes,
        needed: tally.needed,
        immediate: tally.immediate,
      },
      requestId: actor.requestId,
      ...audited,
    });
  }

  if (!tally.complete) {
    return {
      userId: targetId,
      outcome: 'pending',
      votes: tally.votes,
      needed: tally.needed,
      sessionsEnded: 0,
    };
  }

  await demoteSuperAdmin(tx, targetId);
  const sessionsEnded = await endSessions(tx, targetId, 'all');
  await audit.record(tx, {
    orgId: actor.orgId,
    actorUserId: actor.userId,
    operation: 'update',
    action: 'iam.super_admin_removal_completed',
    entityType: 'User',
    entityId: targetId,
    before: { isSuperAdmin: true },
    after: {
      isSuperAdmin: false,
      // Who said yes: the starter alone while at most one other super admin remained.
      voters: [...new Set(voters)],
      superAdminsBefore: facts.superAdmins.length,
      sessionsEnded,
    },
    requestId: actor.requestId,
    ...audited,
  });
  return {
    userId: targetId,
    outcome: 'removed',
    votes: tally.votes,
    needed: tally.needed,
    sessionsEnded,
  };
}

/**
 * A super admin gives up their own super admin power, at once (D-685). Refused for the last
 * active super admin (owners aside) and for an owner. Their sessions end, this one included,
 * so they sign in again with what they hold now; an admin role in the brand stays.
 */
export async function stepDown(
  tx: Tx,
  audit: AuditService,
  actor: NominationActor,
  request: AuditableRequest | undefined,
): Promise<{ userId: string; sessionsEnded: number; firstNow: string | null }> {
  requireSuperAdminToRemove(actor);
  await lockSuperAdmins(tx);
  const [person] = await people(tx, [actor.userId]);
  const facts = await loadNominations(tx, actor.orgId);
  const refusal = stepDownRefusal(
    { userId: actor.userId, isSuperAdmin: actor.isSuperAdmin, isOwner: person?.is_owner === true },
    facts,
  );
  if (refusal !== null) refuseRemoval(refusal);

  await demoteSuperAdmin(tx, actor.userId);
  const sessionsEnded = await endSessions(tx, actor.userId, 'all');
  const firstNow = facts.superAdmins.find((id) => id !== actor.userId) ?? null;
  // The next earliest is the first now, whom the others never remove: a removal of them
  // still open here could neither finish nor be voted on, so it goes, in the record below.
  const clearedRemoval =
    facts.first === actor.userId && firstNow !== null
      ? await withdrawRemoval(tx, actor.orgId, firstNow)
      : [];
  await audit.record(tx, {
    orgId: actor.orgId,
    actorUserId: actor.userId,
    operation: 'update',
    action: 'iam.super_admin_removal_stepped_down',
    entityType: 'User',
    entityId: actor.userId,
    before: { isSuperAdmin: true, wasFirst: facts.first === actor.userId },
    after: { isSuperAdmin: false, firstNow, sessionsEnded, clearedRemovalVoters: clearedRemoval },
    requestId: actor.requestId,
    ...(request === undefined ? {} : { request }),
  });
  return { userId: actor.userId, sessionsEnded, firstNow };
}
