import { fastifyCookie } from '@fastify/cookie';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  createAuth,
  RecordingSmsProvider,
  SEED_ORG_IDS,
  withSystem,
  type MembershipRole,
} from '@elysium/db';
import {
  grantMembership,
  revokeMembership,
  startTestDatabase,
  stopSharedContainer,
  type TestDatabase,
} from '@elysium/db/testing';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../../app.module.js';
import { registerAuth } from './auth-plugin.js';
import { CSRF_COOKIE, CSRF_HEADER } from './csrf.js';

/**
 * The HTTP surface (architecture §6, §25 — M02a checks 2, 4 and 6).
 *
 * `packages/db` tests the identity *library*; this tests the thing a browser
 * actually talks to. They are not the same assertion: the CSRF double-submit
 * check, the 2FA enrolment wall and the org switch only exist once a request
 * has been through Fastify, the auth plugin and a Nest controller in that
 * order. A library-level test cannot see a hook that was never registered.
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

beforeAll(async () => {
  database = await startTestDatabase('http-surface');

  // Before the app is built: `serverEnv()` parses once and caches, and the
  // controller reads APP_DOMAIN off it.
  process.env.DATABASE_URL = database.appUrl;
  process.env.APP_DOMAIN = APP_DOMAIN;
  process.env.AUTH_SECRET = 'test-secret-that-is-at-least-32-characters-long';
  process.env.TRUSTED_ORIGINS = ORIGIN;

  authHandle = createAuth({
    baseUrl: ORIGIN,
    secret: process.env.AUTH_SECRET,
    trustedOrigins: [ORIGIN],
    cookieDomain: `.${APP_DOMAIN}`,
    sms: new RecordingSmsProvider(),
    // The suite drives dozens of sign-ins; throttling them would make every
    // assertion here flaky for a reason it is not testing. Rate limiting has
    // its own check in packages/db.
    rateLimitEnabled: false,
  });

  app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
    logger: false,
  });

  server = app.getHttpAdapter().getInstance();
  await server.register(fastifyCookie as never);

  registerAuth(server, {
    auth: authHandle.auth,
    trustedOrigins: [ORIGIN],
    cookieDomain: `.${APP_DOMAIN}`,
    // `inject()` speaks http, and a Secure cookie would be dropped by a real
    // browser on it. The production path sets this from NODE_ENV.
    secure: false,
  });

  await app.init();
  await server.ready();
}, 180_000);

afterAll(async () => {
  await app?.close();
  await authHandle?.close();
  await database?.stop();
  await stopSharedContainer();
}, 60_000);

/** Everything a browser would carry between requests. */
class Client {
  private readonly cookies = new Map<string, string>();

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

