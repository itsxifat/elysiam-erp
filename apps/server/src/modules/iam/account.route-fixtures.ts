import { SEED_ORG_IDS } from '@elysium/db';
import { createTestUser, grantMembership } from '@elysium/db/testing';

/**
 * How the route-matrix suite calls My account, Settings → Security and the Staff screen's
 * sign-out and turn-off (M40, D-070's gate).
 *
 * My account's routes are `@AuthenticatedOnly`, so every role is admitted and acts on itself:
 * reading, renaming and signing out its other devices succeed (and are audited); the second
 * factor's routes are refused by the handler for a wrong password, no factor or a factor its
 * role requires — still admissions, which is what this suite measures. The e2e suites drive
 * the successful paths. `SecurityPolicy` is no membership role's, so the guard refuses every
 * role here; the super admin's side is in `security-policy.e2e.test.ts`.
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

const WRONG = { password: 'not-the-password', code: '000000' } as const;

export const ACCOUNT_ROUTE_FIXTURES: Readonly<Record<string, () => Promise<Call> | Call>> = {
  'GET /v1/account': () => ({ url: '/v1/account' }),
  'PATCH /v1/account/profile': () => ({
    url: '/v1/account/profile',
    body: { name: 'Route Matrix Person' },
  }),
  'GET /v1/account/sessions': () => ({ url: '/v1/account/sessions' }),
  // A session nobody has: 404 for every role, after the guard admitted it.
  'DELETE /v1/account/sessions/:id': () => ({ url: '/v1/account/sessions/no-such-session' }),
  // Each role's client holds one session, so this ends none and is audited.
  'POST /v1/account/sessions/sign-out-others': () => ({
    url: '/v1/account/sessions/sign-out-others',
  }),
  'POST /v1/account/two-factor/replace': () => ({
    url: '/v1/account/two-factor/replace',
    body: WRONG,
  }),
  'POST /v1/account/two-factor/replace/confirm': () => ({
    url: '/v1/account/two-factor/replace/confirm',
    body: { code: '000000' },
  }),
  'POST /v1/account/two-factor/turn-off': () => ({
    url: '/v1/account/two-factor/turn-off',
    body: WRONG,
  }),
  'POST /v1/account/two-factor/recovery-codes': () => ({
    url: '/v1/account/two-factor/recovery-codes',
    body: WRONG,
  }),
  'GET /v1/security/two-factor-policy': () => ({ url: '/v1/security/two-factor-policy' }),
  'PUT /v1/security/two-factor-policy': () => ({
    url: '/v1/security/two-factor-policy',
    body: { requiredRoles: ['org_admin', 'accounts', 'investor'] },
  }),
  // org_admin turns off a sales person's two-step sign-in: nothing requires it of sales.
  'POST /v1/users/:id/two-factor/turn-off': async () => ({
    url: `/v1/users/${await salesPerson({ twoFactorEnabled: true })}/two-factor/turn-off`,
    body: { reason: 'route matrix' },
  }),
  'POST /v1/users/:id/sign-out-everywhere': async () => ({
    url: `/v1/users/${await salesPerson()}/sign-out-everywhere`,
  }),
};
