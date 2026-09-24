import { defineAbilityFor, MEMBERSHIP_ROLES, type MembershipRole } from '@elysium/contracts';
import { withSystem } from '@elysium/db';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ORG_A,
  startHttpHarness,
  type HttpHarness,
  type RoleClient,
} from '../../testing/http-harness.js';
import { describeRoutes, type RouteDeclaration } from './route-map.js';
import { ROUTE_MATRIX_MANIFEST, routeKey } from './route-matrix.manifest.js';

/**
 * The route-matrix suite (M02b checks 1, 3 and 6; D-070).
 *
 * Generated from two things the application cannot fake: the routes Nest
 * actually registered, and the permission matrix. For every non-public route,
 * as every role, it makes a real request and asserts that the guard admits
 * exactly the roles the matrix grants — and, for every mutation that succeeds,
 * that an audit row was written for the actor.
 *
 * A route cannot be missing from it: the first test fails when a live route
 * has no fixture here, and `check-route-matrix` fails the build when a route is
 * missing from the manifest these fixtures are keyed by.
 */

let harness: HttpHarness;
const clients = new Map<MembershipRole, RoleClient>();

beforeAll(async () => {
  harness = await startHttpHarness('route-matrix');
  for (const role of MEMBERSHIP_ROLES) clients.set(role, await harness.asRole(role, ORG_A));
}, 300_000);

afterAll(async () => {
  await harness?.close();
}, 60_000);

interface Call {
  readonly url: string;
  readonly body?: unknown;
}

/**
 * How to call each route for real. `prepare` runs once per role, so a route
 * that consumes state (deciding a request) gets fresh state each time.
 */
const FIXTURES: Readonly<Record<string, () => Promise<Call> | Call>> = {
  'GET /v1/approvals': () => ({ url: '/v1/approvals' }),
  'POST /v1/approvals': () => ({
    url: '/v1/approvals',
    body: { type: 'wallet_adjustment', amountPoisha: '900000' },
  }),
  'POST /v1/approvals/:id/decide': async () => {
    // A request nobody else holds, of a type most checkers may decide, raised
    // by a maker who is none of the roles under test.
    const maker = await harness.asRole('org_admin', ORG_A);
    const created = await maker.client.request('POST', '/v1/approvals', {
      body: { type: 'closing_variance', amountPoisha: '900000' },
    });
    const { id } = JSON.parse(created.body) as { id: string };
    return { url: `/v1/approvals/${id}/decide`, body: { decision: 'approved' } };
  },
  'PUT /v1/approvals/thresholds': () => ({
    url: '/v1/approvals/thresholds',
    // A type that may have a threshold (bonus_rule may not, D-071). The first
    // one is a relaxation, so it comes back pending a second org admin — still
    // a successful, audited mutation.
    body: { type: 'supplier_payment', thresholdPoisha: '100000' },
  }),
  'GET /v1/demo/costed-items': () => ({ url: '/v1/demo/costed-items' }),
  'POST /v1/demo/costed-items': () => ({
    url: '/v1/demo/costed-items',
    body: { sku: `RM-${String(Date.now())}-${Math.random().toString(36).slice(2, 7)}`, name: 'x' },
  }),
  'GET /v1/me': () => ({ url: '/v1/me' }),
  'POST /v1/me/active-org': () => ({ url: '/v1/me/active-org', body: { orgId: ORG_A } }),
  'GET /v1/me/orgs': () => ({ url: '/v1/me/orgs' }),
  'POST /v1/users': () => ({
    url: '/v1/users',
    body: {
      email: `rm_${String(Date.now())}_${Math.random().toString(36).slice(2, 7)}@example.invalid`,
      name: 'Route Matrix',
      role: 'sales',
    },
  }),
};

function testedRoutes(): RouteDeclaration[] {
  return describeRoutes(harness.app).filter((route) => !route.declared?.startsWith('public:'));
}

async function auditCount(userId: string): Promise<number> {
  const [row] = await withSystem(
    async (tx) =>
      tx.execute<{ n: string }>(
        sql`select count(*)::text as n from audit.audit_log where actor_user_id = ${userId}`,
      ),
    { orgId: ORG_A },
  );
  return Number(row?.n ?? 0);
}

describe('the suite covers every route there is', () => {
  it('has a fixture for every live non-public route, and the manifest agrees', () => {
    const live = testedRoutes().map(routeKey).sort();
    expect(live.length).toBeGreaterThan(5);
    expect(Object.keys(FIXTURES).sort(), 'fixtures vs live routes').toEqual(live);
    expect([...ROUTE_MATRIX_MANIFEST].sort(), 'manifest vs live routes').toEqual(live);
  });
});

describe('every route × every role: the guard admits exactly what the matrix grants', () => {
  it('holds for all of them, and every successful mutation is audited', async () => {
    const wrong: string[] = [];
    let admitted = 0;
    let refused = 0;
    let auditedMutations = 0;

    for (const route of testedRoutes()) {
      const fixture = FIXTURES[routeKey(route)];
      if (fixture === undefined) continue; // reported by the test above

      for (const role of MEMBERSHIP_ROLES) {
        const actor = clients.get(role);
        if (actor === undefined) throw new Error(`no client for ${role}`);

        const expected =
          route.ability === null
            ? true // @AuthenticatedOnly: every signed-in role
            : defineAbilityFor({
                roles: [role],
                isSuperAdmin: false,
                userId: actor.userId,
                branchIds: [],
              }).can(route.ability.action, route.ability.subject);

        const call = await fixture();
        const before = await auditCount(actor.userId);
        const response = await actor.client.request(route.method, call.url, {
          ...(call.body === undefined ? {} : { body: call.body }),
        });
        const label = `${role} ${route.method} ${route.path} -> ${String(response.statusCode)}`;

        const guardRefused =
          response.statusCode === 403 &&
          /You cannot|declares no ability|contradict/.test(response.body);

        if (response.statusCode >= 500) wrong.push(`${label}: server error ${response.body}`);
        if (response.statusCode === 401) wrong.push(`${label}: not signed in?`);

        if (expected && guardRefused)
          wrong.push(`${label}: the matrix grants it, the guard refused`);
        if (!expected && !guardRefused)
          wrong.push(`${label}: the matrix denies it, the guard let it through`);

        if (guardRefused) refused += 1;
        else admitted += 1;

        // Check 3: a mutation that succeeded left a row for its actor. The
        // interceptor writes after the response, so poll briefly.
        const mutation = route.method !== 'GET';
        if (mutation && response.statusCode < 300) {
          let after = await auditCount(actor.userId);
          for (let attempt = 0; attempt < 20 && after <= before; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 100));
            after = await auditCount(actor.userId);
          }
          if (after <= before) wrong.push(`${label}: succeeded with no audit row`);
          else auditedMutations += 1;
        }
      }
    }

    expect(wrong, wrong.slice(0, 15).join('\n')).toEqual([]);

    // Not vacuous: plenty of each outcome, and every mutation route was
    // exercised successfully by at least one role.
    expect(admitted).toBeGreaterThan(20);
    expect(refused).toBeGreaterThan(20);
    const mutationRoutes = testedRoutes().filter((route) => route.method !== 'GET').length;
    expect(auditedMutations).toBeGreaterThanOrEqual(mutationRoutes);
  }, 600_000);
});
