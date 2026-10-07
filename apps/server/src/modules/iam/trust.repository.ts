import type { Tx } from '@elysium/db';
import {
  trustGraph,
  type GrantEdge,
  type TrustGraph,
  type TrustPoolMember,
} from '@elysium/domain/iam';
import { sql } from 'drizzle-orm';

/**
 * The admins' trust votes (D-654 to D-656): the facts the rule in `packages/domain` counts.
 * Every statement names `iam.*` and nothing else (invariant 12). Each takes the caller's
 * `withOrg` transaction, so RLS shows this brand's memberships, grants and votes and no
 * other's; users are global (§5 exception 4).
 */

/**
 * Serialise a vote or a withdrawal for one candidate with a decision that counts them: the
 * vote routes take it exclusively, an approval decision shared. Advisory, because the
 * votes table has no UPDATE grant and so cannot be row-locked for share.
 */
export async function lockTrust(
  tx: Tx,
  orgId: string,
  candidateId: string,
  mode: 'exclusive' | 'shared',
): Promise<void> {
  const key = `iam.trust:${orgId}:${candidateId}`;
  await tx.execute(
    mode === 'exclusive'
      ? sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`
      : sql`select pg_advisory_xact_lock_shared(hashtextextended(${key}, 0))`,
  );
}

export interface TrustFacts {
  readonly graph: TrustGraph;
  /** Who has a vote recorded for each candidate, counted or not. */
  readonly votes: ReadonlyMap<string, readonly string[]>;
}

/**
 * Everything the rule needs about this brand, now: who may vouch (active org admins and
 * active super admins, with their two-step sign-in), every grant ever recorded — the same
 * edges the approvals lineage walks — every super admin, and every vote.
 *
 * With `lock`, the active admin memberships are held for share first, so a deactivation or
 * a role change that would move the count waits for the decision reading it, or the
 * decision reads what it left.
 */
export async function loadTrust(
  tx: Tx,
  orgId: string,
  options: { readonly lock?: boolean } = {},
): Promise<TrustFacts> {
  if (options.lock === true) {
    await tx.execute(sql`
      select id from iam.memberships
      where org_id = ${orgId} and role = 'org_admin' and is_active
      for share
    `);
  }

  const pool = await tx.execute<{
    user_id: string;
    is_super_admin: boolean;
    two_factor: boolean;
  }>(sql`
    select u.id as user_id, u.is_super_admin,
           -- An owner's link is minted behind the mother's second factor (D-473).
           (u.two_factor_enabled or u.is_owner) as two_factor
    from iam.users u
    where u.is_active
      and (
        u.is_super_admin
        or exists (
          select 1 from iam.memberships m
          where m.org_id = ${orgId} and m.user_id = u.id
            and m.role = 'org_admin' and m.is_active
        )
      )
  `);

  const grants = await tx.execute<{ user_id: string; granted_by: string }>(sql`
    select user_id, granted_by from iam.memberships
    where org_id = ${orgId} and granted_by is not null
    union
    select user_id, granted_by from iam.membership_granters
    where org_id = ${orgId}
  `);

  const superAdmins = await tx.execute<{ id: string }>(sql`
    select id from iam.users where is_super_admin
  `);

  const votes = await tx.execute<{ voter_user_id: string; candidate_user_id: string }>(sql`
    select voter_user_id, candidate_user_id from iam.trust_votes
    where org_id = ${orgId}
  `);

  const byCandidate = new Map<string, string[]>();
  for (const vote of votes) {
    const list = byCandidate.get(vote.candidate_user_id) ?? [];
    list.push(vote.voter_user_id);
    byCandidate.set(vote.candidate_user_id, list);
  }

  return {
    graph: trustGraph({
      pool: [...pool].map((row): TrustPoolMember => ({
        userId: row.user_id,
        isSuperAdmin: row.is_super_admin,
        twoFactor: row.two_factor,
      })),
      grants: [...grants].map((row): GrantEdge => ({
        userId: row.user_id,
        grantedBy: row.granted_by,
      })),
      superAdminIds: [...superAdmins].map((row) => row.id),
    }),
    votes: byCandidate,
  };
}

/** Record a vote. False when it was already there. */
export async function castVote(
  tx: Tx,
  orgId: string,
  voterId: string,
  candidateId: string,
): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    insert into iam.trust_votes (org_id, voter_user_id, candidate_user_id)
    values (${orgId}, ${voterId}, ${candidateId})
    on conflict (org_id, voter_user_id, candidate_user_id) do nothing
    returning id
  `);
  return rows.length > 0;
}

/** Withdraw a vote. False when there was none. */
export async function withdrawVote(
  tx: Tx,
  orgId: string,
  voterId: string,
  candidateId: string,
): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    delete from iam.trust_votes
    where org_id = ${orgId} and voter_user_id = ${voterId} and candidate_user_id = ${candidateId}
    returning id
  `);
  return rows.length > 0;
}

/** Whether the person holds an active org admin role in this brand now (D-654). */
export async function isActiveOrgAdmin(tx: Tx, orgId: string, userId: string): Promise<boolean> {
  const [row] = await tx.execute<{ found: boolean }>(sql`
    select exists (
      select 1 from iam.memberships
      where org_id = ${orgId} and user_id = ${userId} and role = 'org_admin' and is_active
    ) as found
  `);
  return row?.found === true;
}
