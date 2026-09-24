import { randomUUID } from 'node:crypto';

import { SEED_ORG_IDS, withSystem } from '@elysium/db';
import { startTestDatabase, stopSharedContainer, type TestDatabase } from '@elysium/db/testing';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

import { describeRoutes } from './platform/auth/route-map.js';
import { createRoleFactory, TestClient } from './testing/as-role.js';
import type { buildApp } from './main.api.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The real bootstrap (architecture §6, §25, §26).
 *
 * Every other suite builds its own Nest application and mounts the guard and
 * the interceptors itself. That is right for testing *those* — but it means
 * nothing at all exercised `buildApp()`, and the consequences were not
 * theoretical:
 *
 * - a logger handed to Fastify under the wrong option name stopped the API
 *   booting, with `pnpm verify` green;
 * - a bad array binding made `GET /v1/approvals` a 500 for every caller, also
 *   with `pnpm verify` green.
 *
 * Both were found by hand against a running server. This suite is what makes
 * that unnecessary: it boots the actual composition root, so "the app starts"
 * and "production has the guard mounted" become assertions rather than
 * assumptions.
 */

const ORG_A = SEED_ORG_IDS['elysium-lifestyle-bd'] ?? '';
const APP_DOMAIN = 'erp.example.com';
const ORIGIN = `https://${APP_DOMAIN}`;

let database: TestDatabase;
let built: Awaited<ReturnType<typeof buildApp>>;
let server: FastifyInstance;

/*
 * Two clients, made once.
 *
 * This suite deliberately runs the real app, which means the real rate limiter
 * — and `server.inject` gives every request the same socket address, so a user
 * per test exhausts the per-IP allowance on `request-password-reset` and the
 * failures look like auth bugs. Sharing them also keeps the suite about the
 * wiring rather than about sign-up.
 */
let salesClient: TestClient;
let adminClient: TestClient;

beforeAll(async () => {
  database = await startTestDatabase('bootstrap');

  process.env.DATABASE_URL = database.appUrl;
  process.env.APP_DOMAIN = APP_DOMAIN;
  process.env.API_PUBLIC_URL = ORIGIN;
  process.env.AUTH_SECRET = 'test-secret-that-is-at-least-32-characters-long';
  process.env.TRUSTED_ORIGINS = ORIGIN;
  process.env.LOG_LEVEL = 'fatal';

  // Imported here, after the environment is set: `serverEnv()` parses once.
  const module = await import('./main.api.js');
  built = await module.buildApp();
  server = built.app.getHttpAdapter().getInstance();
  await server.ready();

  salesClient = (await asRole(['sales'], ORG_A)).client;
  adminClient = (await asRole(['org_admin'], ORG_A)).client;
}, 180_000);

afterAll(async () => {
  await built?.close();
  await database?.stop();
  await stopSharedContainer();
}, 60_000);

/**
 * Clients through the shared `asRole`, not a second copy of it.
 *
 * This file used to carry its own cookie jar and its own sign-in flow, which
 * had already drifted from the one in `permissions.e2e.test.ts` — the two
 * disagreed about how the 2FA enrolment wall is cleared. A boot test that
 * signs in differently from every other suite is testing a path production
 * does not have.
 */
/** A client that has never signed in. */
function anonymous(): TestClient {
  return new TestClient(
    { server: () => server, tokens: built.tokens, appDomain: APP_DOMAIN, origin: ORIGIN },
    '10.9.0.1',
  );
}

const asRole = createRoleFactory({
  server: () => server,
  tokens: { take: (email: string) => built.tokens.take(email) },
  appDomain: APP_DOMAIN,
  origin: ORIGIN,
});

describe('the application production runs actually starts', () => {
  it('boots', () => {
    // The whole point. A logger passed under the wrong option name threw
    // FST_ERR_LOG_INVALID_LOGGER_CONFIG here and nothing noticed.
    expect(server).toBeDefined();
  });

  it('serves its liveness probe', async () => {
    const response = await anonymous().request('GET', '/health/live');
    expect(response.statusCode, response.body).toBe(200);
  });

  it('has a real logger, not the no-op one that also answers to .error', () => {
    /*
     * `typeof log.error === 'function'` was the old assertion, and it passes
     * with the logger removed entirely: Fastify's abstract logger — what you
     * get from `logger: false` — exposes `.error` as a no-op precisely so
     * calling code need not check. So the test could not fail for the thing it
     * was named after, which matters because `AuditInterceptor` reports a
     * failed audit write through `request.log.error` and nothing else.
     *
     * `levels` is pino's own, and the abstract logger has no such property.
     */
    const logger = server.log as unknown as {
      error?: unknown;
      levels?: { values?: Record<string, number> };
    };

    expect(typeof logger.error).toBe('function');
    expect(logger.levels?.values, 'this is the no-op logger, not pino').toBeDefined();
  });
});

