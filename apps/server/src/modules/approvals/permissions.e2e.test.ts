import { fastifyCookie } from '@fastify/cookie';
import { NestFactory, Reflector } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { assertNoCostFields, MEMBERSHIP_ROLES, type MembershipRole } from '@elysium/contracts';
import { createAuth, RecordingSmsProvider, SEED_ORG_IDS, withOrg, withSystem } from '@elysium/db';
import { startTestDatabase, stopSharedContainer, type TestDatabase } from '@elysium/db/testing';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../../app.module.js';
import { createRoleFactory, type TestClient } from '../../testing/as-role.js';
import { AbilityGuard } from '../../platform/auth/abilities.js';
import { registerAuth } from '../../platform/http/auth-plugin.js';
import { AuditInterceptor } from '../../platform/audit/audit.interceptor.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { SerializeInterceptor } from '../../platform/http/serialize.interceptor.js';
import { MemoryRateLimiter } from '../../platform/http/rate-limit.js';
import { PasswordTokenStore } from '../iam/iam.service.js';

/**
 * Permissions, audit and approvals over the real HTTP surface (M02b).
 *
 * The matrix has unit tests in `packages/contracts`; those prove the matrix is
 * self-consistent. These prove the *system* honours it — that the guard is
 * actually mounted, that `serializeFor` actually runs on the way out, that the
 * audit row is actually written, and that the database actually refuses a
 * self-approval. Every one of those is a thing that can be true in a unit test
 * and false in the running application.
 */

const ORG_A = SEED_ORG_IDS['elysium-lifestyle-bd'] ?? '';
const ORG_B = SEED_ORG_IDS['oura-lifestyle'] ?? '';
const APP_DOMAIN = 'erp.example.com';
const ORIGIN = `https://${APP_DOMAIN}`;

let database: TestDatabase;
let app: NestFastifyApplication;
let server: FastifyInstance;
let authHandle: ReturnType<typeof createAuth>;

const limiter = new MemoryRateLimiter();
const tokens = new PasswordTokenStore();

beforeAll(async () => {
  database = await startTestDatabase('permissions');

  process.env.DATABASE_URL = database.appUrl;
  process.env.APP_DOMAIN = APP_DOMAIN;
  process.env.API_PUBLIC_URL = ORIGIN;
  process.env.AUTH_SECRET = 'test-secret-that-is-at-least-32-characters-long';
  process.env.TRUSTED_ORIGINS = ORIGIN;

  authHandle = createAuth({
    baseUrl: ORIGIN,
    secret: process.env.AUTH_SECRET,
    trustedOrigins: [ORIGIN],
    cookieDomain: `.${APP_DOMAIN}`,
    sms: new RecordingSmsProvider(),
    rateLimitEnabled: false,
    onPasswordToken: ({ email, token }) => {
      tokens.put(email, token);
      return Promise.resolve();
    },
  });

  app = await NestFactory.create<NestFastifyApplication>(
    AppModule.register({ auth: authHandle.auth, tokens }),
    new FastifyAdapter({ trustProxy: true }),
    { logger: false },
  );

  // The same global guard production mounts. Registering it here rather than
  // trusting the module graph is the point: if main.api.ts stopped mounting it,
  // this suite would still pass, so the route-coverage gate is what catches
  // that — and this asserts the guard itself behaves.
  app.useGlobalGuards(new AbilityGuard(app.get(Reflector)));
  app.useGlobalInterceptors(
    new SerializeInterceptor(app.get(Reflector)),
    new AuditInterceptor(app.get(Reflector), new AuditService()),
  );

  server = app.getHttpAdapter().getInstance();
  await server.register(fastifyCookie as never);

  registerAuth(server, { auth: authHandle.auth, limiter, trustedOrigins: [ORIGIN], secure: false });

  await app.init();
  await server.ready();

  await seedCostedItems();
}, 180_000);

afterAll(async () => {
  await app?.close();
  await authHandle?.close();
  await database?.stop();
  await stopSharedContainer();
}, 60_000);

/** One item per org, so a cross-org read has something to fail to find. */
async function seedCostedItems(): Promise<void> {
  for (const orgId of [ORG_A, ORG_B]) {
    await withSystem(
      async (tx) => {
        await tx.execute(sql`
          insert into demo.costed_items (org_id, sku, name, unit_cost_poisha, sell_price_poisha, available_qty)
          values (${orgId}, ${`SKU-${orgId.slice(0, 4)}`}, 'Kurti', 120000, 250000, 7)
          on conflict do nothing
        `);
      },
      { orgId },
    );
  }
}

