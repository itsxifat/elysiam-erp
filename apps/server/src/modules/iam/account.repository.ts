import { randomUUID } from 'node:crypto';

import type { Tx } from '@elysium/db';
import { sql } from 'drizzle-orm';

/**
 * My account's SQL (M40, D-693 to D-695): a person's own row, sessions and second factor.
 *
 * Every statement names the person (`user_id = …`), so nothing here can reach another
 * person's row, whichever transaction it runs in. `iam.users`, `iam.sessions`,
 * `iam.two_factors` and `iam.verifications` are global tables (§5 exception 4) owned by this
 * module; Better Auth writes them through its own adapter too.
 */

export interface SelfRow extends Record<string, unknown> {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly is_super_admin: boolean;
  readonly is_owner: boolean;
  readonly two_factor_enabled: boolean;
  readonly last_sign_in_at: Date | string | null;
  readonly has_password: boolean;
  readonly enabled_at: Date | string | null;
  readonly locked_until: Date | string | null;
}

export async function self(tx: Tx, userId: string): Promise<SelfRow | undefined> {
  const [row] = await tx.execute<SelfRow>(sql`
    select u.id, u.name, u.email, u.is_super_admin, u.is_owner, u.two_factor_enabled,
           u.last_sign_in_at,
           exists (
             select 1 from iam.accounts a
             where a.user_id = u.id and a.provider_id = 'credential' and a.password is not null
           ) as has_password,
           tf.enabled_at, tf.locked_until
    from iam.users u
    left join iam.two_factors tf on tf.user_id = u.id and tf.verified
    where u.id = ${userId}
  `);
  return row;
}

/** The person's own row, locked: one account change at a time per person. */
export async function lockSelf(tx: Tx, userId: string): Promise<void> {
  await tx.execute(sql`select id from iam.users where id = ${userId} for update`);
}

export async function setName(tx: Tx, userId: string, name: string): Promise<void> {
  await tx.execute(sql`
    update iam.users set name = ${name}, updated_at = now() where id = ${userId}
  `);
}

export interface SessionRow extends Record<string, unknown> {
  readonly id: string;
  readonly user_agent: string | null;
  readonly ip_address: string | null;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
  readonly expires_at: Date | string;
  readonly owner_link: boolean;
}

/** Every live session of the person, newest activity first. */
export async function liveSessions(tx: Tx, userId: string): Promise<SessionRow[]> {
  const rows = await tx.execute<SessionRow>(sql`
    select id, user_agent, ip_address, created_at, updated_at, expires_at, owner_link
    from iam.sessions
    where user_id = ${userId} and expires_at > now()
    order by updated_at desc, created_at desc
  `);
  return [...rows];
}

/** End one of the person's sessions. Never theirs to name: another person's id matches nothing. */
export async function endSession(tx: Tx, userId: string, sessionId: string): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    delete from iam.sessions where user_id = ${userId} and id = ${sessionId} returning id
  `);
  return rows.length > 0;
}

/** End every session of the person but this one. */
export async function endOtherSessions(
  tx: Tx,
  userId: string,
  keepSessionId: string,
): Promise<number> {
  const rows = await tx.execute<{ id: string }>(sql`
    delete from iam.sessions where user_id = ${userId} and id <> ${keepSessionId} returning id
  `);
  return rows.length;
}

export interface FactorRow extends Record<string, unknown> {
  readonly id: string;
  readonly secret: string;
  readonly failed_verification_count: number;
  readonly locked_until: Date | string | null;
}

/** The person's verified second factor, locked for the change being made to it. */
export async function verifiedFactor(tx: Tx, userId: string): Promise<FactorRow | undefined> {
  const [row] = await tx.execute<FactorRow>(sql`
    select id, secret, failed_verification_count, locked_until
    from iam.two_factors
    where user_id = ${userId} and verified
    for update
  `);
  return row;
}

/**
 * Better Auth's lockout, counted here too (D-694): ten wrong codes in a row lock two-step
 * sign-in for fifteen minutes, sign-in included. A wrong code on My account counts toward the
 * same budget as a wrong code at sign-in, so the account page is no side door for guessing.
 */
export const CODE_LOCKOUT = { maxFailures: 10, minutes: 15 } as const;

export async function recordCodeFailure(tx: Tx, factorId: string): Promise<void> {
  await tx.execute(sql`
    update iam.two_factors
    set failed_verification_count = failed_verification_count + 1,
        locked_until = case
          when failed_verification_count + 1 >= ${CODE_LOCKOUT.maxFailures}
            then now() + make_interval(mins => ${CODE_LOCKOUT.minutes})
          else locked_until
        end
    where id = ${factorId}
  `);
}

export async function clearCodeFailures(tx: Tx, factorId: string): Promise<void> {
  await tx.execute(sql`
    update iam.two_factors set failed_verification_count = 0, locked_until = null
    where id = ${factorId}
  `);
}

/** Swap the authenticator secret; the backup codes stay (the trigger stamps `enabled_at`). */
export async function replaceSecret(tx: Tx, factorId: string, encryptedSecret: string) {
  await tx.execute(sql`
    update iam.two_factors
    set secret = ${encryptedSecret}, verified = true,
        failed_verification_count = 0, locked_until = null
    where id = ${factorId}
  `);
}

/** Forget every remembered device and pending second-factor challenge of the person. */
export async function forgetDevices(tx: Tx, userId: string): Promise<number> {
  const rows = await tx.execute<{ id: string }>(sql`
    delete from iam.verifications
    where value = ${userId} and (identifier like 'trust-device-%' or identifier like '2fa-%')
    returning id
  `);
  return rows.length;
}

/** Where a new phone's secret waits until a code from it arrives (D-694). */
const pendingIdentifier = (userId: string) => `two-factor-replace:${userId}`;

/** Ten minutes: long enough to find the app and scan, short enough to be forgotten. */
export const REPLACEMENT_MINUTES = 10;

export async function savePendingSecret(
  tx: Tx,
  userId: string,
  encryptedSecret: string,
): Promise<void> {
  await tx.execute(
    sql`delete from iam.verifications where identifier = ${pendingIdentifier(userId)}`,
  );
  await tx.execute(sql`
    insert into iam.verifications (id, identifier, value, expires_at)
    values (
      ${randomUUID()}, ${pendingIdentifier(userId)}, ${encryptedSecret},
      now() + make_interval(mins => ${REPLACEMENT_MINUTES})
    )
  `);
}

/** The waiting secret, if it has not expired; locked, so two confirmations cannot both use it. */
export async function pendingSecret(tx: Tx, userId: string): Promise<string | undefined> {
  const [row] = await tx.execute<{ value: string }>(sql`
    select value from iam.verifications
    where identifier = ${pendingIdentifier(userId)} and expires_at > now()
    for update
  `);
  return row?.value;
}

export async function dropPendingSecret(tx: Tx, userId: string): Promise<void> {
  await tx.execute(
    sql`delete from iam.verifications where identifier = ${pendingIdentifier(userId)}`,
  );
}

/** Remove the person's second factor, as a reset does (`users.repository.removeSecondFactor`). */
export async function removeFactor(tx: Tx, userId: string): Promise<void> {
  await tx.execute(sql`delete from iam.two_factors where user_id = ${userId}`);
  await tx.execute(sql`
    update iam.users set two_factor_enabled = false, updated_at = now() where id = ${userId}
  `);
}
