import { randomBytes } from 'node:crypto';

import type { MembershipRole } from '@elysium/contracts';
import { createAuth, RecordingSmsProvider, SEED_ORG_IDS } from '@elysium/db';
import {
  createTestUser,
  grantMembership,
  startTestDatabase,
  type TestDatabase,
} from '@elysium/db/testing';

import { applyIntakeMigrations } from '../intake/intake.testing.js';
import { seedProductWithSkus, warehouseId } from '../inventory/inventory.testing.js';
import { seedStockLevel } from './orders.testing.js';

/**
 * The order desk's real-stack Playwright run: a throwaway database with throwaway users
 * (M11 acceptance checks 1 and 4).
 *
 * Test-only, and run as a process of its own — `node --env-file=apps/server/.env
 * apps/server/dist/modules/orders/desk-stack.provision.js create` — by the console's
 * Playwright `globalSetup`, which then points a real API, a real worker and the real console
 * at what this prints. Compiled with the server because it is built from the server's own
 * test fixtures, which Playwright's transform cannot load (Nest's decorators need
 * `emitDecoratorMetadata`).
 *
 * * **A database of its own**, created by `startTestDatabase` — the harness every server
 *   suite uses — on the local Postgres the dev stack runs, so the API and the worker can
 *   reach it. This process stays alive for the run and drops the database, through the
 *   harness's own `stop()`, when `globalTeardown` writes `stop` to its stdin (or closes
 *   it). A signal would be the obvious channel and is not one on Windows. The developer's
 *   own database is never touched.
 * * **Users through the same fixtures as `asRole`**: `createTestUser`, `grantMembership`,
 *   and a password set through Better Auth's own reset flow, so it is hashed by the library
 *   and never by code here. Two `sales` agents, no second factor (§6 walls org_admin,
 *   accounts and investor behind one).
 * * **Throwaway values only** (invariant 10): `@example.invalid` addresses, a random
 *   password that exists only in this process's stdout and the Playwright process that
 *   reads it, SKU codes made from a random run id.
 *
 * Refuses to run against anything but a local server, or with `NODE_ENV=production`: a
 * script that creates users and sets passwords must not be one mistyped variable away from
 * a brand's data.
 */

const LOCAL = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function adminUrl(): string {
  const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_ADMIN_URL ?? '';
  if (url === '') throw new Error('desk-stack: DATABASE_ADMIN_URL is not set (apps/server/.env).');
  if (process.env.NODE_ENV === 'production') {
    throw new Error('desk-stack: refusing to run with NODE_ENV=production.');
  }
  const host = new URL(url).hostname;
  if (!LOCAL.has(host)) throw new Error(`desk-stack: refusing to run against ${host}.`);
  return url;
}

async function create(): Promise<void> {
  // `startTestDatabase` creates its database on TEST_DATABASE_URL's server, or starts a
  // container that dies with this process — which would take the database away from the
  // API before the first request. The local server it is, then.
  process.env.TEST_DATABASE_URL = adminUrl();
  const database: TestDatabase = await startTestDatabase('deske2e');
  await applyIntakeMigrations();

  const orgId = SEED_ORG_IDS['elysium-lifestyle-bd'] ?? '';
  const run = randomBytes(4).toString('hex');
  const password = randomBytes(18).toString('base64url');

  const tokens = new Map<string, string>();
  const created = createAuth({
    baseUrl: process.env.E2E_API_URL ?? 'http://localhost:3110',
    secret: process.env.AUTH_SECRET ?? randomBytes(32).toString('hex'),
    trustedOrigins: [process.env.E2E_CONSOLE_URL ?? 'http://localhost:5183'],
    sms: new RecordingSmsProvider(),
    rateLimitEnabled: false,
    onPasswordToken: ({ email, token }) => {
      tokens.set(email, token);
      return Promise.resolve();
    },
  });
  const { auth } = created;

  const otherOrgId = SEED_ORG_IDS['oura-lifestyle'] ?? '';

  /*
   * Who the browser suites sign in as.
   *
   * `desk` and `queue` are the two sales sessions M11's checks need. The other two exist
   * for M05's navigation check: `accounts` is given the role and nothing else, so the
   * suite has to pass §6's two-factor enrolment through the real screen before it sees a
   * single page, and `switcher` holds a different role in each of two brands, which is
   * the only way "switching org changes the navigation" can be observed.
   */
  const people: readonly {
    label: string;
    grants: readonly { orgId: string; role: MembershipRole }[];
  }[] = [
    { label: 'desk', grants: [{ orgId, role: 'sales' }] },
    { label: 'queue', grants: [{ orgId, role: 'sales' }] },
    { label: 'accounts', grants: [{ orgId, role: 'accounts' }] },
    {
      label: 'switcher',
      grants: [
        { orgId, role: 'sales' },
        { orgId: otherOrgId, role: 'warehouse' },
      ],
    },
  ];

  const users: { role: string; email: string; userId: string }[] = [];
  for (const { label, grants } of people) {
    const email = `e2e.${label}.${run}@example.invalid`;
    const user = await createTestUser({ email, name: `E2E ${label} agent` });
    for (const grant of grants) {
      await grantMembership({ userId: user.id, orgId: grant.orgId, role: grant.role });
    }
    await auth.api.requestPasswordReset({ body: { email, redirectTo: '/accept-invite' } });
    const token = tokens.get(email);
    if (token === undefined) throw new Error(`desk-stack: no reset token for ${label}.`);
    await auth.api.resetPassword({ body: { newPassword: password, token } });
    users.push({ role: label, email, userId: user.id });
  }
  await created.close();

  const { skus } = await seedProductWithSkus(orgId, `e2e${run}`, 2);
  const location = await warehouseId(orgId);
  for (const sku of skus) {
    await seedStockLevel(orgId, {
      skuId: sku.id,
      locationId: location,
      qty: 50,
      unitCostPoisha: 40_000n,
    });
  }

  process.stdout.write(
    `${JSON.stringify({
      databaseName: database.databaseName,
      appUrl: database.appUrl,
      ownerUrl: database.ownerUrl,
      analyticsUrl: database.analyticsUrl,
      adminUrl: database.adminUrl,
      orgId,
      password,
      users,
      skuCodes: skus.map((sku) => sku.code),
    })}\n`,
  );

  // Hold the database open until the run is over, then drop it the harness's way.
  await new Promise<void>((resolve) => {
    let buffered = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      buffered += chunk;
      if (buffered.includes('stop')) resolve();
    });
    process.stdin.on('end', () => resolve());
  });
  await database.stop();
}

const [command] = process.argv.slice(2);
const work =
  command === 'create'
    ? create()
    : Promise.reject(new Error('usage: desk-stack.provision.js create'));

work.then(
  () => process.exit(0),
  (error: unknown) => {
    process.stderr.write(
      `desk-stack failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  },
);
