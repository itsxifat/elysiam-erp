import { and, eq, inArray } from 'drizzle-orm';

import { withOrg, withUser, type Tx } from '../client.js';
import { memberships, membershipBranches, users } from '../schema/iam/index.js';
import { organizations } from '../schema/org/index.js';

/**
 * The request context (architecture §6).
 *
 * Every later milestone's guard reads this object: who is acting, in which
 * org, with which roles, over which branches. It is resolved once per request
 * from the session and then carried, because resolving it twice invites the
 * two answers to differ.
 */

export type MembershipRole =
  | 'org_admin'
  | 'sales'
  | 'accounts'
  | 'marketing'
  | 'hr'
  | 'branch_manager'
  | 'warehouse'
  | 'reseller'
  | 'investor';

export interface RequestContext {
  readonly userId: string;
  readonly isSuperAdmin: boolean;
  /** The org this request acts in. Null before an org has been chosen. */
  readonly orgId: string | null;
  readonly roles: readonly MembershipRole[];
  /**
   * Branch ids this membership is limited to. Empty means the whole org —
   * *not* "no branches". M02b enforces it; M02a only records it.
   */
  readonly branchIds: readonly string[];
  readonly requestId: string;
}

export interface AvailableOrg {
  readonly orgId: string;
  readonly slug: string;
  readonly displayName: string;
  readonly roles: readonly MembershipRole[];
}

/**
 * Which orgs this user may enter.
 *
 * Runs through the self policy on `iam.memberships` (D-050), which is why this
 * can answer across orgs without an org context: the policy returns a user's
 * own rows anywhere, and nobody else's. A super admin sees every org, which is
 * a different question and answered separately below.
 *
 * `app.user_id` has to be set for the policy to match, so this opens a
 * transaction that sets it and nothing else.
 */
export async function availableOrgs(userId: string): Promise<AvailableOrg[]> {
  return withUser({ userId }, async (tx) => {
    const [user] = await tx
      .select({ isSuperAdmin: users.isSuperAdmin, isActive: users.isActive })
      .from(users)
      .where(eq(users.id, userId));

    if (!user?.isActive) return [];

    if (user.isSuperAdmin) {
      // §5 exception 3: a super admin sees every org. Still read-only here —
      // acting in one still means choosing one.
      const rows = await tx
        .select({
          orgId: organizations.id,
          slug: organizations.slug,
          displayName: organizations.displayName,
        })
        .from(organizations)
        .where(eq(organizations.isActive, true));

      return rows.map((row) => ({ ...row, roles: ['org_admin' as const] }));
    }

    const rows = await tx
      .select({
        orgId: organizations.id,
        slug: organizations.slug,
        displayName: organizations.displayName,
        role: memberships.role,
      })
      .from(memberships)
      .innerJoin(organizations, eq(organizations.id, memberships.orgId))
      .where(and(eq(memberships.userId, userId), eq(memberships.isActive, true)));

    const byOrg = new Map<string, AvailableOrg>();
    for (const row of rows) {
      const existing = byOrg.get(row.orgId);
      if (existing === undefined) {
        byOrg.set(row.orgId, {
          orgId: row.orgId,
          slug: row.slug,
          displayName: row.displayName,
          roles: [row.role],
        });
      } else {
        byOrg.set(row.orgId, { ...existing, roles: [...existing.roles, row.role] });
      }
    }

    return [...byOrg.values()];
  });
}

/**
 * Build the context for a user acting in one org.
 *
 * Returns null when the user holds no active membership there. That check is
 * the gate: a session carries an `active_org_id`, but a membership can be
 * revoked while the session lives, so entitlement is re-read per request rather
 * than trusted from the session.
 */
export async function resolveContext(input: {
  readonly userId: string;
  readonly orgId: string;
  readonly requestId: string;
}): Promise<RequestContext | null> {
  const [user] = await withUser({ userId: input.userId, requestId: input.requestId }, async (tx) =>
    tx
      .select({ isSuperAdmin: users.isSuperAdmin, isActive: users.isActive })
      .from(users)
      .where(eq(users.id, input.userId)),
  );

  if (!user?.isActive) return null;

  if (user.isSuperAdmin) {
    return {
      userId: input.userId,
      isSuperAdmin: true,
      orgId: input.orgId,
      roles: ['org_admin'],
      branchIds: [],
      requestId: input.requestId,
    };
  }

  return withOrg(
    { orgId: input.orgId, userId: input.userId, requestId: input.requestId },
    async (tx: Tx) => {
      // `org_id` is filtered explicitly, and that is not belt-and-braces.
      //
      // `iam.memberships` carries two permissive policies and PostgreSQL ORs
      // them, so inside an org context the self policy still returns this
      // user's memberships in *every* org (D-050). Relying on RLS alone here
      // would hand someone their org B role while they act in org A — which
      // the test caught, and which would have been a privilege escalation
      // across brands.
      //
      // The lesson generalises: a table with more than one permissive policy
      // is not scoped by RLS alone.
      const held = await tx
        .select({ id: memberships.id, role: memberships.role })
        .from(memberships)
        .where(
          and(
            eq(memberships.orgId, input.orgId),
            eq(memberships.userId, input.userId),
            eq(memberships.isActive, true),
          ),
        );

      if (held.length === 0) return null;

      const membershipIds = held.map((row) => row.id);
      const scopes = await tx
        .select({ branchId: membershipBranches.branchId })
        .from(membershipBranches)
        .where(inArray(membershipBranches.membershipId, membershipIds));

      return {
        userId: input.userId,
        isSuperAdmin: false,
        orgId: input.orgId,
        roles: held.map((row) => row.role),
        branchIds: scopes.map((row) => row.branchId),
        requestId: input.requestId,
      };
    },
  );
}

/** Does this user hold an active membership in this org? */
export async function canEnterOrg(userId: string, orgId: string): Promise<boolean> {
  const orgs = await availableOrgs(userId);
  return orgs.some((org) => org.orgId === orgId);
}
