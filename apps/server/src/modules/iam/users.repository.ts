import { randomBytes, randomUUID } from 'node:crypto';

import type { MembershipRole } from '@elysium/contracts';
import type { Tx } from '@elysium/db';
import { sql } from 'drizzle-orm';

/**
 * The staff screen's SQL (gaps-users-auth). Every statement names `iam.*` and nothing
 * else (invariant 12, `module-boundaries.test.ts`).
 *
 * Two kinds of table, reached two ways. `iam.memberships`, `iam.membership_branches` and
 * `iam.credential_resets` are tenant tables: each function here takes the caller's
 * `withOrg` transaction, so RLS is the floor and the explicit `org_id = …` the index's
 * leading column. `iam.users`, `iam.accounts`, `iam.sessions`, `iam.verifications` and
 * `iam.two_factors` are global (§5 exception 4) and carry no org; they are written inside
 * the same transaction, so a deactivation and the sessions it ends commit together.
 */

// --- the person lock -------------------------------------------------------------------

/**
 * Serialise every change to one person's access (the ledger audit's W4, W5; re-audit W2).
 *
 * Roles, deactivation, links, second-factor resets, an approval's executor and an invite
 * all take this first, then read the facts they decide on, inside the transaction that
 * acts on them — so a promotion, a role in a second brand or a parallel reset cannot slip
 * between the check and the write. Keyed on the person alone, not the brand: what it
 * protects — other brands' memberships, the password, the links, the sessions — is
 * global. No path holds an approval row it took after this lock, so a decision (approval
 * row, then this) cannot deadlock with it.
 */
export async function lockPerson(tx: Tx, userId: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`iam.person:${userId}`}, 0))`,
  );
}

// --- memberships ---------------------------------------------------------------------

/**
 * People with an enabled account and an active role in a brand (`IamApi`, D-419).
 *
 * In the caller's `withOrg` transaction, so RLS shows this brand's memberships and no
 * other's. Never a super admin who holds no membership: they are not linked to an employee
 * or an investor of a brand.
 */
export async function activeMembers(
  tx: Tx,
  orgId: string,
  roles: readonly MembershipRole[] | undefined,
): Promise<{ user_id: string; name: string; email: string; roles: MembershipRole[] }[]> {
  const rows = await tx.execute<{
    user_id: string;
    name: string;
    email: string;
    roles: MembershipRole[];
  }>(sql`
    select u.id as user_id, u.name, u.email,
           array_agg(distinct m.role::text order by m.role::text) as roles
    from iam.memberships m
    join iam.users u on u.id = m.user_id
    where m.org_id = ${orgId}
      and m.is_active
      and u.is_active
      -- An owner holds no role (D-473, a trigger refuses one); this says so here as well.
      and not u.is_owner
      and ${
        roles === undefined ? sql`true` : sql`m.role::text = any (${sql.param([...roles])}::text[])`
      }
    group by u.id, u.name, u.email
    order by u.name, u.id
    limit 1000
  `);
  return [...rows];
}

/** The owners among these people (D-473), with their names, for the caller to mask. */
export async function ownersAmong(
  tx: Tx,
  userIds: readonly string[],
): Promise<{ id: string; name: string }[]> {
  const ids = [...new Set(userIds)].filter((id) => id !== '');
  if (ids.length === 0) return [];
  const rows = await tx.execute<{ id: string; name: string }>(sql`
    select u.id, u.name from iam.users u
    where u.is_owner and u.id = any(${sql.param(ids)}::text[])
  `);
  return [...rows];
}

export interface MembershipRow extends Record<string, unknown> {
  readonly id: string;
  readonly user_id: string;
  readonly role: MembershipRole;
  readonly is_active: boolean;
  readonly granted_by: string | null;
  readonly branch_ids: readonly string[];
}

const MEMBERSHIP_COLUMNS = sql`
  m.id, m.user_id, m.role, m.is_active, m.granted_by,
  coalesce(
    array_agg(mb.branch_id::text order by mb.branch_id) filter (where mb.branch_id is not null),
    '{}'
  ) as branch_ids