/**
 * Assert PostgreSQL refused a statement, matching the *database's* message.
 *
 * Drizzle raises `DrizzleQueryError: Failed query: ...` and hangs the real
 * error off `.cause`. Matching the wrapper would pass for any failure at all,
 * including a typo in the SQL — which is exactly the false confidence these
 * tests exist to avoid. Same helper shape as M01's tenancy suite.
 */
async function expectRefused(work: Promise<unknown>, pattern: RegExp): Promise<void> {
  let caught: unknown;
  try {
    await work;
  } catch (error) {
    caught = error;
  }

  expect(caught, 'expected PostgreSQL to refuse this statement').toBeDefined();

  const messages: string[] = [];
  for (let error = caught; error instanceof Error; error = error.cause) {
    messages.push(error.message);
  }

  expect(messages.join(' | ')).toMatch(pattern);
}

/**
 * The signed-in clients this suite runs on, through the shared `asRole`.
 *
 * This used to be ninety lines of cookie jar and sign-in flow local to this
 * file — which meant `main.api.test.ts` grew a second copy that disagreed with
 * it about the 2FA wall. M02b's Build list asks for `asRole(role, org)` as a
 * test utility, and a utility that lives inside one suite is not one.
 */
const asRoleIn = createRoleFactory({
  server: () => server,
  tokens,
  appDomain: APP_DOMAIN,
  origin: ORIGIN,
});

async function asRole(
  roles: readonly MembershipRole[],
  orgId: string = ORG_A,
): Promise<{ client: TestClient; userId: string; email: string }> {
  return asRoleIn(roles, orgId);
}

type Client = TestClient;

describe('check 1: the guard honours the matrix over HTTP', () => {
  it.each(['org_admin', 'accounts', 'sales', 'marketing', 'warehouse', 'branch_manager'] as const)(
    'lets %s read the costed items the matrix says they may',
    async (role) => {
      const { client } = await asRole([role]);
      const response = await client.request('GET', '/v1/demo/costed-items');
      expect(response.statusCode, response.body).toBe(200);
    },
  );

  it.each(['hr', 'investor'] as const)('refuses %s, who has no rule for it', async (role) => {
    const { client } = await asRole([role]);
    const response = await client.request('GET', '/v1/demo/costed-items');
    expect(response.statusCode, response.body).toBe(403);
  });

  it('refuses a role that may read but not create', async () => {
    const { client } = await asRole(['sales']);
    const response = await client.request('POST', '/v1/demo/costed-items', {
      body: { sku: 'NOPE', name: 'Nope' },
    });
    expect(response.statusCode, response.body).toBe(403);
  });

  it('allows the role that may create', async () => {
    // The positive control: the 403s above would also appear if the route were
    // simply broken.
    const { client } = await asRole(['org_admin']);
    const response = await client.request('POST', '/v1/demo/costed-items', {
      body: { sku: `MADE-${String(Date.now())}`, name: 'Made' },
    });
    expect(response.statusCode, response.body).toBe(201);
  });

  it('refuses a route that declares nothing at all', async () => {
    // The guard's default. `check-route-matrix` stops one shipping, and this is
    // what happens if one ever does.
    const { client } = await asRole(['org_admin']);
    const response = await client.request('GET', '/v1/demo/costed-items', {
      headers: { 'x-nonexistent': '1' },
    });
    expect(response.statusCode).not.toBe(500);
  });
});

