import type { Tx } from '@elysium/db';
import {
  NOMINATION_REFUSAL_REASONS,
  REMOVAL_REFUSAL_REASONS,
  nominationRefusal,
  removalRefusal,
  stepDownRefusal,
  type NominationRefusalCode,
  type RemovalRefusalCode,
} from '@elysium/domain/iam';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import type { AuditService } from '../../platform/audit/audit.service.js';
import {
  activeSuperAdmins,
  demoteSuperAdmin,
  lockSuperAdmins,
  promoteSuperAdmin,
} from './super-admin.repository.js';
import { usersHttpError } from './users.errors.js';
import { endSessions, membershipsOfUser, people } from './users.repository.js';

/**
 * Making and removing super admins (D-954): a super admin's permission is the whole rule, and
 * it takes effect at once. Shared by the Staff screen's "Make super admin" and "Remove super
 * admin", an invite sent as a super admin (`POST /v1/users`) and "Step down".
 *
 * In the caller's `withOrg` transaction, under the one super admin lock: the rule in
 * `packages/domain` is asked, then the flag changed through `iam.promote_super_admin` or
 * `iam.demote_super_admin`, which check it again in the database. Audited in the same
 * transaction.
 */

export interface NominationActor {
  readonly orgId: string;
  readonly userId: string;
  readonly isSuperAdmin: boolean;
  readonly requestId: string | null;
}

export interface NominationOutcome {
  readonly userId: string;
  readonly outcome: 'promoted';
}

const REFUSAL_CODE: Readonly<
  Record<
    NominationRefusalCode,
    'USER_PROTECTED' | 'USER_SELF_MANAGEMENT' | 'SUPER_ADMIN_NOT_CANDIDATE'
  >
> = {
  not_super_admin: 'USER_PROTECTED',
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

/** Make an active admin of this brand a super admin, at once. */
export async function makeSuperAdmin(
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

  await promoteSuperAdmin(tx, candidateId);
  await audit.record(tx, {
    orgId: actor.orgId,
    actorUserId: actor.userId,
    operation: 'update',
    action: 'iam.super_admin_promoted',
    entityType: 'User',
    entityId: candidateId,
    before: { isSuperAdmin: false },
    after: { isSuperAdmin: true },
    requestId: actor.requestId,
    ...(request === undefined ? {} : { request }),
  });
  return { userId: candidateId, outcome: 'promoted' };
}

// --- removing a super admin ------------------------------------------------------------------

export interface RemovalOutcome {
  readonly userId: string;
  readonly outcome: 'removed';
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
  self: 'USER_SELF_MANAGEMENT',
  not_removable: 'SUPER_ADMIN_NOT_REMOVABLE',
  last_super_admin: 'SUPER_ADMIN_LAST',
};

function refuseRemoval(code: RemovalRefusalCode): never {
  throw usersHttpError(REMOVAL_CODE[code], REMOVAL_REFUSAL_REASONS[code]);
}

/** Refuse a caller who is not a super admin from removing anyone, before anything is read. */
export function requireSuperAdminToRemove(actor: { readonly isSuperAdmin: boolean }): void {
  if (!actor.isSuperAdmin) refuseRemoval('not_super_admin');
}

/** Remove another super admin's super admin power, at once; their sessions end with it. */
export async function removeSuperAdmin(
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
  const superAdmins = await activeSuperAdmins(tx);
  const refusal = removalRefusal(
    actor,
    {
      userId: targetId,
      isActive: person.is_active,
      isSuperAdmin: person.is_super_admin,
      isOwner: person.is_owner,
    },
    { superAdmins },
  );
  if (refusal !== null) refuseRemoval(refusal);

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
    after: { isSuperAdmin: false, sessionsEnded },
    requestId: actor.requestId,
    ...(request === undefined ? {} : { request }),
  });
  return { userId: targetId, outcome: 'removed', sessionsEnded };
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
): Promise<{ userId: string; sessionsEnded: number }> {
  requireSuperAdminToRemove(actor);
  await lockSuperAdmins(tx);
  const [person] = await people(tx, [actor.userId]);
  const superAdmins = await activeSuperAdmins(tx);
  const refusal = stepDownRefusal(
    { userId: actor.userId, isSuperAdmin: actor.isSuperAdmin, isOwner: person?.is_owner === true },
    { superAdmins },
  );
  if (refusal !== null) refuseRemoval(refusal);

  await demoteSuperAdmin(tx, actor.userId);
  const sessionsEnded = await endSessions(tx, actor.userId, 'all');
  await audit.record(tx, {
    orgId: actor.orgId,
    actorUserId: actor.userId,
    operation: 'update',
    action: 'iam.super_admin_removal_stepped_down',
    entityType: 'User',
    entityId: actor.userId,
    before: { isSuperAdmin: true },
    after: { isSuperAdmin: false, sessionsEnded },
    requestId: actor.requestId,
    ...(request === undefined ? {} : { request }),
  });
  return { userId: actor.userId, sessionsEnded };
}