`;

/** Everyone who holds or has held a role in this brand, one row per role. */
export async function membershipsInOrg(tx: Tx, orgId: string): Promise<MembershipRow[]> {
  const rows = await tx.execute<MembershipRow>(sql`
    select ${MEMBERSHIP_COLUMNS}
    from iam.memberships m
    left join iam.membership_branches mb on mb.org_id = m.org_id and mb.membership_id = m.id
    where m.org_id = ${orgId}
    group by m.id
    order by m.user_id, m.role
  `);
  return [...rows];
}

/** One person's roles in this brand, locked for a change to them. */
export async function membershipsOfUser(
  tx: Tx,
  orgId: string,
  userId: string,
  options: { readonly lock?: boolean } = {},
): Promise<MembershipRow[]> {
  if (options.lock === true) {
    await tx.execute(sql`
      select id from iam.memberships
      where org_id = ${orgId} and user_id = ${userId}
      for update
    `);
  }
  const rows = await tx.execute<MembershipRow>(sql`
    select ${MEMBERSHIP_COLUMNS}
    from iam.memberships m
    left join iam.membership_branches mb on mb.org_id = m.org_id and mb.membership_id = m.id
    where m.org_id = ${orgId} and m.user_id = ${userId}
    group by m.id
    order by m.role
  `);
  return [...rows];
}

/**
 * Grant a role, or grant it again: active, with the acting admin as its granter (D-077),
 * whatever it was before. Returns the membership id.
 */
export async function grantRole(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly userId: string;
    readonly role: MembershipRole;
    readonly grantedBy: string;
  },
): Promise<string> {
  const rows = await tx.execute<{ id: string }>(sql`
    insert into iam.memberships (org_id, user_id, role, granted_by)
    values (${input.orgId}, ${input.userId}, ${input.role}::iam.membership_role, ${input.grantedBy})
    on conflict (org_id, user_id, role) do update
      set is_active = true, granted_by = excluded.granted_by, updated_at = now()
    returning id
  `);
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('the membership upsert returned no id');
  return id;
}

/** Replace a membership's branch scope. Empty means the whole brand (§6). */
export async function setBranches(
  tx: Tx,
  orgId: string,
  membershipId: string,
  branchIds: readonly string[],
): Promise<void> {
  await tx.execute(sql`
    delete from iam.membership_branches
    where org_id = ${orgId} and membership_id = ${membershipId}
  `);
  for (const branchId of branchIds) {
    // The composite foreign key refuses another brand's branch (D-047); the service
    // turns that refusal into a 400.
    await tx.execute(sql`
      insert into iam.membership_branches (org_id, membership_id, branch_id)
      values (${orgId}, ${membershipId}, ${branchId})
      on conflict (membership_id, branch_id) do nothing
    `);
  }
}

/** Switch roles off. History is kept: who held what, and who granted it, stays readable. */
export async function revokeRoles(
  tx: Tx,
  orgId: string,
  userId: string,
  roles: readonly MembershipRole[] | 'all',
): Promise<MembershipRole[]> {
  const rows = await tx.execute<{ role: MembershipRole }>(
    roles === 'all'
      ? sql`
          update iam.memberships set is_active = false, updated_at = now()
          where org_id = ${orgId} and user_id = ${userId} and is_active
          returning role
        `
      : sql`
          update iam.memberships set is_active = false, updated_at = now()
          where org_id = ${orgId} and user_id = ${userId} and is_active
            and role::text = any(${sql.param([...roles])}::text[])
          returning role
        `,
  );
  return [...rows].map((row) => row.role);
}

/**
 * Add a granter to the person's lineage in this brand (D-077, D-406, D-410): an admin who
 * granted them a role, or who was handed a link that sets their password. From then on
 * the person never approves that admin's requests. Appended, never overwritten, so an
 * earlier granter stays in the lineage.
 */
export async function addGranter(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly userId: string;
    readonly grantedBy: string;
    readonly reason: 'role_granted' | 'link_issued';
  },
): Promise<void> {
  if (input.grantedBy === input.userId) return;
  await tx.execute(sql`
    insert into iam.membership_granters (org_id, user_id, granted_by, reason)
    values (${input.orgId}, ${input.userId}, ${input.grantedBy}, ${input.reason})
  `);
}

// --- people (global) -------------------------------------------------------------------

export interface PersonRow extends Record<string, unknown> {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly is_active: boolean;
  readonly is_super_admin: boolean;
  /** An owner (D-473): named "Owner" to everyone but other owners. */
  readonly is_owner: boolean;
  readonly two_factor_enabled: boolean;
  readonly last_sign_in_at: Date | null;
  readonly has_password: boolean;
  /** When the newest unexpired password link stops working, if there is one. */
  readonly link_expires_at: Date | null;
}

export async function people(tx: Tx, userIds: readonly string[]): Promise<PersonRow[]> {
  if (userIds.length === 0) return [];
  const rows = await tx.execute<PersonRow>(sql`
    select u.id, u.name, u.email, u.is_active, u.is_super_admin, u.is_owner, u.two_factor_enabled,
           u.last_sign_in_at,
           exists (
             select 1 from iam.accounts a
             where a.user_id = u.id and a.provider_id = 'credential'
           ) as has_password,
           (
             select max(v.expires_at) from iam.verifications v
             where v.identifier like 'reset-password:%' and v.value = u.id
               and v.expires_at > now()
           ) as link_expires_at
    from iam.users u
    where u.id = any(${sql.param([...userIds])}::text[])
  `);
  return [...rows];
}

/**
 * Which of these people hold an active role in another active brand? (D-405)
 *
 * Through `iam.users_active_elsewhere` (migration 0101), which looks through each
 * person's own lens — the D-050 self policy — because the acting admin's org context
 * cannot see another brand's rows, which is the point of it. Inside the caller's
 * transaction, one round trip for the whole list; it returns ids, never a brand.
 */
export async function activeElsewhere(
  tx: Tx,
  userIds: readonly string[],
  orgId: string,
): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const rows = await tx.execute<{ user_id: string }>(sql`
    select iam.users_active_elsewhere(${sql.param([...userIds])}::text[], ${orgId}::uuid) as user_id
  `);
  return new Set([...rows].map((row) => row.user_id));
}

/**
 * Which of these people have ever held a role in a brand other than `orgId` (D-412).
 *
 * Through `iam.users_held_elsewhere` (migration 0102), the same own-lens read as
 * `activeElsewhere`, except that a revoked role and a closed brand count too. Inside the
 * caller's transaction, after the person lock.
 */
export async function heldElsewhere(
  tx: Tx,
  userIds: readonly string[],
  orgId: string,
): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const rows = await tx.execute<{ user_id: string }>(sql`
    select iam.users_held_elsewhere(${sql.param([...userIds])}::text[], ${orgId}::uuid) as user_id
  `);
  return new Set([...rows].map((row) => row.user_id));
}

/** Does this person hold an active role in this brand? In its own context. */
export async function heldHere(tx: Tx, orgId: string, userId: string): Promise<boolean> {
  const rows = await tx.execute<{ found: boolean }>(sql`
    select exists (
      select 1 from iam.memberships
      where org_id = ${orgId} and user_id = ${userId} and is_active
    ) as found
  `);
  return rows[0]?.found === true;
}

/** End every session this person holds, or only those acting in one brand. */
export async function endSessions(
  tx: Tx,
  userId: string,
  scope: { readonly orgId: string } | 'all',
): Promise<number> {
  const rows = await tx.execute<{ id: string }>(
    scope === 'all'
      ? sql`delete from iam.sessions where user_id = ${userId} returning id`
      : sql`
          delete from iam.sessions
          where user_id = ${userId} and active_org_id = ${scope.orgId}
          returning id
        `,
  );
  return rows.length;
}

/** Void every unused password link, and every remembered device, for this person. */
export async function voidLinks(
  tx: Tx,
  userId: string,
  options: { readonly devices: boolean },
): Promise<number> {
  const rows = await tx.execute<{ id: string }>(sql`
    delete from iam.verifications
    where value = ${userId}
      and (
        identifier like 'reset-password:%'
        ${options.devices ? sql`or identifier like 'trust-device-%' or identifier like '2fa-%'` : sql``}
      )
    returning id
  `);
  return rows.length;
}

/** The password stops working at once; the link sets a new one (D-402). */
export async function voidPassword(tx: Tx, userId: string): Promise<void> {
  await tx.execute(sql`
    update iam.accounts set password = null, updated_at = now()
    where user_id = ${userId} and provider_id = 'credential'
  `);
}

/** Remove an enrolled second factor; the next sign-in meets the enrolment wall (§6). */
export async function removeSecondFactor(tx: Tx, userId: string): Promise<void> {
  await tx.execute(sql`delete from iam.two_factors where user_id = ${userId}`);
  await tx.execute(sql`
    update iam.users set two_factor_enabled = false, updated_at = now() where id = ${userId}
  `);
}

/**
 * Mint a password link inside the caller's transaction (the ledger audit's W6).
 *
 * Better Auth redeems a link by consuming the `iam.verifications` row named
 * `reset-password:<token>` whose value is the user id — the row its own
 * `requestPasswordReset` writes. Writing that row here, after voiding every earlier one,
 * makes "one person, one working link" true under concurrency and commits the link with
 * the reset row and the audit entry, or not at all. 32 random bytes, base64url.
 */
export async function mintLink(
  tx: Tx,
  userId: string,
  seconds: number,
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const rows = await tx.execute<{ expires_at: Date }>(sql`
    insert into iam.verifications (id, identifier, value, expires_at)
    values (
      ${randomUUID()}, ${`reset-password:${token}`}, ${userId},
      now() + make_interval(secs => ${seconds})
    )
    returning expires_at
  `);
  const expiresAt = rows[0]?.expires_at;
  if (expiresAt === undefined) throw new Error('the password link insert returned nothing');
  return { token, expiresAt: new Date(expiresAt) };
}

// --- resets ------------------------------------------------------------------------------

export type ResetKindColumn = 'invite' | 'password' | 'two_factor';

export interface ResetRow extends Record<string, unknown> {
  readonly id: string;
  readonly user_id: string;
  readonly kind: ResetKindColumn;
  readonly status: string;
  readonly requested_by: string;
  readonly reason: string;
  readonly approval_request_id: string | null;
  readonly decided_by: string | null;
  readonly decided_at: Date | null;
  readonly link_expires_at: Date | null;
  readonly created_at: Date;
}

const RESET_COLUMNS = sql`
  id, user_id, kind, status, requested_by, reason, approval_request_id,
  decided_by, decided_at, link_expires_at, created_at
