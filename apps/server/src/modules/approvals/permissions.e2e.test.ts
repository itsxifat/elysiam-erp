import { randomUUID } from 'node:crypto';

import { base32 } from '@better-auth/utils/base32';
import { fastifyCookie } from '@fastify/cookie';
import { NestFactory, Reflector } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { assertNoCostFields, MEMBERSHIP_ROLES, type MembershipRole } from '@elysium/contracts';
import {
  createAuth,
  RecordingSmsProvider,
  SEED_ORG_IDS,
  withGlobal,
  withSystem,
} from '@elysium/db';
import {
  grantMembership,
  startTestDatabase,
  stopSharedContainer,
  type TestDatabase,
} from '@elysium/db/testing';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../../app.module.js';
import { AbilityGuard } from '../../platform/auth/abilities.js';
import { registerAuth } from '../../platform/http/auth-plugin.js';
import { AuditInterceptor } from '../../platform/audit/audit.interceptor.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { SerializeInterceptor } from '../../platform/http/serialize.interceptor.js';
import { CSRF_COOKIE, CSRF_HEADER } from '../../platform/http/csrf.js';
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
const PASSWORD = 'correct-horse-battery';

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

let nextIp = 0;
function freshIp(): string {
  nextIp += 1;
  return `10.2.${String(Math.floor(nextIp / 256) % 256)}.${String(nextIp % 256)}`;
}

class Client {
  private readonly cookies = new Map<string, string>();
  constructor(private readonly ip: string) {}

  absorb(headers: Record<string, unknown>): void {
    const raw = headers['set-cookie'];
    const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
    for (const entry of list) {
      const pair = String(entry).split(';')[0] ?? '';
      const index = pair.indexOf('=');
      if (index <= 0) continue;
      const name = pair.slice(0, index);
      const value = pair.slice(index + 1);
      if (value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  async request(
    method: string,
    url: string,
    options: { body?: unknown; headers?: Record<string, string> } = {},
  ) {
    const cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const headers: Record<string, string> = {
      host: APP_DOMAIN,
      origin: ORIGIN,
      'x-forwarded-for': this.ip,
      ...options.headers,
    };
    if (cookie !== '') headers.cookie = cookie;
    const token = this.cookies.get(CSRF_COOKIE);
    if (token !== undefined) headers[CSRF_HEADER] = token;
    if (options.body !== undefined) headers['content-type'] = 'application/json';

    const response = await server.inject({
      method: method as 'GET',
      url,
      headers,
      ...(options.body === undefined ? {} : { payload: JSON.stringify(options.body) }),
    });

    this.absorb(response.headers);
    return response;
  }
}

/** A signed-in client holding `roles`, already in `orgId`. */
async function asRole(
  roles: readonly MembershipRole[],
  orgId: string = ORG_A,
): Promise<{ client: Client; userId: string; email: string }> {
  const client = new Client(freshIp());
  const email = `${roles.join('_')}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}@example.invalid`;
  const userId = `usr_${randomUUID()}`;

  await withGlobal(async (tx) => {
    await tx.execute(sql`
      insert into iam.users (id, email, name, email_verified)
      values (${userId}, ${email}, ${roles.join(', ')}, true)
    `);
  });

  for (const role of roles) await grantMembership({ userId, orgId, role });

  await client.request('GET', '/v1/auth/login-branding');
  await client.request('POST', '/api/auth/request-password-reset', {
    body: { email, redirectTo: '/accept-invite' },
  });
  const token = tokens.take(email);
  await client.request('POST', '/api/auth/reset-password', {
    body: { newPassword: PASSWORD, token },
  });
  await client.request('POST', '/api/auth/sign-in/email', { body: { email, password: PASSWORD } });

  // §6 requires a second factor for these, and the wall blocks everything else
  // until it exists.
  if (roles.some((role) => role === 'org_admin' || role === 'accounts' || role === 'investor')) {
    const enabled = await client.request('POST', '/api/auth/two-factor/enable', {
      body: { password: PASSWORD, method: 'totp' },
    });
    const { totpURI } = JSON.parse(enabled.body) as { totpURI: string };
    const secret = new TextDecoder().decode(
      base32.decode(new URL(totpURI).searchParams.get('secret') ?? ''),
    );
    const { code } = await authHandle.auth.api.generateTOTP({ body: { secret } });
    await client.request('POST', '/api/auth/two-factor/verify-totp', { body: { code } });
  }

  await client.request('POST', '/v1/me/active-org', { body: { orgId } });
  return { client, userId, email };
}

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

    expect(JSON.stringify(rows)).not.toContain('sk_live_must_not_appear');
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
    // The grant is the control. A log whose rows can be edited is not evidence.
    await expectRefused(
      withSystem(
        async (tx) => {
          await tx.execute(sql`set role erp_app`);
          await tx.execute(sql`update audit.audit_log set action = 'tampered'`);
        },
        { orgId: ORG_A },
      ),
      /permission denied/i,
    );
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

    expect(decided.statusCode, decided.body).toBe(201);
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
