import { randomUUID } from 'node:crypto';

import { defineAbilityFor, MEMBERSHIP_ROLES, type MembershipRole } from '@elysium/contracts';
import { seedAccountId, withSystem } from '@elysium/db';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ORG_A,
  startHttpHarness,
  type HttpHarness,
  type RoleClient,
} from '../../testing/http-harness.js';
import {
  CATALOG_ROUTE_FIXTURES,
  prepareCatalogFixtures,
} from '../../modules/catalog/catalog.route-fixtures.js';
import {
  INVENTORY_ROUTE_FIXTURES,
  prepareInventoryFixtures,
} from '../../modules/inventory/inventory.route-fixtures.js';
import {
  WALLETS_ROUTE_FIXTURES,
  prepareWalletsFixtures,
} from '../../modules/wallets/wallets.route-fixtures.js';
import {
  ORDERS_ROUTE_FIXTURES,
  prepareOrderFixtures,
} from '../../modules/orders/orders.route-fixtures.js';
import {
  FRAUD_ROUTE_FIXTURES,
  prepareFraudFixtures,
} from '../../modules/fraud/fraud.route-fixtures.js';
import {
  INVESTORS_ROUTE_FIXTURES,
  prepareInvestorFixtures,
} from '../../modules/investors/investors.route-fixtures.js';
import {
  COURIER_ROUTE_FIXTURES,
  prepareCourierFixtures,
} from '../../modules/courier/courier.route-fixtures.js';
import { HR_ROUTE_FIXTURES, prepareHrFixtures } from '../../modules/hr/hr.route-fixtures.js';
import { POS_ROUTE_FIXTURES, preparePosFixtures } from '../../modules/pos/pos.route-fixtures.js';
import {
  PROMO_ROUTE_FIXTURES,
  preparePromoFixtures,
} from '../../modules/promo/promo.route-fixtures.js';
import { NOTIFY_ROUTE_FIXTURES } from '../../modules/notify/notify.route-fixtures.js';
import {
  prepareSupplyFixtures,
  SUPPLY_ROUTE_FIXTURES,
} from '../../modules/supply/supply.route-fixtures.js';
import {
  INTAKE_ROUTE_FIXTURES,
  prepareIntakeFixtures,
} from '../../modules/intake/intake.route-fixtures.js';
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

  // Each module seeds the rows its own fixtures point at. They run after the
  // harness has migrated and seeded, and each one is idempotent, so the order
  // here does not matter and a second call is free.
  await prepareCatalogFixtures();
  await prepareInventoryFixtures();
  await prepareWalletsFixtures();
  await prepareSupplyFixtures();
  await prepareOrderFixtures();
  await prepareIntakeFixtures();
  await prepareFraudFixtures();
  await prepareInvestorFixtures();
  await prepareHrFixtures();
  await prepareCourierFixtures();
  await preparePosFixtures();
  await preparePromoFixtures();
  for (const role of MEMBERSHIP_ROLES) clients.set(role, await harness.asRole(role, ORG_A));
}, 300_000);

afterAll(async () => {
  await harness?.close();
}, 60_000);

const BANK = seedAccountId(ORG_A, '1100');
const OTHER_INCOME = seedAccountId(ORG_A, '4300');