`;

/** An approved password reset nobody collected in 24 hours is no longer open (D-404). */
export async function expireStaleResets(tx: Tx, orgId: string, userId: string): Promise<void> {
  await tx.execute(sql`
    update iam.credential_resets set status = 'expired'
    where org_id = ${orgId} and user_id = ${userId} and status = 'approved'
      and decided_at < now() - interval '24 hours'
  `);
}

/** Resets still waiting for a second admin, or for the requester to collect. */
export async function openResets(tx: Tx, orgId: string): Promise<ResetRow[]> {
  const rows = await tx.execute<ResetRow>(sql`
    select ${RESET_COLUMNS} from iam.credential_resets
    where org_id = ${orgId} and status in ('pending_approval', 'approved')
      and (status = 'pending_approval' or decided_at >= now() - interval '24 hours')
    order by created_at
  `);
  return [...rows];
}

export async function openResetFor(
  tx: Tx,
  orgId: string,
  userId: string,
  kind: ResetKindColumn,
): Promise<ResetRow | undefined> {
  const rows = await tx.execute<ResetRow>(sql`
    select ${RESET_COLUMNS} from iam.credential_resets
    where org_id = ${orgId} and user_id = ${userId} and kind = ${kind}
      and status in ('pending_approval', 'approved')
    for update
  `);
  return rows[0];
}

export async function resetById(tx: Tx, orgId: string, id: string): Promise<ResetRow | undefined> {
  const rows = await tx.execute<ResetRow>(sql`
    select ${RESET_COLUMNS} from iam.credential_resets
    where org_id = ${orgId} and id = ${id}
    for update
  `);
  return rows[0];
}

/** Every open reset this person is the subject or the requester of, locked when asked. */
export async function openResetsTouching(
  tx: Tx,
  orgId: string,
  userId: string,
  options: { readonly lock: boolean },
): Promise<ResetRow[]> {
  const rows = await tx.execute<ResetRow>(sql`
    select ${RESET_COLUMNS} from iam.credential_resets
    where org_id = ${orgId} and status in ('pending_approval', 'approved')
      and (user_id = ${userId} or requested_by = ${userId})
    order by approval_request_id, id
    ${options.lock ? sql`for update` : sql``}
  `);
  return [...rows];
}

export async function insertReset(
  tx: Tx,
  row: {
    readonly id: string;
    readonly orgId: string;
    readonly userId: string;
    readonly kind: ResetKindColumn;
    readonly status: 'pending_approval' | 'completed';
    readonly requestedBy: string;
    readonly reason: string;
    readonly approvalRequestId: string | null;
    readonly linkExpiresAt: Date | null;
  },
): Promise<void> {
  await tx.execute(sql`
    insert into iam.credential_resets
      (id, org_id, user_id, kind, status, requested_by, reason, approval_request_id,
       completed_at, link_expires_at)
    values (
      ${row.id}, ${row.orgId}, ${row.userId}, ${row.kind}, ${row.status}, ${row.requestedBy},
      ${row.reason}, ${row.approvalRequestId},
      ${row.status === 'completed' ? sql`now()` : null},
      ${row.linkExpiresAt === null ? null : row.linkExpiresAt.toISOString()}::timestamptz
    )
  `);
}

export async function moveReset(
  tx: Tx,
  orgId: string,
  id: string,
  change: {
    readonly status: 'approved' | 'completed' | 'rejected' | 'cancelled' | 'expired';
    readonly decidedBy?: string;
    readonly linkExpiresAt?: Date | null;
  },
): Promise<void> {
  await tx.execute(sql`
    update iam.credential_resets
    set status = ${change.status},
        decided_by = ${change.decidedBy ?? sql`decided_by`},
        decided_at = ${change.decidedBy === undefined ? sql`decided_at` : sql`now()`},
        completed_at = ${change.status === 'completed' ? sql`now()` : sql`completed_at`},
        link_expires_at = ${
          change.linkExpiresAt === undefined || change.linkExpiresAt === null
            ? sql`link_expires_at`
            : sql`${change.linkExpiresAt.toISOString()}::timestamptz`
        }
    where org_id = ${orgId} and id = ${id}
  `);
}

/** The reset limits' counts (D-402), from the log rather than memory. */
export async function resetCounts(
  tx: Tx,
  orgId: string,
  actorId: string,
  userId: string,
): Promise<{ byActorLastHour: number; forTargetLastDay: number }> {
  const rows = await tx.execute<{ by_actor: number; for_target: number }>(sql`
    select
      (select count(*) from iam.credential_resets
        where org_id = ${orgId} and requested_by = ${actorId}
          and created_at > now() - interval '1 hour')::int as by_actor,
      (select count(*) from iam.credential_resets
        where org_id = ${orgId} and user_id = ${userId}
          and created_at > now() - interval '1 day')::int as for_target
  `);
  return {
    byActorLastHour: Number(rows[0]?.by_actor ?? 0),
    forTargetLastDay: Number(rows[0]?.for_target ?? 0),
  };
}
