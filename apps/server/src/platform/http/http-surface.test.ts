import { fastifyCookie } from '@fastify/cookie';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  createAuth,
  RecordingSmsProvider,
  SEED_ORG_IDS,
  withGlobal,
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
import { randomUUID } from 'node:crypto';

import { base32 } from '@better-auth/utils/base32';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../../app.module.js';
import { PasswordTokenStore } from '../../modules/iam/iam.service.js';
import { registerAuth } from './auth-plugin.js';
import { CSRF_COOKIE, CSRF_HEADER } from './csrf.js';
import { MemoryRateLimiter } from './rate-limit.js';
import { setServerTestEnvWithDatabase, TEST_AUTH_SECRET } from '../../testing/test-env.js';

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

/**
 * Shared with the app so the rate-limit tests can clear it.
 *
 * Every other test in this file creates and signs in a user, which would
 * otherwise consume the very allowance check 5 is trying to measure.
 */
const limiter = new MemoryRateLimiter();

/** Where invite tokens land, since there is no email adapter until M16. */
const tokens = new PasswordTokenStore();

beforeAll(async () => {
  database = await startTestDatabase('http-surface');

  // Before the app is built: `serverEnv()` parses once and caches, and the
  // controller reads APP_DOMAIN off it.
  setServerTestEnvWithDatabase(database.appUrl, ORIGIN, APP_DOMAIN);

  authHandle = createAuth({
    baseUrl: ORIGIN,
    secret: TEST_AUTH_SECRET,
    trustedOrigins: [ORIGIN],
    cookieDomain: `.${APP_DOMAIN}`,
    sms: new RecordingSmsProvider(),
    onPasswordToken: ({ email, token }) => {
      tokens.put(email, token);
      return Promise.resolve();
    },
    // The suite drives dozens of sign-ins; throttling them would make every
    // assertion here flaky for a reason it is not testing. Rate limiting has
    // its own check in packages/db.
    rateLimitEnabled: false,
  });

  app = await NestFactory.create<NestFastifyApplication>(
    AppModule.register({ auth: authHandle.auth, tokens }),
    // `trustProxy` so `x-forwarded-for` decides `request.ip`, which is the only
    // way a test can vary the client address — and check 5 is precisely about
    // varying it independently of the identifier.
    new FastifyAdapter({ trustProxy: true }),
    { logger: false },
  );

  server = app.getHttpAdapter().getInstance();
  await server.register(fastifyCookie as never);

  registerAuth(server, {
    auth: authHandle.auth,
    limiter,
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

  constructor(private readonly defaultIp?: string) {}

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

  /** The session cookie's value — the thing httpOnly exists to keep private. */
  sessionToken(): string {
    for (const [name, value] of this.cookies) {
      if (name.includes('session_token')) return value;
    }
    return '';
  }

  async request(
    method: string,
    url: string,
    options: {
      body?: unknown;
      headers?: Record<string, string>;
      csrf?: boolean;
      ip?: string;
    } = {},
  ) {
    const clientIp = options.ip ?? this.defaultIp;
    const headers: Record<string, string> = {
      host: APP_DOMAIN,
      origin: ORIGIN,
      // The app is built with trustProxy, so this is what `request.ip` becomes.
      ...(clientIp === undefined ? {} : { 'x-forwarded-for': clientIp }),
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

/**
 * A distinct client address per simulated user.
 *
 * Real users are not all behind one IP, and the rate limiter is real now: every
 * test sharing one address would exhaust the per-IP allowance and start failing
 * for a reason none of them is testing.
 */
let nextClientIp = 0;
function freshIp(): string {
  nextClientIp += 1;
  return `10.${String(Math.floor(nextClientIp / 65_536) % 256)}.${String(Math.floor(nextClientIp / 256) % 256)}.${String(nextClientIp % 256)}`;
}

/**
 * A signed-in browser for a fresh user holding `role` in `orgId`.
 *
 * Self-service registration is closed (`disableSignUp`), so this creates the
 * user and then redeems an invite for its credential — the way the product now
 * works — rather than through a public sign-up that no longer exists.
 */
async function signedIn(
  role: MembershipRole,
  orgId: string,
): Promise<{ client: Client; userId: string; email: string }> {
  const client = new Client(freshIp());
  const email = `${role}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}@example.invalid`;

  const userId = await createUserRow(email, `${role} user`);
  await grantMembership({ userId, orgId, role });
  await setPassword(client, email);

  const signIn = await client.request('POST', '/api/auth/sign-in/email', {
    body: { email, password: PASSWORD },
  });
  expect(signIn.statusCode, signIn.body).toBeLessThan(400);

  return { client, userId, email };
}

/** Create the global user row directly, standing in for an org_admin's invite. */
async function createUserRow(email: string, name: string): Promise<string> {
  const id = `usr_${randomUUID()}`;
  await withGlobal(async (tx) => {
    await tx.execute(sql`
      insert into iam.users (id, email, name, email_verified)
      values (${id}, ${email}, ${name}, true)
    `);
  });
  return id;
}

/** Redeem an invite, which is how a created user first gets a password. */
async function setPassword(client: Client, email: string): Promise<void> {
  await client.request('GET', '/v1/auth/login-branding');
  const requested = await client.request('POST', '/api/auth/request-password-reset', {
    body: { email, redirectTo: '/accept-invite' },
  });
  expect(requested.statusCode, requested.body).toBeLessThan(400);

  const token = tokens.take(email);
  expect(token, `no invite token was issued for ${email}`).toBeDefined();

  const reset = await client.request('POST', '/api/auth/reset-password', {
    body: { newPassword: PASSWORD, token },
  });
  expect(reset.statusCode, reset.body).toBeLessThan(400);
}

/** Clear the 2FA wall for a privileged role, the way the console does. */
async function enrolTwoFactor(client: Client): Promise<void> {
  const enabled = await client.request('POST', '/api/auth/two-factor/enable', {
    body: { password: PASSWORD, method: 'totp' },
  });
  expect(enabled.statusCode, enabled.body).toBeLessThan(400);

  const { totpURI } = JSON.parse(enabled.body) as { totpURI: string };
  const encoded = new URL(totpURI).searchParams.get('secret') ?? '';
  const secret = new TextDecoder().decode(base32.decode(encoded));
  const { code } = await authHandle.auth.api.generateTOTP({ body: { secret } });

  const verified = await client.request('POST', '/api/auth/two-factor/verify-totp', {
    body: { code },
  });
  expect(verified.statusCode, verified.body).toBeLessThan(400);
}

/** The branch ids of an org, read as the owner so a test can cross orgs. */
async function branchesOf(orgId: string): Promise<string[]> {
  const rows = await withSystem(
    async (tx) => tx.execute<{ id: string }>(sql`select id from org.branches`),
    { orgId },
  );
  return [...rows].map((row) => row.id);
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

  it('rejects a browser request marked cross-site, whatever else it carries', async () => {
    // Fetch metadata cannot be set by page script. D-053 keeps every app of
    // ours on the API's registrable domain, so none of ours is ever cross-site
    // — and this holds even when the Origin header is missing entirely.
    const { client } = await signedIn('sales', ORG_A);
    const response = await client.request('POST', '/v1/me/active-org', {
      body: { orgId: ORG_A },
      headers: { 'sec-fetch-site': 'cross-site', origin: '' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.body).toContain('cross-site');
  });

  it('accepts same-site fetch metadata, which is what the console sends', async () => {
    const { client } = await signedIn('sales', ORG_A);
    const response = await client.request('POST', '/v1/me/active-org', {
      body: { orgId: ORG_A },
      headers: { 'sec-fetch-site': 'same-site' },
    });

    expect(response.statusCode, response.body).toBe(201);
  });
});

describe('the credential rate limits cannot be sidestepped with a trailing slash', () => {
  it('does not route /api/auth/sign-in/email/ to sign-in at all', async () => {
    // The rate-limit rules match exact paths. They are safe only because
    // Better Auth's router rejects the trailing-slash spelling outright — so
    // that is pinned here. If an upgrade (or `skipTrailingSlashes`) ever makes
    // it answer 401 "wrong password" instead, this fails before the bypass
    // ships (M02a follow-up).
    const client = new Client(freshIp());
    await client.request('GET', '/health/live');

    const response = await client.request('POST', '/api/auth/sign-in/email/', {
      body: { email: 'nobody@example.invalid', password: 'not-the-password' },
    });

    expect(response.statusCode, response.body).toBe(404);
  });
});

describe('signing out', () => {
  /*
   * Sent exactly as the console sends it: a POST with no body, and therefore no
   * content-type. The auth plugin used to forward that to Better Auth as a JSON
   * body with no content-type header, which Better Auth refused with 415 — and the
   * console's `.finally(reload)` then reloaded into a session that was still live.
   * On a shared showroom till that is the next cashier inheriting the last one's
   * login. Found by driving the console in a browser; nothing here sent a bodiless
   * auth POST before.
   */
  it('ends the session when the console sends no body', async () => {
    const { client } = await signedIn('sales', ORG_A);

    const before = await client.request('GET', '/v1/me/orgs');
    expect(before.statusCode, 'not signed in to begin with').toBe(200);

    const signedOut = await client.request('POST', '/api/auth/sign-out');
    expect(signedOut.statusCode, signedOut.body).toBeLessThan(400);

    const after = await client.request('GET', '/v1/me/orgs');
    expect(after.statusCode, 'the session outlived sign-out').toBe(401);
  });
});

describe('a session cookie stays a cookie', () => {
  /*
   * `GET /api/auth/get-session` returned the raw session token in its body.
   * Verified against the running application: the value of the `session_token`
   * cookie appeared verbatim.
   *
   * That gives back the one property the httpOnly flag buys. The cookie is
   * httpOnly so page script cannot read it, which makes an XSS bug cost an
   * attacker a foothold inside the victim's browser rather than a credential
   * they can carry away and replay from any machine for the life of the
   * session. A response body is readable by script by definition.
   *
   * These assert the property rather than reading the library, so a Better
   * Auth upgrade that starts returning it fails here rather than in an
   * incident.
   */
  it('does not echo the session token into a body script can read', async () => {
    const { client } = await signedIn('sales', ORG_A);

    const cookie = client.sessionToken();
    expect(cookie, 'no session cookie, so this would prove nothing').not.toBe('');

    const response = await client.request('GET', '/api/auth/get-session');
    expect(response.statusCode, response.body).toBe(200);

    // The positive control first: a real session came back, so the absence
    // below is about the token and not about an empty body.
    const parsed = JSON.parse(response.body) as { user?: { id?: string } } | null;
    expect(parsed?.user?.id, 'get-session returned no user').toBeDefined();

    expect(response.body).not.toContain(cookie);
    // Better Auth signs the cookie as `<token>.<signature>`, so the raw token
    // is the part before the dot — checked separately, because "the full
    // cookie value is absent" is a weaker statement than "the token is".
    const rawToken = cookie.split('.')[0] ?? '';
    expect(rawToken.length).toBeGreaterThan(8);
    expect(response.body).not.toContain(rawToken);
  });

  it('leaves everything else in the body alone', async () => {
    // The strip is narrow on purpose: a blanket "delete every key called token"
    // would also eat the invite token `POST /v1/users` returns.
    const { client } = await signedIn('sales', ORG_A);
    const response = await client.request('GET', '/api/auth/get-session');
    const parsed = JSON.parse(response.body) as {
      session?: Record<string, unknown>;
      user?: Record<string, unknown>;
    };

    expect(parsed.session).toBeDefined();
    expect(parsed.session).toHaveProperty('expiresAt');
    expect(parsed.session).toHaveProperty('userId');
    expect(parsed.session).not.toHaveProperty('token');
    expect(parsed.user).toHaveProperty('email');
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
    // `detail`, not `message`: every error is RFC 9457 problem details from M04
    // (§23, D-087), and reading a member that is now always absent would make
    // this comparison pass vacuously — on the one assertion that stops this
    // endpoint being a membership oracle.
    const reason = (body: string) => (JSON.parse(body) as { detail?: string }).detail;
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
    // 401, not 400: the request is well formed, the caller is just nobody.
    expect(response.statusCode).toBe(401);
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

  it('does not let a walled role use the rest of Better Auth', async () => {
    // The hatch used to be the whole `/api/auth` prefix, so a walled org_admin
    // could still call update-user and everything else the library exposes.
    // It is an allow-list now, and this is what stops it being re-widened.
    const { client } = await signedIn('org_admin', ORG_A);

    const response = await client.request('POST', '/api/auth/update-user', {
      body: { name: 'Renamed While Walled' },
    });

    expect(response.statusCode, response.body).toBe(403);
    expect(response.body).toContain('TWO_FACTOR_ENROLMENT_REQUIRED');
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

describe('check 5: login and OTP are rate limited, per IP and per identifier', () => {
  beforeEach(() => {
    // Otherwise the sign-ins every other test performs would have already spent
    // the allowance being measured here.
    limiter.reset();
  });

  /** Post `attempts` requests, with control over which axis varies. */
  async function hammer(options: {
    attempts: number;
    email: (attempt: number) => string;
    ip: (attempt: number) => string;
    path?: string;
    body?: (attempt: number) => Record<string, unknown>;
  }): Promise<number[]> {
    const client = new Client();
    await client.request('GET', '/health/live');

    const statuses: number[] = [];
    for (let attempt = 0; attempt < options.attempts; attempt += 1) {
      const response = await client.request('POST', options.path ?? '/api/auth/sign-in/email', {
        body: options.body?.(attempt) ?? {
          email: options.email(attempt),
          password: 'not-the-password',
        },
        ip: options.ip(attempt),
      });
      statuses.push(response.statusCode);
    }
    return statuses;
  }

  it('returns 429 for one account attacked from many addresses', async () => {
    // The attack a per-IP limiter cannot see, and the half the old test never
    // proved: every attempt comes from a fresh address, so only the identifier
    // bucket can stop it.
    const statuses = await hammer({
      attempts: 9,
      email: () => 'victim@example.invalid',
      ip: (attempt) => `203.0.113.${String(attempt + 1)}`,
    });

    expect(statuses, `saw ${statuses.join(',')}`).toContain(429);
    expect(statuses.slice(0, 5).every((status) => status !== 429)).toBe(true);
  });

  it('returns 429 for one address walking many accounts', async () => {
    // The other axis: every identifier is fresh, so only the IP bucket applies.
    const statuses = await hammer({
      attempts: 24,
      email: (attempt) => `user${String(attempt)}@example.invalid`,
      ip: () => '198.51.100.20',
    });

    expect(statuses, `saw ${statuses.join(',')}`).toContain(429);
  });

  it('does not lock out a neighbour behind the same address', async () => {
    // Most of Bangladesh's mobile traffic shares a handful of carrier NAT
    // addresses. One user burning their own attempts must not take the others
    // down with them — which is exactly what a per-IP-only limiter does.
    const shared = '198.51.100.77';

    await hammer({ attempts: 8, email: () => 'noisy@example.invalid', ip: () => shared });

    const client = new Client();
    await client.request('GET', '/health/live');
    const neighbour = await client.request('POST', '/api/auth/sign-in/email', {
      body: { email: 'quiet@example.invalid', password: 'not-the-password' },
      ip: shared,
    });

    expect(neighbour.statusCode, 'a neighbour must still be able to try').not.toBe(429);
  });

  it('rate limits OTP requests too, which are the cheaper thing to abuse', async () => {
    const statuses = await hammer({
      attempts: 6,
      path: '/api/auth/phone-number/send-otp',
      email: () => '',
      ip: (attempt) => `203.0.113.${String(attempt + 100)}`,
      body: () => ({ phoneNumber: '+8801700000000' }),
    });

    expect(statuses, `saw ${statuses.join(',')}`).toContain(429);
  });

  it('says nothing about which bucket tripped', async () => {
    // "Too many attempts for this account" would confirm the account exists,
    // turning the limiter into the enumeration oracle login avoids being.
    const statuses = await hammer({
      attempts: 9,
      email: () => 'victim2@example.invalid',
      ip: (attempt) => `203.0.113.${String(attempt + 40)}`,
    });
    expect(statuses).toContain(429);

    const client = new Client();
    await client.request('GET', '/health/live');
    const rejected = await client.request('POST', '/api/auth/sign-in/email', {
      body: { email: 'victim2@example.invalid', password: 'not-the-password' },
      ip: '203.0.113.99',
    });

    expect(rejected.statusCode).toBe(429);
    expect(rejected.body).not.toContain('identifier');
    expect(rejected.body).not.toContain('victim2');
    expect(rejected.headers['retry-after']).toBeDefined();
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

    expect(response.statusCode, response.body).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({ slug: null, generic: true });
  });
});

describe('the user admin API', () => {
  /** An org_admin who has already cleared the 2FA wall. */
  async function asOrgAdmin(orgId: string) {
    const { client, userId } = await signedIn('sales', orgId);
    await grantMembership({ userId, orgId, role: 'org_admin' });
    await enrolTwoFactor(client);
    await client.request('POST', '/v1/me/active-org', { body: { orgId } });
    return { client, userId };
  }

  it('refuses a caller who is not an org admin', async () => {
    // The attack an audit reproduced against the unguarded route: a `sales`
    // user posts their own address with role org_admin, the existing-identity
    // branch reuses their row, and they hold full org admin in one request.
    const { client, email } = await signedIn('sales', ORG_A);
    await client.request('POST', '/v1/me/active-org', { body: { orgId: ORG_A } });

    const response = await client.request('POST', '/v1/users', {
      body: { email, name: 'Self Promotion', role: 'org_admin', branchIds: [] },
    });

    expect(response.statusCode, response.body).toBe(403);
  });

  it('refuses a warehouse caller too, so it is not just about org_admin', async () => {
    const { client } = await signedIn('warehouse', ORG_A);
    await client.request('POST', '/v1/me/active-org', { body: { orgId: ORG_A } });

    const response = await client.request('POST', '/v1/users', {
      body: { email: `x_${Date.now()}@example.invalid`, name: 'X', role: 'sales', branchIds: [] },
    });

    expect(response.statusCode).toBe(403);
  });

  it('creates a user and a membership for an org admin, with an invite', async () => {
    const { client } = await asOrgAdmin(ORG_A);

    const email = `made_${Date.now()}@example.invalid`;
    const response = await client.request('POST', '/v1/users', {
      body: { email, name: 'Made User', role: 'warehouse', branchIds: [] },
    });

    expect(response.statusCode, response.body).toBe(201);
    const body = JSON.parse(response.body) as {
      userId: string;
      created: boolean;
      inviteToken?: string;
    };
    expect(body.created).toBe(true);
    expect(await userIdFor(email)).toBe(body.userId);

    // Without this the created account has no credential and can never sign in,
    // which is exactly what the route used to produce.
    expect(body.inviteToken, 'a created user needs a way to set a password').toBeTruthy();
  });

  it('gives the invited user a working sign-in', async () => {
    const { client } = await asOrgAdmin(ORG_A);
    const email = `invited_${Date.now()}@example.invalid`;

    const created = await client.request('POST', '/v1/users', {
      body: { email, name: 'Invited User', role: 'warehouse', branchIds: [] },
    });
    const { inviteToken } = JSON.parse(created.body) as { inviteToken: string };

    const invitee = new Client(freshIp());
    await invitee.request('GET', '/v1/auth/login-branding');
    const redeemed = await invitee.request('POST', '/api/auth/reset-password', {
      body: { newPassword: PASSWORD, token: inviteToken },
    });
    expect(redeemed.statusCode, redeemed.body).toBeLessThan(400);

    const signIn = await invitee.request('POST', '/api/auth/sign-in/email', {
      body: { email, password: PASSWORD },
    });
    expect(signIn.statusCode, signIn.body).toBeLessThan(400);
  });

  it('lets a colleague who already has a password join a second brand', async () => {
    // The regression the test below could not catch, because it invites twice
    // before the invitee ever redeems. Once credentials exist, the
    // unclaimed-account guard runs for real — and it read `iam.memberships`
    // inside `withGlobal`, where RLS filters every row, so the count was always
    // zero and every colleague with a password was refused from their second
    // brand. That is the case §5 exception 4 and D-050 exist for.
    const { client } = await asOrgAdmin(ORG_A);
    const email = `colleague_${Date.now()}@example.invalid`;

    const first = await client.request('POST', '/v1/users', {
      body: { email, name: 'Colleague', role: 'warehouse', branchIds: [] },
    });
    expect(first.statusCode, first.body).toBe(201);
    const { inviteToken } = JSON.parse(first.body) as { inviteToken: string };

    // They redeem it, so from here they hold a credential.
    const colleague = new Client(freshIp());
    await colleague.request('GET', '/v1/auth/login-branding');
    const redeemed = await colleague.request('POST', '/api/auth/reset-password', {
      body: { newPassword: PASSWORD, token: inviteToken },
    });
    expect(redeemed.statusCode, redeemed.body).toBeLessThan(400);

    // Now a second brand invites the same person.
    const { client: otherAdmin } = await asOrgAdmin(ORG_B);
    const second = await otherAdmin.request('POST', '/v1/users', {
      body: { email, name: 'Colleague', role: 'sales', branchIds: [] },
    });

    expect(second.statusCode, second.body).toBe(201);
    expect(JSON.parse(second.body)).toMatchObject({ created: false });
  });

  it('reuses an identity when the same person joins a second brand', async () => {
    // The deliberate asymmetry of §6: users are global, memberships are not.
    // A duplicate account per brand would break the switcher and split the
    // person's audit trail in two.
    const { client } = await asOrgAdmin(ORG_A);

    const email = `shared_${Date.now()}@example.invalid`;
    const first = await client.request('POST', '/v1/users', {
      body: { email, name: 'Shared User', role: 'warehouse', branchIds: [] },
    });
    const second = await client.request('POST', '/v1/users', {
      body: { email, name: 'Shared User', role: 'marketing', branchIds: [] },
    });

    const a = JSON.parse(first.body) as { userId: string; created: boolean };
    const b = JSON.parse(second.body) as { userId: string; created: boolean };

    expect(a.userId).toBe(b.userId);
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
  });

  it('refuses to adopt an account that belongs to no organisation', async () => {
    // Account pre-hijacking: someone registers the address of a person about to
    // be hired, and the invite attaches the role to their password. Self-service
    // registration is closed, so this is belt and braces — but a credentialed,
    // org-less row is never a colleague joining a second brand.
    const { client } = await asOrgAdmin(ORG_A);
    const email = `squatter_${Date.now()}@example.invalid`;

    const squatter = new Client(freshIp());
    await createUserRow(email, 'Squatter');
    await setPassword(squatter, email);

    const response = await client.request('POST', '/v1/users', {
      body: { email, name: 'New Hire', role: 'accounts', branchIds: [] },
    });

    expect(response.statusCode, response.body).toBe(409);
  });

  it('refuses a role it does not recognise', async () => {
    const { client } = await asOrgAdmin(ORG_A);

    const response = await client.request('POST', '/v1/users', {
      body: {
        email: `bad_${Date.now()}@example.invalid`,
        name: 'X',
        role: 'superuser',
        branchIds: [],
      },
    });

    expect(response.statusCode).toBe(400);
  });

  it('refuses a malformed email before it reaches the database', async () => {
    const { client } = await asOrgAdmin(ORG_A);

    const response = await client.request('POST', '/v1/users', {
      body: { email: 'not-an-email', name: 'X', role: 'warehouse', branchIds: [] },
    });

    expect(response.statusCode).toBe(400);
  });

  it('refuses a branch belonging to another org, as a 400 rather than a 500', async () => {
    // The composite foreign key (D-047) rejects it at the database. What this
    // asserts is that the rejection surfaces as a typed client error instead of
    // the unhandled constraint violation it used to be.
    const { client } = await asOrgAdmin(ORG_A);

    const [foreign] = await branchesOf(ORG_B);
    expect(foreign, 'the seed should have given ORG_B a branch').toBeDefined();

    const response = await client.request('POST', '/v1/users', {
      body: {
        email: `crossorg_${Date.now()}@example.invalid`,
        name: 'X',
        role: 'warehouse',
        branchIds: [foreign],
      },
    });

    expect(response.statusCode, response.body).toBe(400);
  });

  it('refuses to create anyone when no org is active', async () => {
    const { client } = await signedIn('sales', ORG_A);
    const response = await client.request('POST', '/v1/users', {
      body: {
        email: `orphan_${Date.now()}@example.invalid`,
        name: 'X',
        role: 'warehouse',
        branchIds: [],
      },
    });

    expect(response.statusCode).toBe(401);
  });
});

describe('self-service registration is closed', () => {
  it('refuses an anonymous sign-up', async () => {
    // This is a staff ERP: there is no member of the public who should be able
    // to create an account in it. It was open — an anonymous POST returned 200
    // and wrote rows into iam.users and iam.accounts — and that was the
    // enabling half of the account pre-hijacking above.
    const client = new Client(freshIp());
    await client.request('GET', '/v1/auth/login-branding');

    const response = await client.request('POST', '/api/auth/sign-up/email', {
      body: {
        email: `outsider_${Date.now()}@example.invalid`,
        password: PASSWORD,
        name: 'Outsider',
      },
    });

    expect(response.statusCode, response.body).toBeGreaterThanOrEqual(400);
  });
});
