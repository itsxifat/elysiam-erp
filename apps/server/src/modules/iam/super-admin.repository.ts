import type { Tx } from '@elysium/db';
import { sql } from 'drizzle-orm';

/**
 * Super admins making super admins (D-659): the facts the rule in `packages/domain` counts,
 * and the one door to the flag. Every statement names `iam.*` and nothing else (invariant
 * 12) and takes the caller's `withOrg` transaction, so RLS shows this brand's votes and
 * memberships; users are global (§5 exception 4).
 */

/**
 * One nomination, vote or withdrawal at a time, everywhere: the same lock
 * `iam.promote_super_admin` takes, so "how many super admins are there" stays true from the
 * read here to the promotion.
 */
export async function lockSuperAdmins(tx: Tx): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('iam.super_admins', 0))`);
}

export interface NominationFacts {
  /** Active super admins now, owners left out: the ones whose yes is required. */
  readonly superAdmins: readonly string[];
  /** Who has a yes recorded for each candidate, in this brand. */
  readonly votes: ReadonlyMap<string, readonly string[]>;
}

export async function loadNominations(tx: Tx, orgId: string): Promise<NominationFacts> {
  const admins = await tx.execute<{ id: string }>(sql`
    select id from iam.users where is_super_admin and is_active and not is_owner
  `);
  const votes = await tx.execute<{ voter_user_id: string; candidate_user_id: string }>(sql`
    select voter_user_id, candidate_user_id from iam.super_admin_votes
    where org_id = ${orgId}
    order by created_at
  `);
  const byCandidate = new Map<string, string[]>();
  for (const vote of votes) {
    const list = byCandidate.get(vote.candidate_user_id) ?? [];
    list.push(vote.voter_user_id);
    byCandidate.set(vote.candidate_user_id, list);
  }
  return { superAdmins: [...admins].map((row) => row.id), votes: byCandidate };
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

/** Every super admin, owners included, active or not: the Staff screen lists them (D-658). */
export async function superAdminIds(tx: Tx): Promise<string[]> {
  const rows = await tx.execute<{ id: string }>(sql`
    select id from iam.users where is_super_admin
  `);
  return [...rows].map((row) => row.id);
}