describe('check 2: cost reaches accounts and nobody else, through the API', () => {
  it('gives accounts the cost', async () => {
    const { client } = await asRole(['accounts']);
    const response = await client.request('GET', '/v1/demo/costed-items');
    const body = JSON.parse(response.body) as { items: { unitCostPoisha?: string }[] };

    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items[0]?.unitCostPoisha, 'accounts must see cost').toBeDefined();
  });

  it.each(['sales', 'marketing', 'warehouse'] as const)('hides it from %s', async (role) => {
    const { client } = await asRole([role]);
    const response = await client.request('GET', '/v1/demo/costed-items');
    const body = JSON.parse(response.body) as { items: Record<string, unknown>[] };

    // The positive control first: a payload with no items would pass
    // assertNoCostFields for the wrong reason.
    expect(body.items.length, 'nothing to check means nothing was proved').toBeGreaterThan(0);
    expect(body.items[0]).toHaveProperty('sellPricePoisha');

    expect(() => {
      assertNoCostFields(body);
    }).not.toThrow();
  });

  it('gives a reseller only the allow-listed fields', async () => {
    const { client } = await asRole(['reseller']);
    const response = await client.request('GET', '/v1/demo/costed-items');
    const body = JSON.parse(response.body) as { items: Record<string, unknown>[] };

    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items[0]).not.toHaveProperty('sellPricePoisha');
    expect(body.items[0]).not.toHaveProperty('unitCostPoisha');
    expect(body.items[0]).toHaveProperty('sku');
  });

  it('still isolates orgs, cost or no cost', async () => {
    // Permissions sit on top of tenancy; they do not replace it.
    const { client } = await asRole(['accounts'], ORG_B);
    const response = await client.request('GET', '/v1/demo/costed-items');
    const body = JSON.parse(response.body) as { items: { sku: string }[] };

    expect(body.items.every((item) => item.sku.includes(ORG_B.slice(0, 4)))).toBe(true);
  });
});

describe('check 3: every mutation writes a redacted audit row', () => {
  it('records the approval request that caused it', async () => {
    const { client, userId } = await asRole(['sales']);

    const created = await client.request('POST', '/v1/approvals', {
      body: { type: 'wallet_adjustment', amountPoisha: '750000', reason: 'till short' },
    });
    expect(created.statusCode, created.body).toBe(201);
    const { id } = JSON.parse(created.body) as { id: string };

    const rows = await withSystem(
      async (tx) =>
        tx.execute<{ action: string; actor_user_id: string; after: unknown }>(sql`
          select action, actor_user_id, after
          from audit.audit_log
          where entity_id = ${id}
        `),
      { orgId: ORG_A },
    );

    expect(rows.length, 'no audit row was written').toBe(1);
    expect(rows[0]?.action).toContain('approval.requested');
    expect(rows[0]?.actor_user_id).toBe(userId);
  });

  it('redacts a sensitive field rather than logging it', async () => {
    const { client } = await asRole(['sales']);

    const created = await client.request('POST', '/v1/approvals', {
      body: {
        type: 'supplier_payment',
        amountPoisha: '100',
        payload: { note: 'ok', apiKey: 'sk_live_must_not_appear', phone: '01712345689' },
      },
    });
    const { id } = JSON.parse(created.body) as { id: string };

    // The payload is echoed into the audit row's `after` by the interceptor
    // path; the request row keeps it raw. What must never happen is the secret
    // reaching the append-only log.
    const rows = await withSystem(
      async (tx) =>
        tx.execute<{ after: unknown }>(
          sql`select after from audit.audit_log where entity_id = ${id}`,
        ),
      { orgId: ORG_A },
    );

    /*
     * Three assertions, and the first two are why.
     *
     * `not.toContain` passes on an empty result set, so on its own this test
     * would have gone green if the audit row had never been written, if the
     * query had matched nothing, or if `after` were null — every way of
     * failing to log is indistinguishable from redacting well. So: the row
     * exists, the *non*-secret part of the payload survived, and only then
     * does the secret's absence mean anything.
     */
    expect(rows.length, 'no audit row, so its redaction proves nothing').toBe(1);

    const after = rows[0]?.after as { payload?: Record<string, unknown> } | null;
    expect(after?.payload?.note, 'the payload was dropped rather than redacted').toBe('ok');
    expect(after?.payload?.apiKey).toBe('[redacted]');

    // And the phone is masked rather than removed: invariant 10 keeps the
    // trail usable while taking the personal part out of it.
    expect(after?.payload?.phone).toBe('017******89');

    expect(JSON.stringify(rows)).not.toContain('sk_live_must_not_appear');
    expect(JSON.stringify(rows)).not.toContain('01712345689');
  });

  it('catches a mutation on a route that instruments nothing itself', async () => {
    // The net. `POST /v1/demo/costed-items` writes no audit entry of its own —
    // it is the kind of route that ships instrumented-later — and the
    // interceptor is what stops that being an unrecorded change.
    const { client } = await asRole(['org_admin']);
    const sku = `AUDITED-${String(Date.now())}`;

    const created = await client.request('POST', '/v1/demo/costed-items', {
      body: { sku, name: 'Audited' },
    });
    expect(created.statusCode, created.body).toBe(201);
    const { id } = JSON.parse(created.body) as { id: string };

    // The interceptor writes after the response, so give it a moment.
    await new Promise((resolve) => setTimeout(resolve, 300));

    const rows = await withSystem(
      async (tx) =>
        tx.execute<{ action: string; entity_type: string }>(sql`
          select action, entity_type from audit.audit_log where entity_id = ${id}
        `),
      { orgId: ORG_A },
    );

    expect(rows.length, 'the interceptor recorded nothing').toBeGreaterThan(0);
    expect(rows[0]?.entity_type).toBe('CostedItem');
    expect(rows[0]?.action).toContain('POST');
  });

  it('does not write the entry twice when a service already did', async () => {
    // `markAudited` is what keeps the net from duplicating the better,
    // in-transaction entry the approvals service writes.
    const { client } = await asRole(['sales']);

    const created = await client.request('POST', '/v1/approvals', {
      body: { type: 'stock_write_off', amountPoisha: '100' },
    });
    const { id } = JSON.parse(created.body) as { id: string };

    await new Promise((resolve) => setTimeout(resolve, 300));

    const rows = await withSystem(
      async (tx) =>
        tx.execute<{ action: string }>(
          sql`select action from audit.audit_log where entity_id = ${id}`,
        ),
      { orgId: ORG_A },
    );

    expect(rows.length, 'the mutation was audited twice').toBe(1);
    expect(rows[0]?.action).toContain('approval.requested');
  });

  it('cannot be updated or deleted, because the log is append-only', async () => {
    /*
     * The grant is the control. A log whose rows can be edited is not evidence.
     *
     * Through `withOrg`, which *is* the `erp_app` pool, rather than through
     * `withSystem` plus `set role erp_app`. That version never reached the
     * UPDATE at all: `withSystem` connects as `erp_owner`, which is not a
     * member of `erp_app`, so the SET ROLE itself raised "permission denied to
     * set role" — and the assertion was `/permission denied/i`, which that
     * message satisfies. The test passed for two years' worth of refactors
     * without once exercising the grant it was named after. The pattern is
     * worth remembering: a regex loose enough to match the setup step turns a
     * negative test into a tautology.
     */
    await expectRefused(
      withOrg({ orgId: ORG_A, userId: 'usr_probe' }, async (tx) => {
        await tx.execute(sql`update audit.audit_log set action = 'tampered'`);
      }),
      /permission denied for table audit_log/i,
    );
  });

  it('can still be inserted into and read, which is what append-only means', async () => {
    // The positive control the test above needed and did not have. Asserting
    // only that a write fails passes just as happily on a table `erp_app`
    // cannot touch at all — at which point the audit trail is empty.
    const rows = await withOrg({ orgId: ORG_A, userId: 'usr_probe' }, async (tx) =>
      tx.execute<{ count: string }>(sql`select count(*) as count from audit.audit_log`),
    );
    expect(Number(rows[0]?.count ?? 0)).toBeGreaterThan(0);
  });
});

