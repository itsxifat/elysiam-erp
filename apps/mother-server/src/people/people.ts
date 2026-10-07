import { randomBytes, randomUUID } from 'node:crypto';

import type {
  InviteOwnerInput,
  LinkWire,
  PersonWire,
  TwoFactorResetWire,
} from '@elysium/mother-shared';
import type { TransactionSql } from 'postgres';

import { recordAudit, type Actor } from '../audit/audit.js';
import { INVITE_LINK_SECONDS } from '../auth/auth.js';
import { inMother, motherSql } from '../db/client.js';
import { MotherError } from '../http/errors.js';

/**
 * The owners (D-487 to D-489): invited by an owner, removed by another, and their second
 * factor cleared only when a third owner agrees.
 *
 * Every change takes the person's lock first and decides on what it reads inside the same
 * transaction, so two owners acting at once cannot both remove "the second-to-last owner".
 */

async function lockPerson(tx: TransactionSql, userId: string): Promise<void> {
  await tx`select pg_advisory_xact_lock(hashtextextended(${`mother.person:${userId}`}, 0))`;
}

/**
 * The acting owner, read again inside the change's transaction: one removed a moment ago
 * must not finish a removal or a reset decision already on its way.
 */
async function assertActorActive(tx: TransactionSql, actor: Actor): Promise<void> {
  const [row] = await tx<{ is_active: boolean }[]>`
    select is_active from auth.users where id = ${actor.userId}
  `;
  if (row?.is_active !== true) {
    throw new MotherError('UNAUTHENTICATED', 'This account is no longer active.');
  }
}

/** One lock for "how many owners are left", taken by every removal. */
async function lockOwners(tx: TransactionSql): Promise<void> {
  await tx`select pg_advisory_xact_lock(hashtextextended('mother.owners', 0))`;
}

export function inviteLink(publicUrl: string, token: string): string {
  return `${publicUrl.replace(/\/+$/, '')}/accept-invite#token=${token}`;
}

/**
 * A one-time password link: the verification row Better Auth's `/reset-password`
 * redeems. Every earlier link for the person is voided first, so one person holds one
 * working link.
 */
export async function mintPasswordLink(
  tx: TransactionSql,
  userId: string,
  seconds: number,
): Promise<{ token: string; expiresAt: Date }> {
  await tx`
    delete from auth.verifications
    where value = ${userId} and identifier like 'reset-password:%'
  `;
  const token = randomBytes(32).toString('base64url');
  const [row] = await tx<{ expires_at: Date }[]>`
    insert into auth.verifications (id, identifier, value, expires_at)
    values (${randomUUID()}, ${`reset-password:${token}`}, ${userId},
            now() + make_interval(secs => ${seconds}))
    returning expires_at
  `;
  if (row === undefined) throw new Error('the link insert returned nothing');
  return { token, expiresAt: row.expires_at };
}

interface PersonRow {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly is_active: boolean;
  readonly two_factor_enabled: boolean;
  readonly has_password: boolean;
  readonly created_at: Date;
  readonly last_sign_in_at: Date | null;
}

export async function listPeople(): Promise<PersonWire[]> {
  const rows = await motherSql()<PersonRow[]>`
    select u.id, u.name, u.email, u.is_active, u.two_factor_enabled, u.created_at,
           u.last_sign_in_at,
           exists (select 1 from auth.accounts a
                   where a.user_id = u.id and a.provider_id = 'credential'
                     and a.password is not null) as has_password
    from auth.users u
    order by u.is_active desc, u.name, u.email
  `;
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    email: row.email,
    isActive: row.is_active,
    twoFactorEnabled: row.two_factor_enabled,
    hasPassword: row.has_password,
    createdAt: row.created_at.toISOString(),
    lastSignInAt: row.last_sign_in_at?.toISOString() ?? null,
  }));
}

