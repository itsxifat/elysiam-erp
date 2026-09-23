import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';

import { withGlobal, withOrg } from '../client.js';
import { memberships, membershipBranches, users } from '../schema/iam/index.js';
import { resolveContext, type MembershipRole, type RequestContext } from './context.js';

/**
 * Test fixtures for identity.
 *
 * `asUser` is the utility the milestone asks for: later milestones' guards all
 * take a `RequestContext`, so their tests need one without standing up a login
 * flow each time.
 */

export interface CreateUserInput {
  readonly email?: string;
  readonly name?: string;
  readonly phoneNumber?: string | undefined;
  readonly isSuperAdmin?: boolean;
  readonly twoFactorEnabled?: boolean;
}

export interface TestUser {
  readonly id: string;
  readonly email: string;
  readonly name: string;
}

/**
 * Create a user directly.
 *
 * Deliberately not through Better Auth: this exists so a test of *inventory*
 * can get a user in one line, and routing that through a password-hashing
 * sign-up flow would make every later suite slower and more brittle. Tests of
 * authentication itself use the real flow.
 */
export async function createTestUser(input: CreateUserInput = {}): Promise<TestUser> {
  const id = `usr_${randomUUID()}`;
  const email = input.email ?? `${id}@example.invalid`;
  const name = input.name ?? 'Test User';

  await withGlobal(async (tx) => {
    await tx.insert(users).values({
      id,
      email,
      name,
      emailVerified: true,
      phoneNumber: input.phoneNumber ?? null,
      phoneNumberVerified: input.phoneNumber !== undefined,
      twoFactorEnabled: input.twoFactorEnabled ?? false,
      isSuperAdmin: input.isSuperAdmin ?? false,
    });
  });

  return { id, email, name };
}

/**
 * Give a user a role in an org, optionally limited to some branches.
 *
 * Written inside `withOrg` rather than as the owner, so it goes through the
 * same policies the application does — a broken policy breaks the fixture
 * loudly rather than hiding until a real request.
 */
export async function grantMembership(input: {
  readonly userId: string;
  readonly orgId: string;
  readonly role: MembershipRole;
  readonly branchIds?: readonly string[];
}): Promise<string> {
  return withOrg({ orgId: input.orgId, userId: input.userId }, async (tx) => {
    const [row] = await tx
      .insert(memberships)
      .values({ orgId: input.orgId, userId: input.userId, role: input.role })
      .returning({ id: memberships.id });

    if (row === undefined) throw new Error('membership insert returned nothing');

    for (const branchId of input.branchIds ?? []) {
      await tx.insert(membershipBranches).values({
        orgId: input.orgId,
        membershipId: row.id,
        branchId,
      });
    }

    return row.id;
  });
}

export async function revokeMembership(membershipId: string, orgId: string): Promise<void> {
  await withOrg({ orgId }, async (tx) => {
    await tx.update(memberships).set({ isActive: false }).where(eq(memberships.id, membershipId));
  });
}

/**
 * The request context a user would have when acting in an org.
 *
 * Resolved through the real `resolveContext`, so a test that uses it is
 * testing against the same entitlement check a request goes through — not a
 * hand-built object that agrees with the code by construction.
 */
export async function asUser(userId: string, orgId: string): Promise<RequestContext> {
  const context = await resolveContext({ userId, orgId, requestId: `test_${randomUUID()}` });
  if (context === null) {
    throw new Error(`asUser(): ${userId} holds no active membership in ${orgId}. Grant one first.`);
  }
  return context;
}
