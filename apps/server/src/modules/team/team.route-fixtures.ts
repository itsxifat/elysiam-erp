import { SEED_ORG_IDS } from '@elysium/db';
import { createTestUser, grantMembership } from '@elysium/db/testing';

/**
 * How the route-matrix suite calls M41's team routes (M02b's D-070 gate).
 *
 * The heartbeat and the pause switch are the caller's own, so every admitted role's first call
 * changes its presence (from never seen to active, and from taking orders to not) and is
 * audited. A desk profile is saved for a fresh sales person each time.
 */

interface Call {
  readonly url: string;
  readonly body?: unknown;
}

const ORG_A = SEED_ORG_IDS['elysium-lifestyle-bd'] ?? '';

async function salesPerson(): Promise<string> {
  const user = await createTestUser({ name: 'Route Matrix Desk' });
  await grantMembership({ userId: user.id, orgId: ORG_A, role: 'sales' });
  return user.id;
}

export const TEAM_ROUTE_FIXTURES: Readonly<Record<string, () => Promise<Call> | Call>> = {
  'POST /v1/team/presence': () => ({
    url: '/v1/team/presence',
    body: { visible: true, idleSeconds: 0 },
  }),
  'POST /v1/team/presence/pause': () => ({
    url: '/v1/team/presence/pause',
    body: { paused: true },
  }),
  'GET /v1/team/me': () => ({ url: '/v1/team/me' }),
  'GET /v1/team/profiles': () => ({ url: '/v1/team/profiles' }),
  'PUT /v1/team/profiles/:userId': async () => ({
    url: `/v1/team/profiles/${await salesPerson()}`,
    body: { workTypes: ['orders'], hubLocationId: null },
  }),
};
