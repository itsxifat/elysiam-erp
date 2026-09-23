import { randomUUID } from 'node:crypto';

import { base32 } from '@better-auth/utils/base32';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createAuth,
  mustEnrolTwoFactor,
  RecordingSmsProvider,
  requiresTwoFactor,
} from '../auth/index.js';
import { withGlobal, withOrg, withSystem, withUser } from '../client.js';
import { GENERIC_LOGIN, resolveLoginBranding, slugFromHost } from '../iam/branding.js';
import { availableOrgs, canEnterOrg, resolveContext } from '../iam/context.js';
import { asUser, createTestUser, grantMembership, revokeMembership } from '../iam/fixtures.js';
import { SEED_ORG_IDS } from '../seed/index.js';
import { findTenancyOffenders } from './guard.js';
import { startTestDatabase, stopSharedContainer, type TestDatabase } from './harness.js';

/**
 * Identity, auth and request context (architecture §6, §25 — M02a checks 1-6).
 *
 * The hard part of this milestone is that identity is the one thing that
 * legitimately spans orgs, so every relaxation of M01's isolation has to be
 * exactly as wide as §5 exception 4 says and no wider. Most of what follows is
 * therefore about the *edges* of that exception rather than the happy path.
 */

const ORG_A = SEED_ORG_IDS['elysium-lifestyle-bd'] ?? '';
const ORG_B = SEED_ORG_IDS['oura-lifestyle'] ?? '';
const ORG_C = SEED_ORG_IDS.orvo ?? '';

const APP_DOMAIN = 'erp.example.com';

let database: TestDatabase;
let sms: RecordingSmsProvider;
let authHandle: ReturnType<typeof createAuth>;

/** Invite and reset tokens, since there is no email adapter until M16. */
const issuedTokens = new Map<string, string>();

beforeAll(async () => {
  database = await startTestDatabase('identity');
  // After the harness, so createAuth picks up the throwaway database.
  sms = new RecordingSmsProvider();
  authHandle = createAuth({
    baseUrl: `https://${APP_DOMAIN}`,
    secret: 'test-secret-that-is-at-least-32-characters-long',
    trustedOrigins: [`https://${APP_DOMAIN}`, `https://oura.${APP_DOMAIN}`],
    cookieDomain: `.${APP_DOMAIN}`,
    sms,
    onPasswordToken: ({ email, token }) => {
      issuedTokens.set(email.toLowerCase(), token);
      return Promise.resolve();
    },
    // Off for the shared instance: the suite drives dozens of sign-ins, and
    // throttling them would make every other test flaky for a reason that has
    // nothing to do with what it asserts. Check 5 builds its own instance with
    // limits on.
    rateLimitEnabled: false,
  });
}, 180_000);

afterAll(async () => {
  await authHandle?.close();
  await database?.stop();
  await stopSharedContainer();
}, 60_000);

