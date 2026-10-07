import type { Tx } from '@elysium/db';
import {
  NOMINATION_REFUSAL_REASONS,
  nominationRefusal,
  nominationTally,
  startRefusal,
  type NominationRefusalCode,
} from '@elysium/domain/iam';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import type { AuditService } from '../../platform/audit/audit.service.js';
import {
  castSuperAdminVote,
  loadNominations,
  lockSuperAdmins,
  promoteSuperAdmin,
} from './super-admin.repository.js';
import { usersHttpError } from './users.errors.js';
import { membershipsOfUser, people } from './users.repository.js';

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
