import { SEED_ORG_IDS, withSystem } from '@elysium/db';
import { createTestUser, grantMembership } from '@elysium/db/testing';
import { sql } from 'drizzle-orm';

/**
 * How the route-matrix suite calls the staff routes (gaps-users-auth, D-070's gate).
 *
 * Every call names a person made for it: a `sales` member of the seed brand, so the one
 * admitted role (org_admin) succeeds and is audited, and the second call never finds the
 * first one's change. The password link goes to someone who never set a password, which
 * is a re-sent invite and needs no second admin; the second-factor reset to someone with
 * one enrolled and no power to approve anything.
 */

interface Call {
  readonly url: string;
  readonly body?: unknown;
}

const ORG_A = SEED_ORG_IDS['elysium-lifestyle-bd'] ?? '';

async function salesPerson(options: { twoFactorEnabled?: boolean } = {}): Promise<string> {
  const user = await createTestUser({
    name: 'Route Matrix Staff',
    ...(options.twoFactorEnabled === undefined
      ? {}
      : { twoFactorEnabled: options.twoFactorEnabled }),
  });
  await grantMembership({ userId: user.id, orgId: ORG_A, role: 'sales' });
  return user.id;
}

/**
 * An admin nobody here invited (D-654 to D-656): every admin with two-step sign-in, the
 * matrix's own org_admin included, is independent of them and may vouch.
 */
async function freshAdmin(): Promise<string> {
  const user = await createTestUser({ name: 'Route Matrix Admin' });
  await grantMembership({ userId: user.id, orgId: ORG_A, role: 'org_admin' });
  return user.id;
}

export const USERS_ROUTE_FIXTURES: Readonly<Record<string, () => Promise<Call> | Call>> = {
  'GET /v1/users': () => ({ url: '/v1/users' }),
  // D-898: every role is admitted; an id nobody has names nobody.
  'GET /v1/staff-names': () => ({ url: '/v1/staff-names?ids=usr_nobody' }),
  'PUT /v1/users/:id/roles': async () => ({
    url: `/v1/users/${await salesPerson()}/roles`,
    body: { roles: [{ role: 'warehouse', branchIds: [] }] },
  }),
  'POST /v1/users/:id/deactivate': async () => ({
    url: `/v1/users/${await salesPerson()}/deactivate`,
    body: { reason: 'route matrix' },
  }),
  'POST /v1/users/:id/password-link': async () => ({
    url: `/v1/users/${await salesPerson()}/password-link`,
    body: { reason: 'route matrix' },
  }),
  'POST /v1/users/:id/two-factor/reset': async () => ({
    url: `/v1/users/${await salesPerson({ twoFactorEnabled: true })}/two-factor/reset`,
    body: { reason: 'route matrix' },
  }),
  'POST /v1/users/:id/trust': async () => ({ url: `/v1/users/${await freshAdmin()}/trust` }),
  'DELETE /v1/users/:id/trust': async () => {
    // Every active admin of the brand has vouched already, so whichever admin calls has a
    // vote of their own to withdraw.
    const candidate = await freshAdmin();
    await withSystem(
      async (tx) =>
        tx.execute(sql`
          insert into iam.trust_votes (org_id, voter_user_id, candidate_user_id)
          select m.org_id, m.user_id, ${candidate}
          from iam.memberships m
          where m.org_id = ${ORG_A} and m.role = 'org_admin' and m.is_active
            and m.user_id <> ${candidate}
          on conflict do nothing
        `),
      { orgId: ORG_A },
    );
    return { url: `/v1/users/${candidate}/trust` };
  },
  // D-659: only a super admin makes a super admin, and the matrix has none, so the admitted
  // role (org_admin) reaches the handler and is refused there (403, "Only a super admin…"),
  // which is still an admission; the e2e suite drives the super admin's side.
  'POST /v1/users/:id/super-admin': async () => ({
    url: `/v1/users/${await freshAdmin()}/super-admin`,
  }),
  'DELETE /v1/users/:id/super-admin': async () => ({
    url: `/v1/users/${await freshAdmin()}/super-admin`,
  }),
  // D-685, D-686: only a super admin removes one or steps down, and the matrix has none, so
  // org_admin reaches the handler and is refused there (403, "Only a super admin…").
  'POST /v1/users/:id/super-admin-removal': async () => ({
    url: `/v1/users/${await freshAdmin()}/super-admin-removal`,
  }),
  'DELETE /v1/users/:id/super-admin-removal': async () => ({
    url: `/v1/users/${await freshAdmin()}/super-admin-removal`,
  }),
  'POST /v1/users/me/step-down': () => ({ url: '/v1/users/me/step-down' }),
};