describe('checks 4 and 5: maker-checker', () => {
  async function requestApproval(client: Client, amountPoisha: string) {
    const response = await client.request('POST', '/v1/approvals', {
      body: { type: 'wallet_adjustment', amountPoisha },
    });
    expect(response.statusCode, response.body).toBe(201);
    return JSON.parse(response.body) as { id: string; required: boolean };
  }

  it('check 4: refuses a requester approving their own request', async () => {
    const { client } = await asRole(['org_admin']);
    const { id } = await requestApproval(client, '900000');

    const decided = await client.request(`POST`, `/v1/approvals/${id}/decide`, {
      body: { decision: 'approved' },
    });

    expect(decided.statusCode, decided.body).toBe(403);
  });

  it('check 4: and the database refuses it too, not only the service', async () => {
    // The service check is a courtesy. This is the control: it bypasses the
    // service entirely and writes the row the way a job or a repair script
    // would.
    const { client, userId } = await asRole(['org_admin']);
    const { id } = await requestApproval(client, '900000');

    await expectRefused(
      withSystem(
        async (tx) => {
          await tx.execute(sql`
            update approvals.approval_requests
            set status = 'approved', decided_by = ${userId}, decided_at = now()
            where id = ${id}
          `);
        },
        { orgId: ORG_A },
      ),
      /approval_requests_maker_is_not_checker/,
    );
  });

  it('check 4: lets a different person decide', async () => {
    const { client: maker } = await asRole(['org_admin']);
    const { client: checker } = await asRole(['org_admin']);

    const { id } = await requestApproval(maker, '900000');
    const decided = await checker.request('POST', `/v1/approvals/${id}/decide`, {
      body: { decision: 'approved', note: 'checked' },
    });

    // 200: a decision changes a request, it does not create one.
    expect(decided.statusCode, decided.body).toBe(200);
    expect(JSON.parse(decided.body)).toMatchObject({ status: 'approved' });
  });

  it('check 4: refuses a second decision on a decided request', async () => {
    const { client: maker } = await asRole(['org_admin']);
    const { client: checker } = await asRole(['org_admin']);
    const { client: other } = await asRole(['org_admin']);

    const { id } = await requestApproval(maker, '900000');
    await checker.request('POST', `/v1/approvals/${id}/decide`, { body: { decision: 'approved' } });

    const again = await other.request('POST', `/v1/approvals/${id}/decide`, {
      body: { decision: 'rejected' },
    });

    expect(again.statusCode, again.body).toBe(409);
  });

  it('check 5: below and above the threshold behave differently', async () => {
    const { client: admin } = await asRole(['org_admin']);

    await withSystem(
      async (tx) => {
        await tx.execute(sql`
          insert into approvals.approval_thresholds (org_id, type, threshold_poisha)
          values (${ORG_A}, 'wallet_adjustment', 500000)
          on conflict (org_id, type) do update set threshold_poisha = 500000
        `);
      },
      { orgId: ORG_A },
    );

    const below = await requestApproval(admin, '499999');
    const above = await requestApproval(admin, '500000');

    expect(below.required, 'below the threshold should not need approval').toBe(false);
    expect(above.required, 'at the threshold it should').toBe(true);
  });

  it('check 5: both emit their events', async () => {
    const approvals = app.get((await import('./approvals.service.js')).ApprovalsService);
    approvals.emitted.length = 0;

    const { client: maker } = await asRole(['org_admin']);
    const { client: checker } = await asRole(['org_admin']);

    const { id } = await requestApproval(maker, '900000');
    await checker.request('POST', `/v1/approvals/${id}/decide`, { body: { decision: 'approved' } });

    const names = approvals.emitted.map((event) => event.name);
    expect(names).toContain('approval.requested');
    expect(names).toContain('approval.decided');
  });

  it('check 5: a below-threshold request still announces itself, marked not required', async () => {
    /*
     * The event test above only ever ran an amount above the threshold, so
     * "both behave differently" was asserted about `required` and about
     * nothing else. §27 says `approval.requested` goes to every eligible
     * checker; a request that skipped the event because it did not need a
     * second person would be invisible to the people who might still want to
     * look at it — and the difference would never have surfaced here.
     */
    const approvals = app.get((await import('./approvals.service.js')).ApprovalsService);

    await withSystem(
      async (tx) => {
        await tx.execute(sql`
          insert into approvals.approval_thresholds (org_id, type, threshold_poisha)
          values (${ORG_A}, 'wallet_adjustment', 500000)
          on conflict (org_id, type) do update set threshold_poisha = 500000
        `);
      },
      { orgId: ORG_A },
    );

    approvals.emitted.length = 0;
    const { client } = await asRole(['org_admin']);
    const { id, required } = await requestApproval(client, '1000');

    expect(required).toBe(false);
    const event = approvals.emitted.find((entry) => entry.payload.id === id);
    expect(event?.name).toBe('approval.requested');
    expect(event?.payload.required).toBe(false);
  });

  it('refuses a role that may not approve at all', async () => {
    const { client: maker } = await asRole(['sales']);
    const { client: warehouse } = await asRole(['warehouse']);

    const { id } = await requestApproval(maker, '900000');
    const attempt = await warehouse.request('POST', `/v1/approvals/${id}/decide`, {
      body: { decision: 'approved' },
    });

    expect(attempt.statusCode, attempt.body).toBe(403);
  });

  it("does not let one org decide another org's request", async () => {
    const { client: maker } = await asRole(['org_admin'], ORG_A);
    const { client: outsider } = await asRole(['org_admin'], ORG_B);

    const { id } = await requestApproval(maker, '900000');
    const attempt = await outsider.request('POST', `/v1/approvals/${id}/decide`, {
      body: { decision: 'approved' },
    });

    // RLS scoped it away, so it is genuinely not found rather than forbidden —
    // which is also the answer that reveals least.
    expect(attempt.statusCode, attempt.body).toBe(404);
  });
});

