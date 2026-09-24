import { randomUUID } from 'node:crypto';

import { base32 } from '@better-auth/utils/base32';
import { createOTP } from '@better-auth/utils/otp';
import type { MembershipRole } from '@elysium/contracts';
import { withGlobal } from '@elysium/db';
import { grantMembership } from '@elysium/db/testing';
import { sql } from 'drizzle-orm';
import type { FastifyInstance, InjectOptions } from 'fastify';

/**
 * `asRole(roles, org)` — the test utility M02b's Build list asks for.
 *
 * It lived inside one suite, which is not a utility: `main.api.test.ts` then
 * grew a second, subtly different copy of it, and the two disagreed about the
 * 2FA wall. Extracted here so a suite in any later milestone can ask for a
 * signed-in `branch_manager` in one line and get one that went through the
 * real sign-in, the real second factor and the real org switch — rather than
 * a request object with a `roles` array stapled to it.
 *
 * The distinction matters more than it sounds. A fabricated context tests the
 * guard against a fiction; this exercises Better Auth, the session row, the
 * enrolment wall (D-051), the CSRF double-submit and the active-org write, so
 * a permission test that passes here is a statement about the running system.
 */

export interface RoleHarness {
  /**
   * The Fastify instance the application is mounted on.
   *
   * A thunk, because a suite builds its server in `beforeAll` while the
   * factory is convenient to build at module scope. Resolving it per request
   * also means a suite that rebuilds its app mid-run does not hand out clients
   * bound to a closed server.
   */
  readonly server: () => FastifyInstance;
  /** Where invite tokens land, since there is no email adapter until M16 (D-057). */
  readonly tokens: { take(email: string): string | undefined };
  readonly appDomain: string;
  readonly origin: string;
  /**
   * A fresh source address per client.
   *
   * `server.inject` gives every request the same socket address, so without
   * this the per-IP bucket on the credential endpoints (D-056) is exhausted by
   * the third user a suite creates — and the failures look like auth bugs
   * rather than like rate limiting.
   */
  nextIp?: () => string;
}

/** Everything a browser carries: cookies in, CSRF header back out. */
export class TestClient {
  private readonly cookies = new Map<string, string>();

  constructor(
    private readonly harness: RoleHarness,
    private readonly ip: string,
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
      // An empty value is a deletion, which is how a sign-out arrives.
      if (value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  cookie(name: string): string | undefined {
    return this.cookies.get(name);
  }

  async request(
    method: string,
    url: string,
    options: { body?: unknown; headers?: Record<string, string> } = {},
    // Annotated rather than inferred: the inferred type names light-my-request's
    // `Response` through a pnpm-hashed path, which is not portable — and adding
    // that package as a direct dependency to name it would be worse.
  ): Promise<{ statusCode: number; body: string; headers: Record<string, unknown> }> {
    const cookie = [...this.cookies].map(([key, value]) => `${key}=${value}`).join('; ');
    const headers: Record<string, string> = {
      host: this.harness.appDomain,
      origin: this.harness.origin,
      'x-forwarded-for': this.ip,
      ...options.headers,
    };
    if (cookie !== '') headers.cookie = cookie;

    // The double-submit token is read by script and echoed as a header, which
    // is what a real client does with it.
    const token = this.cookies.get('elysium_csrf');
    if (token !== undefined) headers['x-elysium-csrf'] = token;
    if (options.body !== undefined) headers['content-type'] = 'application/json';

    const response = await this.harness.server().inject({
      method: method as InjectOptions['method'],
      url,
      headers,
      ...(options.body === undefined ? {} : { payload: JSON.stringify(options.body) }),
    });

    this.absorb(response.headers);
    return response;
  }
}

export interface SignedIn {
  readonly client: TestClient;
  readonly userId: string;
  readonly email: string;
}

/** §6 requires a second factor for these, and the wall blocks everything else. */
const TWO_FACTOR_ROLES: readonly MembershipRole[] = ['org_admin', 'accounts', 'investor'];

/** The password every test user gets, exported so a suite can sign in again. */
export const TEST_PASSWORD = 'correct-horse-battery';

/**
 * Build an `asRole` bound to one running application.
 *
 * Returned as a factory rather than exported as a free function because it
 * needs the server, and a module-level mutable server is how two suites end up
 * sharing one by accident.
 */
export function createRoleFactory(harness: RoleHarness) {
  let counter = 0;
  const nextIp =
    harness.nextIp ??
    (() => {
      counter += 1;
      return `10.3.${String(Math.floor(counter / 256) % 256)}.${String(counter % 256)}`;
    });

  return async function asRole(
    roles: readonly MembershipRole[],
    orgId: string,
    options: { password?: string } = {},
  ): Promise<SignedIn> {
    const password = options.password ?? TEST_PASSWORD;
    const client = new TestClient(harness, nextIp());
    const suffix = randomUUID().slice(0, 8);
    const email = `${roles.join('_')}_${suffix}@example.invalid`;
    const userId = `usr_${randomUUID()}`;

    await withGlobal(async (tx) => {
      await tx.execute(sql`
        insert into iam.users (id, email, name, email_verified)
        values (${userId}, ${email}, ${roles.join(', ')}, true)
      `);
    });

    for (const role of roles) await grantMembership({ userId, orgId, role });

    // Picks up the CSRF cookie the mutations below need.
    await client.request('GET', '/v1/auth/login-branding');

    // Registration is closed (D-057), so the invite flow is the way in: a
    // password reset token stands in for the invite until M16 sends email.
    await client.request('POST', '/api/auth/request-password-reset', {
      body: { email, redirectTo: '/accept-invite' },
    });
    const token = harness.tokens.take(email);
    if (token === undefined) throw new Error(`no invite token was issued for ${email}`);

    await client.request('POST', '/api/auth/reset-password', {
      body: { newPassword: password, token },
    });
    await client.request('POST', '/api/auth/sign-in/email', { body: { email, password } });

    if (roles.some((role) => TWO_FACTOR_ROLES.includes(role))) {
      await clearEnrolmentWall(client, password);
    }

    await client.request('POST', '/v1/me/active-org', { body: { orgId } });
    return { client, userId, email };
  };
}

/**
 * Enrol TOTP and pass it, which is the only way a privileged role gets a usable
 * session (D-051).
 *
 * The secret is decoded from the enrolment URI with Better Auth's own base32
 * rather than a reimplementation, and the code is generated the same way a
 * phone would — so this exercises the real verification path instead of a
 * bypass that would make every later assertion about a privileged role
 * meaningless.
 */
async function clearEnrolmentWall(client: TestClient, password: string): Promise<void> {
  const enabled = await client.request('POST', '/api/auth/two-factor/enable', {
    body: { password, method: 'totp' },
  });

  const parsed = JSON.parse(enabled.body) as { totpURI?: string };
  if (parsed.totpURI === undefined) {
    throw new Error(`two-factor enable did not return a URI: ${enabled.body.slice(0, 200)}`);
  }

  const encoded = new URL(parsed.totpURI).searchParams.get('secret') ?? '';
  const secret = new TextDecoder().decode(base32.decode(encoded));
  const code = await createOTP(secret, { digits: 6, period: 30 }).totp();

  const verified = await client.request('POST', '/api/auth/two-factor/verify-totp', {
    body: { code },
  });
  if (verified.statusCode >= 400) {
    throw new Error(`two-factor verification failed: ${verified.body.slice(0, 200)}`);
  }
}