export async function invitePerson(
  publicUrl: string,
  input: InviteOwnerInput,
  actor: Actor | null,
  action = 'person.invited',
): Promise<LinkWire & { readonly userId: string }> {
  return inMother(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtextextended(${`mother.email:${input.email}`}, 0))`;
    const [taken] = await tx<{ id: string }[]>`
      select id from auth.users where lower(email) = ${input.email}
    `;
    if (taken !== undefined) {
      throw new MotherError('EMAIL_TAKEN', 'Someone with that email is already here.');
    }
    const userId = `own_${randomUUID()}`;
    await tx`
      insert into auth.users (id, email, name, email_verified, invited_by)
      values (${userId}, ${input.email}, ${input.name}, true, ${actor?.userId ?? null})
    `;
    const link = await mintPasswordLink(tx, userId, INVITE_LINK_SECONDS);
    await recordAudit(
      {
        actorUserId: actor?.userId ?? null,
        action,
        entityType: 'person',
        entityId: userId,
        detail: { email: input.email, name: input.name, expiresAt: link.expiresAt.toISOString() },
        ipAddress: actor?.ipAddress ?? null,
        requestId: actor?.requestId ?? null,
      },
      tx,
    );
    return {
      userId,
      link: inviteLink(publicUrl, link.token),
      expiresAt: link.expiresAt.toISOString(),
    };
  });
}

/** A new invite link for someone who has not set a password yet. */
export async function reissueInvite(
  publicUrl: string,
  userId: string,
  actor: Actor,
): Promise<LinkWire> {
  return inMother(async (tx) => {
    await lockPerson(tx, userId);
    const [person] = await tx<{ is_active: boolean; has_password: boolean }[]>`
      select u.is_active,
             exists (select 1 from auth.accounts a where a.user_id = u.id
                     and a.provider_id = 'credential' and a.password is not null) as has_password
      from auth.users u where u.id = ${userId}
    `;
    if (person === undefined) throw new MotherError('NOT_FOUND', 'No such person.');
    if (!person.is_active || person.has_password) {
      throw new MotherError(
        'CONFLICT',
        'Only someone who has not yet accepted their invite can be sent a new one.',
      );
    }
    const link = await mintPasswordLink(tx, userId, INVITE_LINK_SECONDS);
    await recordAudit(
      {
        actorUserId: actor.userId,
        action: 'person.invite_reissued',
        entityType: 'person',
        entityId: userId,
        detail: { expiresAt: link.expiresAt.toISOString() },
        ipAddress: actor.ipAddress,
        requestId: actor.requestId,
      },
      tx,
    );
    return { link: inviteLink(publicUrl, link.token), expiresAt: link.expiresAt.toISOString() };
  });
}

/** Switch an owner off (D-489): their sessions and links end; the last owner stays. */
export async function removePerson(userId: string, actor: Actor): Promise<void> {
  if (userId === actor.userId) {
    throw new MotherError('SELF_ACTION_REFUSED', 'Another owner must remove you.');
  }
  await inMother(async (tx) => {
    await lockOwners(tx);
    await lockPerson(tx, userId);
    await assertActorActive(tx, actor);
    const [person] = await tx<{ is_active: boolean; email: string }[]>`
      select is_active, email from auth.users where id = ${userId}
    `;
    if (person === undefined) throw new MotherError('NOT_FOUND', 'No such person.');
    if (!person.is_active) return;
    const [left] = await tx<{ count: number }[]>`
      select count(*)::int as count from auth.users where is_active and id <> ${userId}
        and two_factor_enabled
    `;
    if ((left?.count ?? 0) === 0) {
      throw new MotherError(
        'LAST_OWNER',
        'This is the last owner who can sign in. Invite another first.',
      );
    }
    await tx`update auth.users set is_active = false, updated_at = now() where id = ${userId}`;
    await tx`delete from auth.sessions where user_id = ${userId}`;
    await tx`delete from auth.verifications where value = ${userId}`;
    await recordAudit(
      {
        actorUserId: actor.userId,
        action: 'person.removed',
        entityType: 'person',
        entityId: userId,
        detail: { email: person.email },
        ipAddress: actor.ipAddress,
        requestId: actor.requestId,
      },
      tx,
    );
  });
}

// --- clearing a lost second factor (D-488) ----------------------------------------------

interface ResetRow {
  readonly id: string;
  readonly target_user_id: string;
  readonly target_name: string;
  readonly requested_by: string;
  readonly requested_by_name: string;
  readonly decided_by: string | null;
  readonly decided_by_name: string | null;
  readonly reason: string;
  readonly status: 'pending' | 'approved' | 'rejected';
  readonly created_at: Date;
  readonly decided_at: Date | null;
}

export async function listResets(): Promise<TwoFactorResetWire[]> {
  const rows = await motherSql()<ResetRow[]>`
    select r.id, r.target_user_id, t.name as target_name, r.requested_by,
           q.name as requested_by_name, r.decided_by, d.name as decided_by_name, r.reason,
           r.status, r.created_at, r.decided_at
    from mother.two_factor_resets r
    join auth.users t on t.id = r.target_user_id
    join auth.users q on q.id = r.requested_by
    left join auth.users d on d.id = r.decided_by
    order by (r.status = 'pending') desc, r.created_at desc
    limit 100
  `;
  return rows.map((row) => ({
    id: row.id,
    target: { id: row.target_user_id, name: row.target_name },
    requestedBy: { id: row.requested_by, name: row.requested_by_name },
    decidedBy:
      row.decided_by === null ? null : { id: row.decided_by, name: row.decided_by_name ?? '' },
    reason: row.reason,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    decidedAt: row.decided_at?.toISOString() ?? null,
  }));
}

export async function requestTwoFactorReset(
  targetUserId: string,
  reason: string,
  actor: Actor,
): Promise<{ readonly id: string }> {
  if (targetUserId === actor.userId) {
    throw new MotherError(
      'SELF_ACTION_REFUSED',
      'Ask another owner to request this for you; you can change your own factor while signed in.',
    );
  }
  return inMother(async (tx) => {
    await lockPerson(tx, targetUserId);
    const [target] = await tx<{ is_active: boolean }[]>`
      select is_active from auth.users where id = ${targetUserId}
    `;
    if (target?.is_active !== true) throw new MotherError('NOT_FOUND', 'No such owner.');
    const [pending] = await tx<{ id: string }[]>`
      select id from mother.two_factor_resets
      where target_user_id = ${targetUserId} and status = 'pending'
    `;
    if (pending !== undefined) {
      throw new MotherError('CONFLICT', 'A request for this owner is already waiting.');
    }
    const [row] = await tx<{ id: string }[]>`
      insert into mother.two_factor_resets (target_user_id, requested_by, reason)
      values (${targetUserId}, ${actor.userId}, ${reason})
      returning id
    `;
    if (row === undefined) throw new Error('the reset insert returned nothing');
    await recordAudit(
      {
        actorUserId: actor.userId,
        action: 'person.two_factor_reset.requested',
        entityType: 'person',
        entityId: targetUserId,
        detail: { resetId: row.id, reason },
        ipAddress: actor.ipAddress,
        requestId: actor.requestId,
      },
      tx,
    );
    return { id: row.id };
  });
}

/** Clear a person's second factor: their next sign-in meets the enrolment wall. */
export async function clearSecondFactor(tx: TransactionSql, userId: string): Promise<void> {
  await tx`delete from auth.two_factors where user_id = ${userId}`;
  await tx`update auth.users set two_factor_enabled = false, updated_at = now() where id = ${userId}`;
  await tx`delete from auth.sessions where user_id = ${userId}`;
  await tx`
    delete from auth.verifications
    where value = ${userId} and (identifier like 'trust-device-%' or identifier like '2fa-%')
  `;
}

export async function decideTwoFactorReset(
  resetId: string,
  decision: 'approve' | 'reject',
  actor: Actor,
): Promise<void> {
  await inMother(async (tx) => {
    const [found] = await tx<{ target_user_id: string }[]>`
      select target_user_id from mother.two_factor_resets where id = ${resetId}
    `;
    if (found === undefined) throw new MotherError('NOT_FOUND', 'No such request.');
    await lockPerson(tx, found.target_user_id);
    await assertActorActive(tx, actor);
    const [reset] = await tx<{ target_user_id: string; requested_by: string; status: string }[]>`
      select target_user_id, requested_by, status from mother.two_factor_resets
      where id = ${resetId} for update
    `;
    if (reset?.status !== 'pending') {
      throw new MotherError('RESET_NOT_DECIDABLE', 'This request has been decided already.');
    }
    if (actor.userId === reset.requested_by || actor.userId === reset.target_user_id) {
      throw new MotherError(
        'RESET_NOT_DECIDABLE',
        'A third owner decides this: not the one who asked, not the one it is for.',
      );
    }
    await tx`
      update mother.two_factor_resets
      set status = ${decision === 'approve' ? 'approved' : 'rejected'}, decided_by = ${actor.userId}
      where id = ${resetId}
    `;
    if (decision === 'approve') await clearSecondFactor(tx, reset.target_user_id);
    await recordAudit(
      {
        actorUserId: actor.userId,
        action:
          decision === 'approve'
            ? 'person.two_factor_reset.approved'
            : 'person.two_factor_reset.rejected',
        entityType: 'person',
        entityId: reset.target_user_id,
        detail: { resetId, requestedBy: reset.requested_by },
        ipAddress: actor.ipAddress,
        requestId: actor.requestId,
      },
      tx,
    );
  });
}