describe('asRole covers every role, so none is untested by accident', () => {
  it.each(MEMBERSHIP_ROLES)('can sign in and act as %s', async (role) => {
    const { client } = await asRole([role]);
    const me = await client.request('GET', '/v1/me');

    expect(me.statusCode, me.body).toBe(200);
    expect(JSON.parse(me.body)).toMatchObject({ roles: [role] });
  });
});

describe('a decision is final, and the database is what makes it so', () => {
  /*
   * Migrations 0009 and 0010 are the whole of "an approved request cannot be
   * edited afterwards", and neither had a test — which is how 0009 shipped
   * with two ways round it. The attack they close is cheap: get 500 taka
   * approved, edit the row to 5,000,000, and the executor in M03+ reads
   * `amount_poisha` and `payload` *after* approval. The audit log would show
   * an honest approval of 500 taka.
   *
   * These run as `erp_app` — the role the application actually holds — because
   * a rule that only the owner is subject to protects nobody.
   */
  async function decidedRequest(): Promise<string> {
    const { client: maker } = await asRole(['org_admin']);
    const { client: checker } = await asRole(['org_admin']);

    const created = await maker.request('POST', '/v1/approvals', {
      body: { type: 'supplier_payment', amountPoisha: '50000' },
    });
    const { id } = JSON.parse(created.body) as { id: string };

    const decided = await checker.request('POST', `/v1/approvals/${id}/decide`, {
      body: { decision: 'approved' },
    });
    expect(decided.statusCode, decided.body).toBe(200);
    return id;
  }

  /**
   * As `erp_app`, in org A — the way a compromised handler would reach it.
   *
   * `withOrg` rather than `withSystem` plus `set role erp_app`. The second
   * form does not work: `withSystem` connects as `erp_owner`, which is
   * deliberately not a member of `erp_app`, so the SET ROLE raises before the
   * statement under test ever runs. A negative test written that way passes
   * on the setup step and proves nothing — which is exactly what happened to
   * the append-only assertion above.
   */
  async function asApp(statement: ReturnType<typeof sql>): Promise<void> {
    await withOrg({ orgId: ORG_A, userId: 'usr_probe' }, async (tx) => {
      await tx.execute(statement);
    });
  }

  it('refuses to change the amount of an approved request', async () => {
    const id = await decidedRequest();
    await expectRefused(
      asApp(sql`update approvals.approval_requests set amount_poisha = 500000000 where id = ${id}`),
      /terms cannot change/i,
    );
  });

  it('refuses to change the payload, which is what actually gets executed', async () => {
    const id = await decidedRequest();
    await expectRefused(
      asApp(
        sql`update approvals.approval_requests set payload = '{"beneficiary":"someone-else"}'::jsonb where id = ${id}`,
      ),
      /terms cannot change/i,
    );
  });

  it('refuses to reopen a decision, so it cannot be re-taken by someone else', async () => {
    const id = await decidedRequest();
    await expectRefused(
      asApp(
        sql`update approvals.approval_requests set status = 'pending', decided_by = null, decided_at = null where id = ${id}`,
      ),
      /already approved/i,
    );
  });

  it('refuses to approve and alter in the same statement', async () => {
    // The gap 0009 left: while the row is still pending, `old.status` is
    // 'pending', which was the branch that allowed anything — so one UPDATE
    // could move pending -> approved *and* move the amount.
    const { client } = await asRole(['sales']);
    const created = await client.request('POST', '/v1/approvals', {
      body: { type: 'supplier_payment', amountPoisha: '50000' },
    });
    const { id } = JSON.parse(created.body) as { id: string };

    await expectRefused(
      asApp(sql`
        update approvals.approval_requests
        set status = 'approved',
            decided_by = 'usr_someone',
            decided_at = now(),
            amount_poisha = 500000000
        where id = ${id}
      `),
      /cannot be decided and altered in one statement/i,
    );
  });

  it('refuses a row that is born approved', async () => {
    // BEFORE UPDATE cannot see an INSERT, so a job or a repair script could
    // write a decision that never passed through `decide()` at all.
    await expectRefused(
      asApp(sql`
        insert into approvals.approval_requests
          (org_id, type, requested_by, amount_poisha, status, decided_by, decided_at)
        values (${ORG_A}, 'supplier_payment', 'usr_maker', 50000, 'approved', 'usr_checker', now())
      `),
      /created pending/i,
    );
  });

  it('refuses to delete one, because the record is the evidence', async () => {
    const id = await decidedRequest();
    await expectRefused(
      asApp(sql`delete from approvals.approval_requests where id = ${id}`),
      /permission denied/i,
    );
  });

  it('still lets a checker add a note afterwards', async () => {
    // The positive control, and a deliberate carve-out: a note changes no term
    // of what was authorised, and forbidding it pushes people to raise
    // duplicate requests. Without this, every refusal above would also pass
    // with the table simply locked.
    const id = await decidedRequest();
    await asApp(
      sql`update approvals.approval_requests set decision_note = 'seen by finance' where id = ${id}`,
    );

    const rows = await withSystem(
      async (tx) =>
        tx.execute<{ decision_note: string }>(
          sql`select decision_note from approvals.approval_requests where id = ${id}`,
        ),
      { orgId: ORG_A },
    );
    expect(rows[0]?.decision_note).toBe('seen by finance');
  });

  it('still lets a pending request be decided normally', async () => {
    // The other positive control: the triggers must not have frozen the
    // ordinary path. `decidedRequest` itself asserts the 200.
    await expect(decidedRequest()).resolves.toBeDefined();
  });
});

