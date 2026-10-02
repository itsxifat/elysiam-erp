import { randomUUID } from 'node:crypto';

import { base32 } from '@better-auth/utils/base32';
import { fastifyCookie } from '@fastify/cookie';
import { Module, type DynamicModule, type Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { MembershipRole } from '@elysium/contracts';
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

import { AppModule } from '../app.module.js';
import { PasswordTokenStore } from '../modules/iam/iam.service.js';
import { registerAuth } from '../platform/http/auth-plugin.js';
import { CSRF_COOKIE, CSRF_HEADER } from '../platform/http/csrf.js';
import { applyGlobalPipeline } from '../platform/http/pipeline.js';
import { MemoryRateLimiter } from '../platform/http/rate-limit.js';
import { setServerTestEnvWithDatabase, TEST_AUTH_SECRET } from './test-env.js';

/**
 * The shared HTTP test harness (M02b: "test utilities: `asRole(role, org)`").
 *
 * Boots the real application against a throwaway database — the same module
 * graph, the same auth plugin and **the same global pipeline** `main.api.ts`
 * mounts (`applyGlobalPipeline`), so a suite cannot pass against a guard or an
 * interceptor order production does not have. Then `asRole` signs a brand-new
 * user in through the real flow: invite token, password, second factor where
 * §6 requires one, and the org switch.
 *
 * Test-only. It lives under `src/testing` rather than beside a suite so every
 * later module's HTTP tests start from it instead of copying it.
 */

export const ORG_A = SEED_ORG_IDS['elysium-lifestyle-bd'] ?? '';
export const ORG_B = SEED_ORG_IDS['oura-lifestyle'] ?? '';
export const APP_DOMAIN = 'erp.example.com';
export const ORIGIN = `https://${APP_DOMAIN}`;
export const PASSWORD = 'correct-horse-battery';

/** Roles §6 walls behind a second factor, which `asRole` therefore enrols. */
const TWO_FACTOR_ROLES: readonly MembershipRole[] = ['org_admin', 'accounts', 'investor'];

let nextIp = 0;
function freshIp(): string {
  nextIp += 1;
  return `10.2.${String(Math.floor(nextIp / 256) % 256)}.${String(nextIp % 256)}`;
}

/** The parts of an injected response the suites read. */
export interface InjectedResponse {
  readonly statusCode: number;
  readonly body: string;
  readonly headers: Record<string, unknown>;
}

/** Everything a browser would carry between requests. */
export class Client {
  private readonly cookies = new Map<string, string>();

  constructor(
    private readonly server: FastifyInstance,
    private readonly ip: string = freshIp(),
  ) {}

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

  /**
   * The jar as a `Cookie` header, for a request this class cannot make itself.
   *
   * The realtime suite needs it: a Socket.IO handshake is a WebSocket upgrade on
   * a real listening port, not a `server.inject()`, so it has to carry the
   * session cookie by hand. Exposed rather than duplicating the sign-in flow,
   * because a second sign-in path in the tests is a second thing that can
   * disagree with production about what a session is.
   */
  cookieHeader(): string {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  async request(
    method: string,
    url: string,
    options: { body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<InjectedResponse> {
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

    const response = await this.server.inject({
      method: method as 'GET',
      url,
      headers,
      ...(options.body === undefined ? {} : { payload: JSON.stringify(options.body) }),
    });

    this.absorb(response.headers);
    return response;
  }
}

export interface RoleClient {
  readonly client: Client;
  readonly userId: string;
  readonly email: string;
}

export interface AsRoleOptions {
  /** Limit the membership to these branches (§6 branch scope). */
  readonly branchIds?: readonly string[];
}

export interface HttpHarness {
  readonly app: NestFastifyApplication;
  readonly server: FastifyInstance;
  readonly auth: ReturnType<typeof createAuth>;
  readonly tokens: PasswordTokenStore;
  readonly database: TestDatabase;
  /** A fresh anonymous client with its own address. */
  client(): Client;
  asRole(
    role: MembershipRole | readonly MembershipRole[],
    orgId?: string,
    options?: AsRoleOptions,
  ): Promise<RoleClient>;
  close(): Promise<void>;
}

/** The root the harness builds when a suite brings its own module. */
@Module({})
class HarnessRoot {}

let active: HttpHarness | undefined;

/**
 * Boot the application for one test file. Call in `beforeAll`, and `close()`
 * in `afterAll`.
 */
export interface HarnessOptions {
  /**
   * Modules mounted beside `AppModule`, for a module this session has not yet
   * registered in `app.module.ts`.
   *
   * Milestones are built in parallel and `app.module.ts` is one file: an agent
   * that adds its own import line there silently discards whatever another agent
   * wrote to the same file. So a module under construction hands itself to the
   * harness instead, and the integrator adds the one line at the end.
   *
   * Nest instantiates each module once per application, so a module passed here
   * shares the `ApprovalsModule`, `LedgerModule` and `FilesModule` instances that
   * `AppModule` already built rather than getting copies of them — which is what
   * makes an executor registered by one visible to the other.
   */
  readonly extraModules?: readonly (DynamicModule | Type<unknown>)[];
}

export async function startHttpHarness(
  name: string,
  options: HarnessOptions = {},
): Promise<HttpHarness> {
  const database = await startTestDatabase(name);

  // Before the app is built: `serverEnv()` parses once and caches.
  setServerTestEnvWithDatabase(database.appUrl, ORIGIN, APP_DOMAIN);

  const tokens = new PasswordTokenStore();
  const auth = createAuth({
    baseUrl: ORIGIN,
    secret: TEST_AUTH_SECRET,
    trustedOrigins: [ORIGIN],
    cookieDomain: `.${APP_DOMAIN}`,
    sms: new RecordingSmsProvider(),
    // Suites drive dozens of sign-ins; rate limiting has its own tests.
    rateLimitEnabled: false,
    onPasswordToken: ({ email, token }) => {
      tokens.put(email, token);
      return Promise.resolve();
    },
  });

  const root: DynamicModule = {
    module: HarnessRoot,
    imports: [AppModule.register({ auth: auth.auth, tokens }), ...(options.extraModules ?? [])],
  };

  const app = await NestFactory.create<NestFastifyApplication>(
    root,
    // `trustProxy` so `x-forwarded-for` decides `request.ip` per client.
    new FastifyAdapter({ trustProxy: true }),
    { logger: false },
  );

  applyGlobalPipeline(app);

  const server = app.getHttpAdapter().getInstance();
  await server.register(fastifyCookie as never);
  registerAuth(server, {
    auth: auth.auth,
    limiter: new MemoryRateLimiter(),
    rateLimitEnabled: false,
    trustedOrigins: [ORIGIN],
    secure: false,
  });

  await app.init();
  await server.ready();

  const harness: HttpHarness = {
    app,
    server,
    auth,
    tokens,
    database,
    client: () => new Client(server),
    asRole: (role, orgId = ORG_A, options = {}) =>
      signInAs(harness, typeof role === 'string' ? [role] : role, orgId, options),
    async close() {
      await app.close();
      await auth.close();
      await database.stop();
      await stopSharedContainer();
      if (active === harness) active = undefined;
    },
  };

  active = harness;
  return harness;
}

/**
 * A signed-in client holding `role` in `org`, already switched into it.
 *
 * The milestone's `asRole(role, org)`, bound to the harness this test file
 * started. Every call creates a new user, so tests never share a session.
 */
export async function asRole(
  role: MembershipRole | readonly MembershipRole[],
  orgId: string = ORG_A,
  options: AsRoleOptions = {},
): Promise<RoleClient> {
  if (active === undefined) {
    throw new Error('asRole(): no harness is running. Call startHttpHarness() in beforeAll.');
  }
  return active.asRole(role, orgId, options);
}

async function signInAs(
  harness: HttpHarness,
  roles: readonly MembershipRole[],
  orgId: string,
  options: AsRoleOptions,
): Promise<RoleClient> {
  const client = harness.client();
  const email = `${roles.join('_')}_${String(Date.now())}_${Math.random().toString(36).slice(2, 7)}@example.invalid`;
  const userId = `usr_${randomUUID()}`;

  await withGlobal(async (tx) => {
    await tx.execute(sql`
      insert into iam.users (id, email, name, email_verified)
      values (${userId}, ${email}, ${roles.join(', ')}, true)
    `);
  });

  for (const role of roles) {
    await grantMembership({
      userId,
      orgId,
      role,
      ...(options.branchIds === undefined ? {} : { branchIds: options.branchIds }),
    });
  }

  await client.request('GET', '/v1/auth/login-branding');
  // Minted from the server, as the iam module does: the HTTP path is disabled (D-402).
  await harness.auth.auth.api.requestPasswordReset({
    body: { email, redirectTo: '/accept-invite' },
    headers: new Headers(),
  });
  const token = harness.tokens.take(email);
  await client.request('POST', '/api/auth/reset-password', {
    body: { newPassword: PASSWORD, token },
  });
  await client.request('POST', '/api/auth/sign-in/email', { body: { email, password: PASSWORD } });

  // §6 requires a second factor for these, and the wall blocks everything else
  // until it exists.
  if (roles.some((role) => TWO_FACTOR_ROLES.includes(role))) {
    const enabled = await client.request('POST', '/api/auth/two-factor/enable', {
      body: { password: PASSWORD, method: 'totp' },
    });
    const { totpURI } = JSON.parse(enabled.body) as { totpURI: string };
    const secret = new TextDecoder().decode(
      base32.decode(new URL(totpURI).searchParams.get('secret') ?? ''),
    );
    const { code } = await harness.auth.auth.api.generateTOTP({ body: { secret } });
    await client.request('POST', '/api/auth/two-factor/verify-totp', { body: { code } });
  }

  const switched = await client.request('POST', '/v1/me/active-org', { body: { orgId } });
  if (switched.statusCode !== 201) {
    throw new Error(`asRole(): could not enter ${orgId} as ${roles.join('+')}: ${switched.body}`);
  }
  return { client, userId, email };
}

/** A branch in an org, for scope tests. Returns its id. */
export async function createBranch(orgId: string, code: string): Promise<string> {
  const rows = await withSystem(
    async (tx) =>
      tx.execute<{ id: string }>(sql`
        insert into org.branches (org_id, code, name, kind)
        values (${orgId}, ${code}, ${`Branch ${code}`}, 'showroom')
        returning id
      `),
    { orgId },
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('createBranch(): insert returned nothing');
  return id;
}

/**
 * Assert PostgreSQL refused a statement, matching the *database's* message and,
 * optionally, its SQLSTATE.
 *
 * Drizzle raises `Failed query: ...` and hangs the real error off `.cause`.
 * Matching the wrapper would pass for any failure at all, including a typo in
 * the SQL — which is exactly the false confidence these tests exist to avoid.
 */
export async function expectRefused(
  work: Promise<unknown>,
  pattern: RegExp,
  sqlstate?: string,
): Promise<void> {
  let caught: unknown;
  try {
    await work;
  } catch (error) {
    caught = error;
  }

  if (caught === undefined) throw new Error('expected PostgreSQL to refuse this statement');

  const messages: string[] = [];
  const codes: string[] = [];
  for (let error: unknown = caught; error instanceof Error; error = error.cause) {
    messages.push(error.message);
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') codes.push(code);
  }

  if (!pattern.test(messages.join(' | '))) {
    throw new Error(`refused for the wrong reason: ${messages.join(' | ')}`);
  }
  if (sqlstate !== undefined && !codes.includes(sqlstate)) {
    throw new Error(`expected SQLSTATE ${sqlstate}, got ${codes.join(', ') || 'none'}`);
  }
}

/** Audit rows for one entity, read as the owner so RLS is not the question. */
export async function auditRowsFor(
  orgId: string,
  entityId: string,
): Promise<
  {
    action: string;
    operation: string;
    actor_user_id: string | null;
    entity_type: string;
    before: unknown;
    after: unknown;
  }[]
> {
  const rows = await withSystem(
    async (tx) =>
      tx.execute<{
        action: string;
        operation: string;
        actor_user_id: string | null;
        entity_type: string;
        before: unknown;
        after: unknown;
      }>(sql`
        select action, operation::text as operation, actor_user_id, entity_type, before, after
        from audit.audit_log
        where entity_id = ${entityId}
        order by created_at
      `),
    { orgId },
  );
  return [...rows];
}
