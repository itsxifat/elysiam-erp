import { randomUUID } from 'node:crypto';

import { SEED_ORG_IDS, withGlobal, withSystem } from '@elysium/db';
import {
  grantMembership,
  startTestDatabase,
  stopSharedContainer,
  type TestDatabase,
} from '@elysium/db/testing';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

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
let salesClient: Client;
let adminClient: Client;

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

  salesClient = (await signedIn('sales')).client;
  adminClient = (await signedIn('org_admin', { clearWall: true })).client;
}, 180_000);

afterAll(async () => {
  await built?.close();
  await database?.stop();
  await stopSharedContainer();
}, 60_000);

/** Everything a browser carries, against the real app. */
class Client {
  private readonly cookies = new Map<string, string>();

  private absorb(headers: Record<string, unknown>): void {
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

  async request(method: string, url: string, body?: unknown) {
    const cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const headers: Record<string, string> = { host: APP_DOMAIN, origin: ORIGIN };
    if (cookie !== '') headers.cookie = cookie;

    const token = this.cookies.get('elysium_csrf');
    if (token !== undefined) headers['x-elysium-csrf'] = token;
    if (body !== undefined) headers['content-type'] = 'application/json';

    const response = await server.inject({
      method: method as 'GET',
      url,
      headers,
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });

    this.absorb(response.headers);
    return response;
  }
}

describe('the application production runs actually starts', () => {
  it('boots', () => {
    // The whole point. A logger passed under the wrong option name threw
    // FST_ERR_LOG_INVALID_LOGGER_CONFIG here and nothing noticed.
    expect(server).toBeDefined();
  });

  it('serves its liveness probe', async () => {
    const response = await new Client().request('GET', '/health/live');
    expect(response.statusCode, response.body).toBe(200);
  });

  it('has a working request logger, so the audit failure path is not silent', () => {
    // `request.log.error` being a no-op is what made "a silently missing audit
    // trail is the worst of both worlds" untrue in the code that said it.
    const logger = (server as unknown as { log?: { error?: unknown } }).log;
    expect(typeof logger?.error).toBe('function');
  });
});

describe('the global wiring is mounted in production, not only in tests', () => {
  it('denies an unauthenticated caller on a guarded route', async () => {
    // If `useGlobalGuards` were removed from buildApp, this would be a 200 and
    // every other suite would still pass, because they mount the guard
    // themselves.
    const response = await new Client().request('GET', '/v1/demo/costed-items');
    expect(response.statusCode, response.body).toBeGreaterThanOrEqual(400);
  });

  it('leaves a @Public route reachable', async () => {
    // The positive control: the 4xx above must be the guard, not the app being
    // broken.
    const response = await new Client().request('GET', '/v1/auth/login-branding');
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
  // The route-coverage gate reads metadata; it never calls a handler. A route
  // can be declared, pass the gate, and 500 on every request — which is exactly
  // what `GET /v1/approvals` did after its query was rewritten.
  it('GET /v1/approvals returns a list rather than a 500', async () => {
    const client = adminClient;

    const response = await client.request('GET', '/v1/approvals');
    expect(response.statusCode, response.body).toBe(200);
    expect(Array.isArray(JSON.parse(response.body))).toBe(true);
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

const PASSWORD = 'correct-horse-battery';

/** A signed-in client, through the real app's own auth routes. */
async function signedIn(
  role: 'sales' | 'org_admin',
  options: { clearWall?: boolean } = {},
): Promise<{ client: Client; userId: string }> {
  const client = new Client();
  const email = `${role}_${randomUUID().slice(0, 8)}@example.invalid`;
  const userId = `usr_${randomUUID()}`;

  await withGlobal(async (tx) => {
    await tx.execute(sql`
      insert into iam.users (id, email, name, email_verified)
      values (${userId}, ${email}, ${role}, true)
    `);
  });
  await grantMembership({ userId, orgId: ORG_A, role });

  await client.request('GET', '/v1/auth/login-branding');
  await client.request('POST', '/api/auth/request-password-reset', {
    email,
    redirectTo: '/accept-invite',
  });

  const token = built.tokens.take(email);
  expect(token, `no invite token for ${email}`).toBeDefined();
  await client.request('POST', '/api/auth/reset-password', { newPassword: PASSWORD, token });
  await client.request('POST', '/api/auth/sign-in/email', { email, password: PASSWORD });

  if (options.clearWall === true) {
    const enabled = await client.request('POST', '/api/auth/two-factor/enable', {
      password: PASSWORD,
      method: 'totp',
    });
    const { totpURI } = JSON.parse(enabled.body) as { totpURI: string };
    const { base32 } = await import('@better-auth/utils/base32');
    const secret = new TextDecoder().decode(
      base32.decode(new URL(totpURI).searchParams.get('secret') ?? ''),
    );
    const { createOTP } = await import('@better-auth/utils/otp');
    const code = await createOTP(secret, { digits: 6, period: 30 }).totp();
    await client.request('POST', '/api/auth/two-factor/verify-totp', { code });
  }

  await client.request('POST', '/v1/me/active-org', { orgId: ORG_A });
  return { client, userId };
}
