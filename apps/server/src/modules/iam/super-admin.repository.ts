import type { Tx } from '@elysium/db';
import { sql } from 'drizzle-orm';

/**
 * Super admins made and removed (D-954): the facts the rules in `packages/domain` read, and
 * the two doors to the flag. Every statement names `iam.*` and nothing else (invariant 12)
 * and takes the caller's `withOrg` transaction; users are global (§5 exception 4).
 */

/**
 * One promotion or removal at a time, everywhere: the same lock `iam.promote_super_admin`
 * and `iam.demote_super_admin` take, so "how many super admins are there" stays true from
 * the read here to the change.
 */
export async function lockSuperAdmins(tx: Tx): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('iam.super_admins', 0))`);
}

/** Active super admins now, owners left out: the brand is never left without one of them. */
export async function activeSuperAdmins(tx: Tx): Promise<string[]> {
  const rows = await tx.execute<{ id: string }>(sql`
    select id from iam.users where is_super_admin and is_active and not is_owner
    order by created_at, id
  `);
  return [...rows].map((row) => row.id);
}

/** The flag set, through the one function that may and that checks the rule again. */
export async function promoteSuperAdmin(tx: Tx, candidateId: string): Promise<void> {
  await tx.execute(sql`select iam.promote_super_admin(${candidateId})`);
}

/** The flag cleared, through the one function that may and that checks the rule again. */
export async function demoteSuperAdmin(tx: Tx, targetId: string): Promise<void> {
  await tx.execute(sql`select iam.demote_super_admin(${targetId})`);
}

/** Every super admin, owners included, active or not: the Staff screen lists them (D-658). */
export async function superAdminIds(tx: Tx): Promise<string[]> {
  const rows = await tx.execute<{ id: string }>(sql`
    select id from iam.users where is_super_admin
  `);
  return [...rows].map((row) => row.id);
}