/** Drive Better Auth's handler directly, without a server in the way. */
async function authRequest(
  path: string,
  init: { body?: unknown; headers?: Record<string, string>; method?: string } = {},
): Promise<Response> {
  return authHandle.auth.handler(
    new Request(`https://${APP_DOMAIN}/api/auth${path}`, {
      method: init.method ?? 'POST',
      headers: {
        'content-type': 'application/json',
        origin: `https://${APP_DOMAIN}`,
        ...init.headers,
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    }),
  );
}

const PASSWORD = 'correct-horse-battery';

/** Better Auth's session cookie, with the __Secure- prefix it adds over https. */
const SESSION_COOKIE = 'better-auth.session_token';

function setCookies(response: Response): string[] {
  return response.headers.getSetCookie();
}

function hasSessionCookie(response: Response): boolean {
  return setCookies(response).some(
    (cookie) => cookie.includes(SESSION_COOKIE) && !cookie.includes(`${SESSION_COOKIE}=;`),
  );
}

/**
 * The smallest cookie jar that is still honest.
 *
 * The 2FA flow spans four requests and three different cookies (session,
 * two-factor challenge, dont-remember), and asserting on the wrong one would
 * make the test pass for the wrong reason. So carry them all, the way a browser
 * would, rather than hand-picking one.
 */
class CookieJar {
  private readonly cookies = new Map<string, string>();

  absorb(response: Response): void {
    for (const raw of setCookies(response)) {
      const pair = raw.split(';')[0] ?? '';
      const index = pair.indexOf('=');
      if (index <= 0) continue;
      const name = pair.slice(0, index);
      const value = pair.slice(index + 1);
      if (value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  header(): string {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }
}

/**
 * Create a user with a usable password, the way the product now does.
 *
 * Self-service registration is closed (`disableSignUp`), because this is a
 * staff ERP and an open sign-up was the enabling half of an account
 * pre-hijacking attack. So a user is created directly and its credential comes
 * from redeeming the invite token Better Auth mints — the same two steps
 * `POST /v1/users` performs.
 */
async function createSignInableUser(email: string): Promise<string> {
  const id = `usr_${randomUUID()}`;

  await withGlobal(async (tx) => {
    await tx.execute(sql`
      insert into iam.users (id, email, name, email_verified)
      values (${id}, ${email}, ${email}, true)
    `);
  });

  const requested = await authRequest('/request-password-reset', {
    body: { email, redirectTo: '/accept-invite' },
  });
  expect(requested.status, await requested.clone().text()).toBeLessThan(400);

  const token = issuedTokens.get(email.toLowerCase());
  expect(token, `no invite token was issued for ${email}`).toBeDefined();

  const reset = await authRequest('/reset-password', {
    body: { newPassword: PASSWORD, token },
  });
  expect(reset.status, await reset.clone().text()).toBeLessThan(400);

  return id;
}

/**
 * A current TOTP code for an enrolment URI.
 *
 * Through Better Auth's own server-only generator rather than a hand-rolled
 * RFC 6238 implementation: a reimplementation would only prove that my code and
 * my test agree with each other.
 */
async function totpCode(totpURI: string): Promise<string> {
  const encoded = new URL(totpURI).searchParams.get('secret') ?? '';
  if (encoded === '') throw new Error('no secret in the TOTP URI');

  // The URI carries base32, because that is what an authenticator app reads;
  // the server-side generator wants the raw secret behind it. Decoding with
  // Better Auth's own base32 rather than a hand-rolled one keeps this test an
  // authenticator app, not a second implementation of the algorithm.
  const secret = new TextDecoder().decode(base32.decode(encoded));
  const { code } = await authHandle.auth.api.generateTOTP({ body: { secret } });
  return code;
}

describe('the iam schema keeps M01 honest', () => {
  it('adds no unguarded table', async () => {
    // Five of iam's tables are global by design (§5 exception 4). The guard is
    // opt-out, so they only pass because they were declared — which is exactly
    // the review step that declaration exists to force.
    const offenders = await findTenancyOffenders();
    expect(offenders.map((o) => `${o.schema}.${o.table}: ${o.reasons.join('; ')}`)).toEqual([]);
  });

  it('isolates memberships by org like any other tenant table', async () => {
    const insider = await createTestUser();
    const outsider = await createTestUser();
    await grantMembership({ userId: insider.id, orgId: ORG_B, role: 'sales' });

    // Acting in org A, a different user's org B membership is invisible.
    const seen = await withOrg({ orgId: ORG_A, userId: outsider.id }, async (tx) =>
      tx.execute<{ user_id: string }>(sql`select user_id from iam.memberships`),
    );

    expect([...seen].some((row) => row.user_id === insider.id)).toBe(false);
  });

  it("lets a user see their OWN memberships across orgs, and nobody else's", async () => {
    // The self policy (D-050). This is the one deliberate cross-org read in
    // the whole schema, so it gets the adversarial treatment: the same query
    // that returns your rows must return none of anyone else's.
    const mine = await createTestUser();
    const theirs = await createTestUser();

    await grantMembership({ userId: mine.id, orgId: ORG_A, role: 'sales' });
    await grantMembership({ userId: mine.id, orgId: ORG_B, role: 'accounts' });
    await grantMembership({ userId: theirs.id, orgId: ORG_A, role: 'sales' });
    await grantMembership({ userId: theirs.id, orgId: ORG_B, role: 'sales' });

    const rows = await withUser({ userId: mine.id }, async (tx) =>
      tx.execute<{ user_id: string; org_id: string }>(
        sql`select user_id, org_id from iam.memberships`,
      ),
    );

    const users = [...new Set([...rows].map((row) => row.user_id))];
    expect(users, 'the self policy must return only the acting user').toEqual([mine.id]);
    expect([...new Set([...rows].map((row) => row.org_id))].sort()).toEqual([ORG_A, ORG_B].sort());
  });

  it('does not let the self policy become a write', async () => {
    // `for select` only. If it were widened, a user could grant themselves a
    // membership in any org.
    const user = await createTestUser();

    let failed = false;
    try {
      await withUser({ userId: user.id }, async (tx) => {
        await tx.execute(
          sql`insert into iam.memberships (org_id, user_id, role) values (${ORG_C}, ${user.id}, 'org_admin')`,
        );
      });
    } catch {
      failed = true;
    }

    expect(failed, 'a user must not be able to grant themselves a membership').toBe(true);
  });
});

describe('check 2: switching org changes the visible rows and the effective roles', () => {
  it('returns different roles per org for the same user', async () => {
    const user = await createTestUser();
    await grantMembership({ userId: user.id, orgId: ORG_A, role: 'sales' });
    await grantMembership({ userId: user.id, orgId: ORG_B, role: 'accounts' });

    const inA = await asUser(user.id, ORG_A);
    const inB = await asUser(user.id, ORG_B);

    expect(inA.roles).toEqual(['sales']);
    expect(inB.roles).toEqual(['accounts']);
    expect(inA.orgId).toBe(ORG_A);
    expect(inB.orgId).toBe(ORG_B);
  });

  it('changes the rows RLS lets through, not only the role label', async () => {
    const user = await createTestUser();
    await grantMembership({ userId: user.id, orgId: ORG_A, role: 'sales' });
    await grantMembership({ userId: user.id, orgId: ORG_B, role: 'sales' });

    const branchesIn = async (orgId: string) =>
      withOrg({ orgId, userId: user.id }, async (tx) =>
        tx.execute<{ org_id: string }>(sql`select org_id from org.branches`),
      );

    const a = [...new Set([...(await branchesIn(ORG_A))].map((r) => r.org_id))];
    const b = [...new Set([...(await branchesIn(ORG_B))].map((r) => r.org_id))];

    expect(a).toEqual([ORG_A]);
    expect(b).toEqual([ORG_B]);
  });

  it('refuses an org the user holds no membership in', async () => {
    const user = await createTestUser();
    await grantMembership({ userId: user.id, orgId: ORG_A, role: 'sales' });

    expect(await canEnterOrg(user.id, ORG_A)).toBe(true);
    expect(await canEnterOrg(user.id, ORG_C)).toBe(false);
    expect(await resolveContext({ userId: user.id, orgId: ORG_C, requestId: 'r' })).toBeNull();
  });

  it('stops honouring a membership the moment it is revoked', async () => {
    // A session outlives a membership change, so entitlement is re-read per
    // request rather than trusted from the session.
    const user = await createTestUser();
    const membershipId = await grantMembership({
      userId: user.id,
      orgId: ORG_A,
      role: 'sales',
    });

    expect(await canEnterOrg(user.id, ORG_A)).toBe(true);
    await revokeMembership(membershipId, ORG_A);
    expect(await canEnterOrg(user.id, ORG_A)).toBe(false);
  });

  it('lists exactly the orgs a user may enter', async () => {
    const user = await createTestUser();
    await grantMembership({ userId: user.id, orgId: ORG_A, role: 'sales' });
    await grantMembership({ userId: user.id, orgId: ORG_C, role: 'warehouse' });

    const orgs = await availableOrgs(user.id);
    expect(orgs.map((o) => o.orgId).sort()).toEqual([ORG_A, ORG_C].sort());
  });

  it('gives a super admin every org without a membership row', async () => {
    const root = await createTestUser({ isSuperAdmin: true });
    const orgs = await availableOrgs(root.id);
    expect(orgs.length).toBeGreaterThanOrEqual(5);
  });

  it('gives a deactivated user nothing, whatever their memberships say', async () => {
    const user = await createTestUser();
    await grantMembership({ userId: user.id, orgId: ORG_A, role: 'sales' });
    await withSystem(async (tx) => {
      await tx.execute(sql`update iam.users set is_active = false where id = ${user.id}`);
    });

    expect(await availableOrgs(user.id)).toEqual([]);
    expect(await resolveContext({ userId: user.id, orgId: ORG_A, requestId: 'r' })).toBeNull();
  });

  it('records branch scope, with empty meaning the whole org', async () => {
    const [branch] = await withSystem(
      async (tx) => tx.execute<{ id: string }>(sql`select id from org.branches limit 1`),
      { orgId: ORG_A },
    );

    const scoped = await createTestUser();
    await grantMembership({
      userId: scoped.id,
      orgId: ORG_A,
      role: 'branch_manager',
      branchIds: [branch?.id ?? ''],
    });

    const unscoped = await createTestUser();
    await grantMembership({ userId: unscoped.id, orgId: ORG_A, role: 'org_admin' });

    expect((await asUser(scoped.id, ORG_A)).branchIds).toEqual([branch?.id]);
    // Empty is "the whole org", not "no branches" — M02b enforces the
    // difference, and getting it backwards would silently hide everything.
    expect((await asUser(unscoped.id, ORG_A)).branchIds).toEqual([]);
  });
});

describe('check 3: branded login resolves an org from the host', () => {
  it.each([
    ['oura.erp.example.com', 'oura'],
    ['OURA.ERP.EXAMPLE.COM', 'oura'],
    ['oura.erp.example.com:5173', 'oura'],
  ])('reads the org label out of %s', (host, expected) => {
    expect(slugFromHost(host, APP_DOMAIN)).toBe(expected);
  });

  it.each([
    ['erp.example.com', 'the bare apex is the generic login'],
    ['www.erp.example.com', 'www is not an org'],
    ['a.b.erp.example.com', 'two labels is a mistake, not an org'],
    ['erp.example.com.evil.test', 'a suffix attack must not match'],
    ['', 'no host at all'],
  ])('treats %s as generic: %s', (host) => {
    expect(slugFromHost(host, APP_DOMAIN)).toBeNull();
  });

  it('preselects the org and carries its branding', async () => {
    const branding = await resolveLoginBranding({
      host: `oura-lifestyle.${APP_DOMAIN}`,
      appDomain: APP_DOMAIN,
    });

    expect(branding.generic).toBe(false);
    expect(branding.orgId).toBe(ORG_B);
    expect(branding.slug).toBe('oura-lifestyle');
    // D-034: the accent the console themes itself with.
    expect(branding.brand).toHaveProperty('accent');
  });

  it('falls back to the generic login for an unknown host', async () => {
    // A misconfigured DNS record should not mean nobody can sign in.
    expect(
      await resolveLoginBranding({ host: `nope.${APP_DOMAIN}`, appDomain: APP_DOMAIN }),
    ).toEqual(GENERIC_LOGIN);
    expect(await resolveLoginBranding({ host: APP_DOMAIN, appDomain: APP_DOMAIN })).toEqual(
      GENERIC_LOGIN,
    );
  });
});

describe('check 1: 2FA is required for privileged roles', () => {
  it('names the roles §6 requires it for', () => {
    expect(requiresTwoFactor(['sales'], false)).toBe(false);
    expect(requiresTwoFactor(['warehouse'], false)).toBe(false);
    expect(requiresTwoFactor(['accounts'], false)).toBe(true);
    expect(requiresTwoFactor(['org_admin'], false)).toBe(true);
    expect(requiresTwoFactor(['investor'], false)).toBe(true);
    // A super admin is privileged by definition, with or without a membership.
    expect(requiresTwoFactor([], true)).toBe(true);
  });

  it('issues a session to an unprivileged user without a second factor', async () => {
    // The positive control. "Cannot sign in without 2FA" would pass just as
    // happily if sign-in were broken outright, so prove it works first.
    const email = `sales_${Date.now()}@example.invalid`;
    const userId = await createSignInableUser(email);
    await grantMembership({ userId, orgId: ORG_A, role: 'sales' });

    const signIn = await authRequest('/sign-in/email', {
      body: { email, password: 'correct-horse-battery' },
    });
    expect(signIn.status).toBeLessThan(400);
    expect(signIn.headers.get('set-cookie')).toBeTruthy();
  });

  it('lets a privileged role hold a session, but walls it until enrolment', async () => {
    // This used to be "refuses the session outright", and that deadlocked the
    // product: enrolling TOTP runs behind Better Auth's sessionMiddleware, so
    // a brand-new org_admin could never enrol and therefore never sign in.
    //
    // Section 6 is enforced instead as a wall on the request path. The session
    // is real; it is simply good for nothing but enrolling.
    const email = `accounts_${Date.now()}@example.invalid`;
    const userId = await createSignInableUser(email);
    await grantMembership({ userId, orgId: ORG_A, role: 'accounts' });

    const signIn = await authRequest('/sign-in/email', { body: { email, password: PASSWORD } });
    expect(signIn.status, 'the enrolment session must be issuable').toBeLessThan(400);

    expect(
      await mustEnrolTwoFactor(userId),
      'accounts must be walled until a second factor exists',
    ).toBe(true);
  });
});

describe('check 1 addendum: the wall must not fail open', () => {
  it('walls a super admin who holds no membership at all', async () => {
    // The check used to read memberships on a connection with no RLS context,
    // so it saw zero rows and concluded "not privileged" for everyone - a
    // security control failing open. A super admin has no membership row by
    // design, so this is the case that would still pass even if the membership
    // lookup silently returned nothing.
    const email = `root_${Date.now()}@example.invalid`;
    const userId = await createSignInableUser(email);
    await withSystem(async (tx) => {
      await tx.execute(sql`update iam.users set is_super_admin = true where id = ${userId}`);
    });

    expect(await mustEnrolTwoFactor(userId)).toBe(true);
  });

  it('does not wall an unprivileged user, so it is not simply refusing everyone', async () => {
    const email = `warehouse_${Date.now()}@example.invalid`;
    const userId = await createSignInableUser(email);
    await grantMembership({ userId, orgId: ORG_A, role: 'warehouse' });

    expect(await mustEnrolTwoFactor(userId)).toBe(false);

    const signIn = await authRequest('/sign-in/email', { body: { email, password: PASSWORD } });
    expect(signIn.status).toBeLessThan(400);
  });

  it('walls a user the moment a privileged role is granted, not at next sign-in', async () => {
    const email = `promoted_${Date.now()}@example.invalid`;
    const userId = await createSignInableUser(email);
    await grantMembership({ userId, orgId: ORG_A, role: 'sales' });
    expect(await mustEnrolTwoFactor(userId)).toBe(false);

    await grantMembership({ userId, orgId: ORG_B, role: 'org_admin' });
    expect(await mustEnrolTwoFactor(userId), 'the wall reads live, not cached').toBe(true);
  });

  it('stops counting a revoked privileged role', async () => {
    const email = `demoted_${Date.now()}@example.invalid`;
    const userId = await createSignInableUser(email);
    await grantMembership({ userId, orgId: ORG_A, role: 'sales' });
    const investor = await grantMembership({ userId, orgId: ORG_B, role: 'investor' });
    expect(await mustEnrolTwoFactor(userId)).toBe(true);

    await revokeMembership(investor, ORG_B);
    expect(await mustEnrolTwoFactor(userId)).toBe(false);
  });

  it('fails closed on an unknown user id', async () => {
    expect(await mustEnrolTwoFactor(`usr_${randomUUID()}`)).toBe(true);
  });
});

describe('check 1: enrolment and recovery codes', () => {
  /**
   * The whole second-factor lifecycle, end to end, for a role that requires it.
   *
   * Written as one test on purpose: every step depends on the state the
   * previous one left behind - a secret, a set of codes, a session - and
   * splitting it would mean either re-running the whole flow four times or
   * sharing mutable state between tests that vitest may reorder.
   */
  it('enrols TOTP, then demands it at sign-in, then accepts a recovery code once', async () => {
    const email = `twofactor_${Date.now()}@example.invalid`;

    const userId = await createSignInableUser(email);
    await grantMembership({ userId, orgId: ORG_A, role: 'org_admin' });

    expect(await mustEnrolTwoFactor(userId), 'walled before enrolment').toBe(true);

    // 1. The enrolment session.
    const jar = new CookieJar();
    const signIn = await authRequest('/sign-in/email', { body: { email, password: PASSWORD } });
    jar.absorb(signIn);
    expect(jar.header(), 'enrolment needs a session cookie').not.toHaveLength(0);

    // 2. Enrol. Returns the secret as a URI plus the recovery codes, which are
    //    shown exactly once - this response is the only time they exist in
    //    plaintext.
    const enable = await authRequest('/two-factor/enable', {
      body: { password: PASSWORD, method: 'totp' },
      headers: { cookie: jar.header() },
    });
    expect(enable.status, await enable.clone().text()).toBeLessThan(400);
    const enrolment = (await enable.json()) as { totpURI: string; backupCodes: string[] };
    jar.absorb(enable);

    expect(enrolment.backupCodes, 'ten recovery codes, per createAuth()').toHaveLength(10);
    expect(new Set(enrolment.backupCodes).size, 'and all distinct').toBe(10);

    // 3. Still walled: a secret nobody has proved they hold is not a factor.
    expect(
      await mustEnrolTwoFactor(userId),
      'enable alone must not lift the wall - verification does',
    ).toBe(true);

    // 4. Prove possession. `generateTOTP` is Better Auth's own server-side code
    //    generator, so this asserts against the library's algorithm rather than
    //    a reimplementation of it that could agree with a bug.
    const verify = await authRequest('/two-factor/verify-totp', {
      body: { code: await totpCode(enrolment.totpURI) },
      headers: { cookie: jar.header() },
    });
    expect(verify.status, await verify.clone().text()).toBeLessThan(400);
    jar.absorb(verify);

    expect(await mustEnrolTwoFactor(userId), 'the wall lifts once verified').toBe(false);

    // 5. Now the factor is demanded. A correct password alone yields no
    //    session, only a redirect to the second step.
    const secondLogin = await authRequest('/sign-in/email', {
      body: { email, password: PASSWORD },
    });
    expect(secondLogin.status).toBeLessThan(400);
    const redirect = (await secondLogin.clone().json()) as { twoFactorRedirect?: boolean };
    expect(redirect.twoFactorRedirect, 'password alone must not be enough').toBe(true);
    expect(hasSessionCookie(secondLogin), 'no session cookie before the second factor').toBe(false);

    // 6. The second factor completes it.
    const pending = new CookieJar();
    pending.absorb(secondLogin);
    const totpLogin = await authRequest('/two-factor/verify-totp', {
      body: { code: await totpCode(enrolment.totpURI) },
      headers: { cookie: pending.header() },
    });
    expect(totpLogin.status, await totpLogin.clone().text()).toBeLessThan(400);
    expect(hasSessionCookie(totpLogin), 'a verified second factor issues the session').toBe(true);

    // 7. Recovery: a lost authenticator must not mean a lost account.
    const thirdLogin = await authRequest('/sign-in/email', { body: { email, password: PASSWORD } });
    const recovery = new CookieJar();
    recovery.absorb(thirdLogin);

    const code = enrolment.backupCodes[0] ?? '';
    const used = await authRequest('/two-factor/verify-backup-code', {
      body: { code },
      headers: { cookie: recovery.header() },
    });
    expect(used.status, await used.clone().text()).toBeLessThan(400);
    expect(hasSessionCookie(used), 'a recovery code issues the session').toBe(true);

    // 8. And exactly once. A reusable recovery code is a password that never
    //    expires and is written on a piece of paper.
    const fourthLogin = await authRequest('/sign-in/email', {
      body: { email, password: PASSWORD },
    });
    const replay = new CookieJar();
    replay.absorb(fourthLogin);

    const reused = await authRequest('/two-factor/verify-backup-code', {
      body: { code },
      headers: { cookie: replay.header() },
    });
    expect(reused.status, 'a recovery code must be single use').toBeGreaterThanOrEqual(400);
  }, 60_000);
});

describe('self-service registration is closed', () => {
  it('refuses an anonymous sign-up', async () => {
    // This is a staff ERP: nobody outside it should be able to create an
    // account. It was open, and that was the enabling half of an account
    // pre-hijacking attack — register the address of a person about to be
    // hired, and the invite attaches their role to your password.
    const response = await authRequest('/sign-up/email', {
      body: {
        email: `outsider_${Date.now()}@example.invalid`,
        password: PASSWORD,
        name: 'Outsider',
      },
    });

    expect(response.status, await response.clone().text()).toBeGreaterThanOrEqual(400);
  });
});

describe('phone OTP goes through the SMS provider (D-012)', () => {
  it('sends a code, and the code verifies', async () => {
    // The fake provider had no functional test at all: nothing asserted a code
    // was ever issued, was the configured length, or could be verified. The
    // only test touching the OTP path was the rate-limit hammer, and the
    // limiter runs before the handler — so it would have passed just as well
    // if sending threw on every call.
    const phoneNumber = `+88017${String(Date.now()).slice(-8)}`;
    const email = `otp_${Date.now()}@example.invalid`;
    const userId = await createSignInableUser(email);

    await withGlobal(async (tx) => {
      await tx.execute(
        sql`update iam.users set phone_number = ${phoneNumber}, phone_number_verified = true where id = ${userId}`,
      );
    });
    sms.clear();

    const sent = await authRequest('/phone-number/send-otp', { body: { phoneNumber } });
    expect(sent.status, await sent.clone().text()).toBeLessThan(400);

    const code = sms.lastCodeFor(phoneNumber);
    expect(code, 'no OTP reached the provider').toBeDefined();
    expect(code).toMatch(/^\d{6}$/);

    const verified = await authRequest('/phone-number/verify', {
      body: { phoneNumber, code },
    });
    expect(verified.status, await verified.clone().text()).toBeLessThan(400);
  });

  it('never logs the code beside the number it belongs to (invariant 10)', async () => {
    // A one-time code next to the phone it was sent to is exactly the pair
    // that must not reach a log. The provider records the message, and the
    // number, but never writes them out together.
    const phoneNumber = '+8801700000001';
    sms.clear();
    await sms.send(phoneNumber, 'Your Elysium verification code is 123456');

    expect(sms.lastCodeFor(phoneNumber)).toBe('123456');
    expect(sms.sent.some((entry) => entry.message.includes(phoneNumber))).toBe(false);
  });
});

describe('check 4: the session cookie is scoped correctly', () => {
  it('is httpOnly, Secure, SameSite=Lax and on the parent domain', async () => {
    const email = `cookie_${Date.now()}@example.invalid`;
    await createSignInableUser(email);
    const response = await authRequest('/sign-in/email', {
      body: { email, password: PASSWORD },
    });

    // The session cookie specifically, picked out of `getSetCookie()`.
    // `headers.get('set-cookie')` joins every Set-Cookie header into one
    // string, so four independent `toMatch`es over the concatenation would
    // pass with HttpOnly coming from one cookie and Domain from another.
    const cookie = setCookies(response).find((entry) => entry.includes(SESSION_COOKIE)) ?? '';
    expect(cookie, 'no session cookie was set').not.toBe('');
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/i);
    // Lax rather than Strict: the console runs inside a Chatwoot iframe on the
    // same parent domain, and Strict would drop the cookie there (§16).
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(new RegExp(`Domain=\\.?${APP_DOMAIN.replace(/\./g, '\\.')}`, 'i'));
  });
});

describe("check 5 (library half): Better Auth's own limiter is still on", () => {
  /*
   * This proves only that *a* bucket fills. It cannot prove the per-identifier
   * half, because Better Auth keys on `${ip}|${path}` and, under vitest, its
   * `getIP` returns 127.0.0.1 for every request — so all of these land in one
   * bucket and the assertion would pass identically against a single global
   * counter.
   *
   * The real check 5 lives in apps/server: `rate-limit.test.ts` for the two
   * buckets in isolation, and `http-surface.test.ts` for the 429 over HTTP with
   * the address and the identifier varied independently. What is left here is
   * the statement that the library's limiter has not been switched off
   * underneath ours.
   */
  /** Its own instance, with limits on, so the rest of the suite is unthrottled. */
  function limitedAuth() {
    return createAuth({
      baseUrl: `https://${APP_DOMAIN}`,
      secret: 'test-secret-that-is-at-least-32-characters-long',
      trustedOrigins: [`https://${APP_DOMAIN}`],
      cookieDomain: `.${APP_DOMAIN}`,
      sms,
      onPasswordToken: ({ email, token }) => {
        issuedTokens.set(email.toLowerCase(), token);
        return Promise.resolve();
      },
      rateLimitEnabled: true,
    });
  }

  async function hammer(handle: ReturnType<typeof createAuth>, path: string, body: unknown) {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const response = await handle.auth.handler(
        new Request(`https://${APP_DOMAIN}/api/auth${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: `https://${APP_DOMAIN}` },
          body: JSON.stringify(body),
        }),
      );
      statuses.push(response.status);
      if (response.status === 429) break;
    }
    return statuses;
  }

  it('returns 429 once the login threshold is passed', async () => {
    const handle = limitedAuth();
    try {
      const statuses = await hammer(handle, '/sign-in/email', {
        email: `ratelimit_${Date.now()}@example.invalid`,
        password: 'definitely-wrong-password',
      });
      expect(statuses, `saw ${statuses.join(',')}`).toContain(429);
    } finally {
      await handle.close();
    }
  });

  it('rate limits OTP requests too, which are the cheaper thing to abuse', async () => {
    const handle = limitedAuth();
    try {
      const statuses = await hammer(handle, '/phone-number/send-otp', {
        phoneNumber: '+8801700000000',
      });
      expect(statuses, `saw ${statuses.join(',')}`).toContain(429);
    } finally {
      await handle.close();
    }
  });
});

describe('check 6: cookie-authenticated mutations need a matching origin', () => {
  it('rejects a mutation from an untrusted origin', async () => {
    // Better Auth checks Origin against trustedOrigins. The double-submit token
    // is layered on top of this in the server middleware (apps/server), which
    // M02b's route guard then rides on.
    const response = await authHandle.auth.handler(
      new Request(`https://${APP_DOMAIN}/api/auth/sign-in/email`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://evil.test' },
        body: JSON.stringify({ email: 'x@example.invalid', password: 'whatever-it-is' }),
      }),
    );

    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it('accepts one from a trusted origin', async () => {
    const response = await authHandle.auth.handler(
      new Request(`https://${APP_DOMAIN}/api/auth/sign-in/email`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: `https://oura.${APP_DOMAIN}` },
        body: JSON.stringify({ email: 'x@example.invalid', password: 'whatever-it-is' }),
      }),
    );

    // Wrong credentials, so 401 — but not an origin rejection.
    expect(response.status).not.toBe(403);
  });
});