describe('the global wiring is mounted in production, not only in tests', () => {
  it('denies a signed-in caller whose role has no rule for the route', async () => {
    /*
     * A *signed-in* caller, and a role the matrix denies — because the
     * unauthenticated version of this test could not fail.
     *
     * With `useGlobalGuards` removed from `buildApp`, an anonymous request
     * still reaches `requireContext`, which throws 401, and the old assertion
     * (`>= 400`) held. The guard was the thing being tested and its absence
     * was invisible.
     *
     * `hr` has a session and an active org, so `requireContext` succeeds. The
     * matrix gives them no rule for `CostedItem`. Only the guard can produce
     * this 403; without it the handler runs and answers 200 with the items.
     */
    const { client } = await asRole(['hr'], ORG_A);
    const response = await client.request('GET', '/v1/demo/costed-items');

    expect(response.statusCode, response.body).toBe(403);
  });

  it('records a mutation nobody instrumented, which only the interceptor does', async () => {
    /*
     * The audit interceptor's own presence check, and it had none.
     *
     * `POST /v1/demo/costed-items` writes no audit entry of its own — it is
     * the kind of route that ships instrumented-later — so the row can only
     * come from the global interceptor. Remove it from `buildApp` and every
     * other suite still passes, because they mount their own.
     */
    const client = adminClient;
    const sku = `BOOT-AUDIT-${randomUUID().slice(0, 8)}`;

    const created = await client.request('POST', '/v1/demo/costed-items', {
      body: { sku, name: 'Boot audited' },
    });
    expect(created.statusCode, created.body).toBe(201);
    const { id } = JSON.parse(created.body) as { id: string };

    // The interceptor writes after the response, so poll rather than sleep.
    const deadline = Date.now() + 5_000;
    let rows: { action: string }[];
    for (;;) {
      rows = [
        ...(await withSystem(
          async (tx) =>
            tx.execute<{ action: string }>(
              sql`select action from audit.audit_log where entity_id = ${id}`,
            ),
          { orgId: ORG_A },
        )),
      ];
      if (rows.length > 0 || Date.now() > deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    expect(rows.length, 'the audit interceptor is not mounted in buildApp').toBeGreaterThan(0);
    expect(rows[0]?.action).toContain('POST');
  });

  it('leaves a @Public route reachable', async () => {
    // The positive control: the 403 above must be the guard, not the app being
    // broken.
    const response = await anonymous().request('GET', '/v1/auth/login-branding');
    expect(response.statusCode, response.body).toBe(200);
  });

  it('strips cost on the way out, through the interceptor production mounts', async () => {
    const client = salesClient;

    // `demo.costed_items` is a tenant table, so the insert needs an org context
    // — `withGlobal` clears it and RLS refuses the row.
    await withSystem(
      async (tx) => {
        await tx.execute(sql`
          insert into demo.costed_items (org_id, sku, name, unit_cost_poisha, sell_price_poisha)
          values (${ORG_A}, ${`BOOT-${randomUUID().slice(0, 8)}`}, 'Boot', 120000, 250000)
        `);
      },
      { orgId: ORG_A },
    );

    const response = await client.request('GET', '/v1/demo/costed-items');
    expect(response.statusCode, response.body).toBe(200);

    const body = JSON.parse(response.body) as { items: Record<string, unknown>[] };
    expect(body.items.length, 'nothing to check means nothing was proved').toBeGreaterThan(0);
    expect(body.items[0]).toHaveProperty('sellPricePoisha');
    expect(body.items[0]).not.toHaveProperty('unitCostPoisha');
  });
});

describe('every route the gate lists actually answers', () => {
  /*
   * The route-coverage gate reads metadata; it never calls a handler. A route
   * can be declared, pass the gate, and 500 on every request — which is
   * exactly what `GET /v1/approvals` did after its query was rewritten, with
   * `pnpm verify` green and `check-route-matrix` printing PASS.
   *
   * Naming three routes by hand only ever catches the three. This walks the
   * gate's own list, so a route added in a later milestone is covered the day
   * it is declared rather than the day someone remembers to add a case here.
   */
  it('answers every parameterless GET without a server error', async () => {
    const routes = describeRoutes(built.app).filter(
      (route) => route.method === 'GET' && !route.path.includes(':'),
    );

    expect(routes.length, 'the gate listed no GET routes at all').toBeGreaterThan(3);

    const broken: string[] = [];
    for (const route of routes) {
      // The org admin holds the widest ordinary role, so a 403 here means the
      // route is genuinely not theirs rather than that nobody could reach it.
      const response = await adminClient.request('GET', route.path);
      if (response.statusCode >= 500) {
        broken.push(
          `${route.path} -> ${String(response.statusCode)} ${response.body.slice(0, 200)}`,
        );
      }
    }

    expect(broken, broken.join('\n')).toEqual([]);
  });

  it('serves them as more than a blanket 403, so the sweep above means something', async () => {
    // The positive control. A guard that refused everything would make the
    // sweep pass while proving nothing ran.
    const routes = describeRoutes(built.app).filter(
      (route) => route.method === 'GET' && !route.path.includes(':'),
    );

    const answered: string[] = [];
    for (const route of routes) {
      const response = await adminClient.request('GET', route.path);
      if (response.statusCode < 300) answered.push(route.path);
    }

    expect(answered.length, 'every GET route refused; nothing was exercised').toBeGreaterThan(3);
  });

  it('GET /v1/approvals returns a page rather than a 500', async () => {
    const client = adminClient;

    const response = await client.request('GET', '/v1/approvals');
    expect(response.statusCode, response.body).toBe(200);

    // §23's shape: rows plus a cursor, not a bare array.
    const body = JSON.parse(response.body) as { rows?: unknown; nextCursor?: unknown };
    expect(Array.isArray(body.rows)).toBe(true);
    expect(body).toHaveProperty('nextCursor');
  });

  it('GET /v1/me answers once an org is chosen', async () => {
    const client = salesClient;
    const response = await client.request('GET', '/v1/me');
    expect(response.statusCode, response.body).toBe(200);
  });

  it('GET /v1/me/orgs answers', async () => {
    const client = salesClient;
    const response = await client.request('GET', '/v1/me/orgs');
    expect(response.statusCode, response.body).toBe(200);
  });
});