  cookieHeader(): string {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  csrfToken(): string {
    return this.cookies.get(CSRF_COOKIE) ?? '';
  }

  async request(
    method: string,
    url: string,
    options: { body?: unknown; headers?: Record<string, string>; csrf?: boolean } = {},
  ) {
    const headers: Record<string, string> = {
      host: APP_DOMAIN,
      origin: ORIGIN,
      ...options.headers,
    };

    const cookie = this.cookieHeader();
    if (cookie !== '') headers.cookie = cookie;
    if (options.csrf !== false && this.csrfToken() !== '') {
      headers[CSRF_HEADER] = this.csrfToken();
    }
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

/** A signed-in browser for a fresh user holding `role` in `orgId`. */
async function signedIn(
  role: MembershipRole,
  orgId: string,
): Promise<{ client: Client; userId: string; email: string }> {
  const client = new Client();
  const email = `${role}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}@example.invalid`;

  // A browser's first move: pick the CSRF token up off a safe request, exactly
  // as the console does before it posts the login form.
  await client.request('GET', '/v1/auth/login-branding');

  const signUp = await client.request('POST', '/api/auth/sign-up/email', {
    body: { email, password: PASSWORD, name: `${role} user` },
  });
  expect(signUp.statusCode, signUp.body).toBeLessThan(400);

  const userId = await userIdFor(email);
  await grantMembership({ userId, orgId, role });

  return { client, userId, email };
}

async function userIdFor(email: string): Promise<string> {
  const id = await withSystem(async (tx) => {
    const rows = await tx.execute<{ id: string }>(
      sql`select id from iam.users where email = ${email}`,
    );
    return rows[0]?.id ?? '';
  });
  if (id === '') throw new Error(`no user with email ${email}`);
  return id;
}

describe('check 6: a cookie-authenticated mutation needs a valid CSRF token', () => {
  it('issues a double-submit token on a safe request', async () => {
    const client = new Client();
    const response = await client.request('GET', '/health/live');

    expect(response.statusCode).toBe(200);
    expect(client.csrfToken(), 'a readable token the console can echo back').not.toHaveLength(0);
  });

  it('rejects a mutation with no token at all', async () => {
    const { client } = await signedIn('sales', ORG_A);
    const response = await client.request('POST', '/v1/me/active-org', {
      body: { orgId: ORG_A },
      csrf: false,
    });

    expect(response.statusCode).toBe(403);
    expect(response.body).toContain('CSRF');
  });

  it('rejects a mutation whose header does not match the cookie', async () => {
    const { client } = await signedIn('sales', ORG_A);
    const response = await client.request('POST', '/v1/me/active-org', {
      body: { orgId: ORG_A },
      csrf: false,
      // Same length as a real token, so this tests the comparison rather than
      // the length guard in front of it.
      headers: { [CSRF_HEADER]: 'x'.repeat(client.csrfToken().length) },
    });

    expect(response.statusCode).toBe(403);
  });

  it('rejects a mutation from an untrusted origin even with a matching token', async () => {
    // Order matters: Origin is checked first precisely so a token leaked into
    // another origin's page is still not enough.
    const { client } = await signedIn('sales', ORG_A);
    const response = await client.request('POST', '/v1/me/active-org', {
      body: { orgId: ORG_A },
      headers: { origin: 'https://evil.test' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.body).toContain('evil.test');
  });

  it('accepts a mutation carrying a matching token from a trusted origin', async () => {
    const { client } = await signedIn('sales', ORG_A);
    const response = await client.request('POST', '/v1/me/active-org', {
      body: { orgId: ORG_A },
    });

    expect(response.statusCode, response.body).toBe(201);
  });

  it('never demands a token on a safe method', async () => {
    const client = new Client();
    const response = await client.request('GET', '/v1/auth/login-branding', { csrf: false });
    expect(response.statusCode).toBe(200);
  });
});

describe('check 2: switching org changes the effective roles on the request', () => {
  it('has no org, and so no context, until one is chosen', async () => {
    const { client } = await signedIn('sales', ORG_A);
    const before = await client.request('GET', '/v1/me');

    expect(before.statusCode, 'a session is not yet an org').toBe(401);
  });

  it('reports the roles of the org it was switched into', async () => {
    const { client } = await signedIn('sales', ORG_A);

    const switched = await client.request('POST', '/v1/me/active-org', { body: { orgId: ORG_A } });
    expect(switched.statusCode, switched.body).toBe(201);
    expect(JSON.parse(switched.body)).toMatchObject({ orgId: ORG_A, roles: ['sales'] });

    const me = await client.request('GET', '/v1/me');
    expect(me.statusCode).toBe(200);
    expect(JSON.parse(me.body)).toMatchObject({ orgId: ORG_A, roles: ['sales'] });
  });

  it('carries different roles for the same person in a second org', async () => {
    const { client, userId } = await signedIn('sales', ORG_A);
    await grantMembership({ userId, orgId: ORG_B, role: 'warehouse' });

    await client.request('POST', '/v1/me/active-org', { body: { orgId: ORG_A } });
    expect(JSON.parse((await client.request('GET', '/v1/me')).body)).toMatchObject({
      orgId: ORG_A,
      roles: ['sales'],
    });

    await client.request('POST', '/v1/me/active-org', { body: { orgId: ORG_B } });
    expect(JSON.parse((await client.request('GET', '/v1/me')).body)).toMatchObject({
      orgId: ORG_B,
      roles: ['warehouse'],
    });
  });

  it('stops honouring the active org the moment the membership is revoked', async () => {
    // The session outlives the membership. This is the only place that notices,
    // which is why the context is rebuilt per request rather than cached.
    const { client, userId } = await signedIn('sales', ORG_A);
    const membershipId = await grantMembership({ userId, orgId: ORG_B, role: 'warehouse' });

    await client.request('POST', '/v1/me/active-org', { body: { orgId: ORG_B } });
    expect((await client.request('GET', '/v1/me')).statusCode).toBe(200);

    await revokeMembership(membershipId, ORG_B);
    expect(
      (await client.request('GET', '/v1/me')).statusCode,
      'a revoked membership must take effect at once',
    ).toBe(401);
  });

  it('refuses an org the user holds no membership in, without saying whether it exists', async () => {
    const { client } = await signedIn('sales', ORG_A);
    const denied = await client.request('POST', '/v1/me/active-org', { body: { orgId: ORG_B } });
    const missing = await client.request('POST', '/v1/me/active-org', {
      body: { orgId: '00000000-0000-4000-8000-000000000000' },
    });

    expect(denied.statusCode).toBe(403);
    expect(missing.statusCode).toBe(403);
    // Identical, or the endpoint is a membership oracle.
    const reason = (body: string) => (JSON.parse(body) as { message?: string }).message;
    expect(reason(denied.body)).toBe(reason(missing.body));
  });

  it('rejects a switch with no org id', async () => {
    const { client } = await signedIn('sales', ORG_A);
    const response = await client.request('POST', '/v1/me/active-org', { body: {} });
    expect(response.statusCode).toBe(400);
  });

  it('lists exactly the orgs the switcher may show', async () => {
    const { client } = await signedIn('sales', ORG_A);
    const response = await client.request('GET', '/v1/me/orgs');

    expect(response.statusCode).toBe(200);
    const { orgs } = JSON.parse(response.body) as { orgs: { orgId: string }[] };
    expect(orgs.map((org) => org.orgId)).toEqual([ORG_A]);
  });

  it('turns an anonymous request away from the switcher', async () => {
    const client = new Client();
    await client.request('GET', '/health/live');
    const response = await client.request('GET', '/v1/me/orgs');
    expect(response.statusCode).toBe(400);
  });
});

describe('the 2FA enrolment wall (§6)', () => {
  it('lets an unprivileged role straight through', async () => {
    const { client } = await signedIn('sales', ORG_A);
    const response = await client.request('GET', '/v1/me/orgs');
    expect(response.statusCode).toBe(200);
  });

  it('blocks a privileged role from every route until the factor is real', async () => {
    const { client } = await signedIn('org_admin', ORG_A);

    for (const [method, url] of [
      ['GET', '/v1/me/orgs'],
      ['GET', '/v1/me'],
      ['POST', '/v1/me/active-org'],
      ['POST', '/v1/users'],
    ] as const) {
      const response = await client.request(method, url, {
        ...(method === 'POST' ? { body: { orgId: ORG_A } } : {}),
      });
      expect(response.statusCode, `${method} ${url} must be walled`).toBe(403);
      expect(response.body).toContain('TWO_FACTOR_ENROLMENT_REQUIRED');
    }
  });

  it('still lets that role reach the enrolment endpoint it needs', async () => {
    const { client } = await signedIn('accounts', ORG_A);
    const response = await client.request('POST', '/api/auth/two-factor/enable', {
      body: { password: PASSWORD, method: 'totp' },
    });

    expect(response.statusCode, response.body).toBeLessThan(400);
    const body = JSON.parse(response.body) as { totpURI?: string; backupCodes?: string[] };
    expect(body.totpURI).toBeTruthy();
    expect(body.backupCodes).toHaveLength(10);
  });
});

describe('check 3: branded login resolves an org from the hostname', () => {
  it('preselects the org named by the subdomain', async () => {
    const client = new Client();
    const response = await client.request('GET', '/v1/auth/login-branding', {
      headers: { host: `oura-lifestyle.${APP_DOMAIN}` },
      csrf: false,
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      slug: 'oura-lifestyle',
      orgId: ORG_B,
      generic: false,
    });
  });

  it('prefers the caller-supplied hostname over its own', async () => {
    // The console is served from `<org>.<domain>` while this API answers on
    // `api.<domain>`. Reading our own Host header would resolve every branded
    // login to an org called "api", so the caller says which host it is on.
    const client = new Client();
    const response = await client.request('GET', '/v1/auth/login-branding', {
      headers: { host: `api.${APP_DOMAIN}` },
      csrf: false,
    });
    expect(JSON.parse(response.body)).toMatchObject({ generic: true });

    const branded = await client.request(
      'GET',
      `/v1/auth/login-branding?host=${encodeURIComponent(`oura-lifestyle.${APP_DOMAIN}`)}`,
      { headers: { host: `api.${APP_DOMAIN}` }, csrf: false },
    );
    expect(JSON.parse(branded.body)).toMatchObject({ slug: 'oura-lifestyle', generic: false });
  });

  it('falls back to the generic login for an unknown host', async () => {
    const client = new Client();
    const response = await client.request('GET', '/v1/auth/login-branding', {
      headers: { host: 'nope.example.org' },
      csrf: false,
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({ slug: null, generic: true });
  });
});

describe('the user admin API', () => {
  it('creates a user and a membership in the caller org', async () => {
    const { client } = await signedIn('sales', ORG_A);
    await client.request('POST', '/v1/me/active-org', { body: { orgId: ORG_A } });

    const email = `made_${Date.now()}@example.invalid`;
    const response = await client.request('POST', '/v1/users', {
      body: { email, name: 'Made User', role: 'warehouse' },
    });

    expect(response.statusCode, response.body).toBe(201);
    const body = JSON.parse(response.body) as { userId: string; created: boolean };
    expect(body.created).toBe(true);
    expect(await userIdFor(email)).toBe(body.userId);
  });

  it('reuses an identity when the same person joins a second brand', async () => {
    // The deliberate asymmetry of §6: users are global, memberships are not.
    // A duplicate account per brand would break the switcher and split the
    // person's audit trail in two.
    const { client } = await signedIn('sales', ORG_A);
    await client.request('POST', '/v1/me/active-org', { body: { orgId: ORG_A } });

    const email = `shared_${Date.now()}@example.invalid`;
    const first = await client.request('POST', '/v1/users', {
      body: { email, name: 'Shared User', role: 'warehouse' },
    });
    const second = await client.request('POST', '/v1/users', {
      body: { email, name: 'Shared User', role: 'marketing' },
    });

    const a = JSON.parse(first.body) as { userId: string; created: boolean };
    const b = JSON.parse(second.body) as { userId: string; created: boolean };

    expect(a.userId).toBe(b.userId);
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
  });

  it('refuses a role it does not recognise', async () => {
    const { client } = await signedIn('sales', ORG_A);
    await client.request('POST', '/v1/me/active-org', { body: { orgId: ORG_A } });

    const response = await client.request('POST', '/v1/users', {
      body: { email: `bad_${Date.now()}@example.invalid`, name: 'X', role: 'superuser' },
    });

    expect(response.statusCode).toBe(400);
  });

  it('refuses a malformed email before it reaches the database', async () => {
    const { client } = await signedIn('sales', ORG_A);
    await client.request('POST', '/v1/me/active-org', { body: { orgId: ORG_A } });

    const response = await client.request('POST', '/v1/users', {
      body: { email: 'not-an-email', name: 'X', role: 'warehouse' },
    });

    expect(response.statusCode).toBe(400);
  });

  it('refuses to create anyone when no org is active', async () => {
    const { client } = await signedIn('sales', ORG_A);
    const response = await client.request('POST', '/v1/users', {
      body: { email: `orphan_${Date.now()}@example.invalid`, name: 'X', role: 'warehouse' },
    });

    expect(response.statusCode).toBe(401);
  });
});
