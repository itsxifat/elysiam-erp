import { SEED_ORG_IDS } from '@elysium/db';
import { createTestUser, grantMembership } from '@elysium/db/testing';

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

export const USERS_ROUTE_FIXTURES: Readonly<Record<string, () => Promise<Call> | Call>> = {
  'GET /v1/users': () => ({ url: '/v1/users' }),
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
};