let monthSeq = 0;
/** A distinct, long-past month per call: 2001-01, 2001-02, … */
function freshMonth(): string {
  const index = monthSeq;
  monthSeq += 1;
  return `${String(2001 + Math.floor(index / 12))}-${String((index % 12) + 1).padStart(2, '0')}`;
}

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
  'GET /v1/approvals/:id': async () => {
    // A request any checker of closing variances may view.
    const maker = await harness.asRole('org_admin', ORG_A);
    const created = await maker.client.request('POST', '/v1/approvals', {
      body: { type: 'closing_variance', amountPoisha: '900000' },
    });
    const { id } = JSON.parse(created.body) as { id: string };
    return { url: `/v1/approvals/${id}` };
  },
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
  // pg-boss installs its schema on worker boot, which no HTTP suite does, so
  // this answers with an empty list here. That is the behaviour under test in
  // `jobs.test.ts`; what the matrix needs from it is only who gets past the guard.
  'GET /v1/jobs/failed': () => ({ url: '/v1/jobs/failed' }),
  'GET /v1/ledger/accounts': () => ({ url: '/v1/ledger/accounts' }),
  'GET /v1/ledger/accounts/:id/ledger': () => ({
    url: `/v1/ledger/accounts/${BANK}/ledger?to=2030-12-31`,
  }),
  'GET /v1/ledger/day-book': () => ({ url: '/v1/ledger/day-book?from=2026-09-01&to=2026-09-30' }),
  'GET /v1/ledger/party-balances': () => ({ url: '/v1/ledger/party-balances?asOf=2030-12-31' }),
  'GET /v1/ledger/periods': () => ({ url: '/v1/ledger/periods' }),
  'GET /v1/ledger/trial-balance': () => ({ url: '/v1/ledger/trial-balance?asOf=2030-12-31' }),
  'GET /v1/ledger/wallets': () => ({ url: '/v1/ledger/wallets' }),
  'GET /v1/ledger/wallets/:id/cash-book': () => ({
    url: `/v1/ledger/wallets/${BANK}/cash-book?to=2030-12-31`,
  }),
  'POST /v1/ledger/cash-in': () => ({
    url: '/v1/ledger/cash-in',
    body: {
      entryId: randomUUID(),
      walletAccountId: BANK,
      incomeAccountId: OTHER_INCOME,
      amountPoisha: '1000',
    },
  }),
  // A month no other call has closed, so every admitted role succeeds.
  'POST /v1/ledger/periods/close': () => ({
    url: '/v1/ledger/periods/close',
    body: { month: freshMonth() },
  }),
  'POST /v1/ledger/periods/reopen': async () => {
    const month = freshMonth();
    await withSystem(
      async (tx) =>
        tx.execute(sql`
          insert into ledger.periods (org_id, starts_on, ends_on, status, closed_at, closed_by)
          values (${ORG_A}, ${`${month}-01`}, (${`${month}-01`}::date + interval '1 month' - interval '1 day')::date,
                  'closed', now(), 'usr_route_matrix')
        `),
      { orgId: ORG_A },
    );
    return { url: '/v1/ledger/periods/reopen', body: { month, reason: 'route matrix' } };
  },
  /*
   * §22's files. `product-image` is the one purpose every role that holds
   * `read FileObject` may also read — its rule is `read Catalog` — so the
   * matrix assertion here is about the FileObject grant itself rather than
   * about the per-purpose gate. That gate has its own suite, in
   * modules/files/files.e2e.test.ts, where a payslip is refused to a role
   * holding `read FileObject`.
   */
  'POST /v1/files': () => ({
    url: '/v1/files',
    body: {
      purpose: 'product-image',
      contentType: 'image/png',
      sizeBytes: 1024,
      originalName: 'sample.png',
    },
  }),
  'POST /v1/files/:id/finalize': async () => {
    // A row nobody has uploaded bytes for: finalize answers 404 for the roles
    // the guard admits, which is still an admission and is what this suite
    // measures. Creating it as org_admin keeps the actor under test out of it.
    const owner = await harness.asRole('org_admin', ORG_A);
    const created = await owner.client.request('POST', '/v1/files', {
      body: { purpose: 'product-image', contentType: 'image/png', sizeBytes: 1024 },
    });
    const { fileId } = JSON.parse(created.body) as { fileId: string };
    return { url: `/v1/files/${fileId}/finalize` };
  },
  'GET /v1/files/:id/download': async () => {
    const owner = await harness.asRole('org_admin', ORG_A);
    const created = await owner.client.request('POST', '/v1/files', {
      body: { purpose: 'product-image', contentType: 'image/png', sizeBytes: 1024 },
    });
    const { fileId } = JSON.parse(created.body) as { fileId: string };
    return { url: `/v1/files/${fileId}/download` };
  },
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
  // Each module owns its own fixtures: this file is shared by every milestone,
  // and a second write to it silently discards the first.
  ...CATALOG_ROUTE_FIXTURES,
  ...INVENTORY_ROUTE_FIXTURES,
  ...WALLETS_ROUTE_FIXTURES,
  ...SUPPLY_ROUTE_FIXTURES,
  ...ORDERS_ROUTE_FIXTURES,
  ...INTAKE_ROUTE_FIXTURES,
  ...FRAUD_ROUTE_FIXTURES,
  ...INVESTORS_ROUTE_FIXTURES,
  ...HR_ROUTE_FIXTURES,
  ...COURIER_ROUTE_FIXTURES,
  ...POS_ROUTE_FIXTURES,
  ...PROMO_ROUTE_FIXTURES,
  ...NOTIFY_ROUTE_FIXTURES,
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
                branchIdsByRole: { [role]: [] },
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
