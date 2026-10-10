import type { Tx } from '@elysium/db';
import { sql } from 'drizzle-orm';

/**
 * Super admins making super admins (D-659) and removing them (D-685, D-686): the facts the
 * rules in `packages/domain` count, and the two doors to the flag. Every statement names `iam.*` and nothing else (invariant
 * 12) and takes the caller's `withOrg` transaction, so RLS shows this brand's votes and
 * memberships; users are global (§5 exception 4).
 */

/**
 * One nomination, removal, vote or withdrawal at a time, everywhere: the same lock
 * `iam.promote_super_admin` and `iam.demote_super_admin` take, so "how many super admins
 * are there" stays true from the read here to the promotion or the removal.
 */
export async function lockSuperAdmins(tx: Tx): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('iam.super_admins', 0))`);
}

export interface NominationFacts {
  /**
   * Active super admins now, owners left out: the ones whose yes is required. Earliest
   * first, so the first of them is the first super admin (D-666).
   */
  readonly superAdmins: readonly string[];
  /** The first super admin now, or null when the brand has none but owners. */
  readonly first: string | null;
  /** Who may start a nomination or a removal now (D-666): the first and any active owner. */
  readonly starters: ReadonlySet<string>;
  /** Who has a yes recorded for each candidate, in this brand. */
  readonly votes: ReadonlyMap<string, readonly string[]>;
  /** Who has a yes recorded for removing each super admin, in this brand (D-686). */
  readonly removals: ReadonlyMap<string, readonly string[]>;
}

function byTarget(
  rows: Iterable<{ voter_user_id: string; target_user_id: string }>,
): Map<string, string[]> {
  const grouped = new Map<string, string[]>();
  for (const row of rows) {
    const list = grouped.get(row.target_user_id) ?? [];
    list.push(row.voter_user_id);
    grouped.set(row.target_user_id, list);
  }
  return grouped;
}

export async function loadNominations(tx: Tx, orgId: string): Promise<NominationFacts> {
  const admins = await tx.execute<{ id: string }>(sql`
    select id from iam.users where is_super_admin and is_active and not is_owner
    order by created_at, id
  `);
  const starters = await tx.execute<{ id: string }>(sql`
    select id from iam.users
    where is_active and is_super_admin
      and (
        is_owner
        or id = (
          select first.id from iam.users first
          where first.is_super_admin and first.is_active and not first.is_owner
          order by first.created_at, first.id
          limit 1
        )
      )
  `);
  const votes = await tx.execute<{ voter_user_id: string; target_user_id: string }>(sql`
    select voter_user_id, candidate_user_id as target_user_id from iam.super_admin_votes
    where org_id = ${orgId}
    order by created_at
  `);
  const removals = await tx.execute<{ voter_user_id: string; target_user_id: string }>(sql`
    select voter_user_id, target_user_id from iam.super_admin_removal_votes
    where org_id = ${orgId}
    order by created_at
  `);
  const superAdmins = [...admins].map((row) => row.id);
  return {
    superAdmins,
    first: superAdmins[0] ?? null,
    starters: new Set([...starters].map((row) => row.id)),
    votes: byTarget(votes),
    removals: byTarget(removals),
  };
}

/** Record a yes. False when it was already there. */
export async function castSuperAdminVote(
  tx: Tx,
  orgId: string,
  voterId: string,
  candidateId: string,
): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    insert into iam.super_admin_votes (org_id, voter_user_id, candidate_user_id)
    values (${orgId}, ${voterId}, ${candidateId})
    on conflict (org_id, voter_user_id, candidate_user_id) do nothing
    returning id
  `);
  return rows.length > 0;
}

/** Withdraw a nomination: every vote for the candidate here goes. Returns whose they were. */
export async function withdrawNomination(
  tx: Tx,
  orgId: string,
  candidateId: string,
): Promise<readonly string[]> {
  const rows = await tx.execute<{ voter_user_id: string }>(sql`
    delete from iam.super_admin_votes
    where org_id = ${orgId} and candidate_user_id = ${candidateId}
    returning voter_user_id
  `);
  return [...rows].map((row) => row.voter_user_id);
}

/**
 * Set the flag, through the owner-role function that checks the rule again and clears the
 * votes (migration 0128). It refuses with SQLSTATE 42501 or 23514 when the rule does not
 * hold; the caller has checked first, so a refusal here is a race lost or a bug, never a
 * normal answer.
 */
export async function promoteSuperAdmin(tx: Tx, candidateId: string): Promise<void> {
  await tx.execute(sql`select iam.promote_super_admin(${candidateId})`);
}

/** Record a yes for removing a super admin (D-686). False when it was already there. */
export async function castRemovalVote(
  tx: Tx,
  orgId: string,
  voterId: string,
  targetId: string,
): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    insert into iam.super_admin_removal_votes (org_id, voter_user_id, target_user_id)
    values (${orgId}, ${voterId}, ${targetId})
    on conflict (org_id, voter_user_id, target_user_id) do nothing
    returning id
  `);
  return rows.length > 0;
}

/** Withdraw a removal: every vote for removing the person here goes. Returns whose. */
export async function withdrawRemoval(
  tx: Tx,
  orgId: string,
  targetId: string,
): Promise<readonly string[]> {
  const rows = await tx.execute<{ voter_user_id: string }>(sql`
    delete from iam.super_admin_removal_votes
    where org_id = ${orgId} and target_user_id = ${targetId}
    returning voter_user_id
  `);
  return [...rows].map((row) => row.voter_user_id);
}

/**
 * Forget every super admin vote this person cast here, nominations and removals: run as they
 * stop being one (D-687), so an old yes never counts again should they be made one later.
 * Returns how many went.
 */
export async function clearVotesBy(tx: Tx, orgId: string, voterId: string): Promise<number> {
  const nominations = await tx.execute<{ id: string }>(sql`
    delete from iam.super_admin_votes
    where org_id = ${orgId} and voter_user_id = ${voterId}
    returning id
  `);
  const removals = await tx.execute<{ id: string }>(sql`
    delete from iam.super_admin_removal_votes
    where org_id = ${orgId} and voter_user_id = ${voterId}
    returning id
  `);
  return nominations.length + removals.length;
}

/**
 * Clear the flag, through the owner-role function that checks the rule again and clears the
 * removal votes (migration 0139): a step down when the target is the acting user. Refuses
 * with SQLSTATE 42501 or 23514 when the rule does not hold; the caller has checked first.
 */
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