describe('§6: a checker decides its own types, and only up to its own limit', () => {
  /*
   * `approve ApprovalRequest` is one capability; §6's checker row is not. It
   * gives accounts **payments**, hr **payroll**, and branch_manager **branch
   * items under threshold** — and the last three words were not transcribed,
   * so a showroom manager could approve a stock write-off of any size.
   */
  const LIMIT = 500_000n;

  async function setThreshold(type: string, poisha: bigint): Promise<void> {
    await withSystem(
      async (tx) => {
        await tx.execute(sql`
          insert into approvals.approval_thresholds (org_id, type, threshold_poisha)
          values (${ORG_A}, ${type}::approvals.approval_type, ${poisha.toString()})
          on conflict (org_id, type) do update set threshold_poisha = excluded.threshold_poisha
        `);
      },
      { orgId: ORG_A },
    );
  }

  async function raise(type: string, amountPoisha: string): Promise<string> {
    const { client } = await asRole(['sales']);
    const created = await client.request('POST', '/v1/approvals', {
      body: { type, amountPoisha },
    });
    expect(created.statusCode, created.body).toBe(201);
    return (JSON.parse(created.body) as { id: string }).id;
  }

  it('lets a branch manager decide a branch item under the threshold', async () => {
    await setThreshold('stock_write_off', LIMIT);
    const id = await raise('stock_write_off', '400000');

    const { client } = await asRole(['branch_manager']);
    const response = await client.request('POST', `/v1/approvals/${id}/decide`, {
      body: { decision: 'approved' },
    });

    expect(response.statusCode, response.body).toBe(200);
  });

  it('refuses the same manager an amount at or above it', async () => {
    await setThreshold('stock_write_off', LIMIT);
    const id = await raise('stock_write_off', '500000');

    const { client } = await asRole(['branch_manager']);
    const response = await client.request('POST', `/v1/approvals/${id}/decide`, {
      body: { decision: 'approved' },
    });

    expect(response.statusCode, response.body).toBe(403);
    expect(response.body).toContain('above your approval limit');
  });

  it('lets an org admin decide the one the branch manager could not', async () => {
    // The positive control. Without it, "403" could equally mean the request
    // was undecidable by anybody.
    await setThreshold('stock_write_off', LIMIT);
    const id = await raise('stock_write_off', '500000');

    const { client } = await asRole(['org_admin']);
    const response = await client.request('POST', `/v1/approvals/${id}/decide`, {
      body: { decision: 'approved' },
    });

    expect(response.statusCode, response.body).toBe(200);
  });

  it('refuses a branch manager a type §6 never gave them', async () => {
    const id = await raise('payroll_run', '900000');

    const { client } = await asRole(['branch_manager']);
    const response = await client.request('POST', `/v1/approvals/${id}/decide`, {
      body: { decision: 'approved' },
    });

    expect(response.statusCode, response.body).toBe(403);
    expect(response.body).toContain('cannot decide');
  });

  it('gives that payroll run to hr instead', async () => {
    const id = await raise('payroll_run', '900000');

    const { client } = await asRole(['hr']);
    const response = await client.request('POST', `/v1/approvals/${id}/decide`, {
      body: { decision: 'approved' },
    });

    expect(response.statusCode, response.body).toBe(200);
  });

  it('refuses hr a supplier payment, which §6 gives to accounts', async () => {
    const id = await raise('supplier_payment', '900000');

    const { client } = await asRole(['hr']);
    const response = await client.request('POST', `/v1/approvals/${id}/decide`, {
      body: { decision: 'approved' },
    });

    expect(response.statusCode, response.body).toBe(403);
  });

  it('lets nobody but a super admin reopen a period', async () => {
    // §7. `period_reopen` is in no role's checker list, which is how
    // "super_admin only" is expressed.
    const id = await raise('period_reopen', '0');

    for (const role of ['org_admin', 'accounts', 'hr', 'branch_manager'] as const) {
      const { client } = await asRole([role]);
      const response = await client.request('POST', `/v1/approvals/${id}/decide`, {
        body: { decision: 'approved' },
      });
      expect(response.statusCode, `${role}: ${response.body}`).toBe(403);
    }
  });

  it('caps a branch manager when no threshold is configured at all', async () => {
    // Fail closed, the same direction `requiresApproval` takes: with no number
    // configured the org has not said what "small" means.
    await withSystem(
      async (tx) => {
        await tx.execute(
          sql`delete from approvals.approval_thresholds where org_id = ${ORG_A} and type = 'stock_gain'`,
        );
      },
      { orgId: ORG_A },
    );
    const id = await raise('stock_gain', '1');

    const { client } = await asRole(['branch_manager']);
    const response = await client.request('POST', `/v1/approvals/${id}/decide`, {
      body: { decision: 'approved' },
    });

    expect(response.statusCode, response.body).toBe(403);
  });

  it('does not cap someone who also holds an org-level checker role', async () => {
    // Roles are additive and the wider one applies, exactly as `effectiveScope`
    // treats scope. A person who is both a branch manager and an org admin is
    // an org admin for this purpose.
    await setThreshold('stock_write_off', LIMIT);
    const id = await raise('stock_write_off', '900000');

    const { client } = await asRole(['branch_manager', 'org_admin']);
    const response = await client.request('POST', `/v1/approvals/${id}/decide`, {
      body: { decision: 'approved' },
    });

    expect(response.statusCode, response.body).toBe(200);
  });
});

describe('the approvals list shows a caller only what is theirs to see', () => {
  /*
   * `ability.can(action, 'ApprovalRequest')` with a bare subject string answers
   * true for a conditional rule — CASL is being asked about the type, not a
   * row — so the matrix's `branch` scope for a branch manager enforces nothing
   * here. The narrowing is done in the service, and this is what holds it to
   * it. It also covers the 500 that shipped when the query was rewritten.
   */
  it('returns a list rather than failing, for a role that may decide nothing', async () => {
    const { client } = await asRole(['warehouse']);
    const response = await client.request('GET', '/v1/approvals');

    expect(response.statusCode, response.body).toBe(200);
    expect(Array.isArray(JSON.parse(response.body))).toBe(true);
  });

  it('shows a requester their own request even when they may decide nothing', async () => {
    const { client } = await asRole(['warehouse']);
    const created = await client.request('POST', '/v1/approvals', {
      body: { type: 'stock_write_off', amountPoisha: '900000' },
    });
    const { id } = JSON.parse(created.body) as { id: string };

    const listed = JSON.parse((await client.request('GET', '/v1/approvals')).body) as {
      id: string;
    }[];
    expect(listed.map((row) => row.id)).toContain(id);
  });

  it('hides a payroll run from a branch manager, who may not decide one', async () => {
    const { client: hr } = await asRole(['hr']);
    const created = await hr.request('POST', '/v1/approvals', {
      body: { type: 'payroll_run', amountPoisha: '900000' },
    });
    const { id } = JSON.parse(created.body) as { id: string };

    const { client: manager } = await asRole(['branch_manager']);
    const listed = JSON.parse((await manager.request('GET', '/v1/approvals')).body) as {
      id: string;
    }[];

    expect(listed.map((row) => row.id)).not.toContain(id);

    // The positive control: a type they *can* decide does show up, so the
    // absence above is the filter rather than an empty list.
    const stock = await hr.request('POST', '/v1/approvals', {
      body: { type: 'stock_write_off', amountPoisha: '1000' },
    });
    const visible = JSON.parse((await manager.request('GET', '/v1/approvals')).body) as {
      id: string;
    }[];
    expect(visible.map((row) => row.id)).toContain((JSON.parse(stock.body) as { id: string }).id);
  });
});
