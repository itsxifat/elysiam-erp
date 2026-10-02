import { base32 } from '@better-auth/utils/base32';
import type { MembershipRole } from '@elysium/contracts';
import { withGlobal, withOrg, withSystem } from '@elysium/db';
import { createTestUser, grantMembership } from '@elysium/db/testing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  auditRowsFor,
  createBranch,
  expectRefused,
  ORG_A,
  ORG_B,
  PASSWORD,
  startHttpHarness,
  type Client,
  type HttpHarness,
  type InjectedResponse,
  type RoleClient,
} from '../../testing/http-harness.js';

/**
 * The staff screen's API against real Postgres (gaps-users-auth, D-400 to D-409).
 *
 * Every rule about whose access an admin may change is exercised from both sides: the
 * case the rule allows, so the refusal is not just "everything is refused", and the case
 * it refuses. Sign-in outcomes are asserted by signing in for real, through Better Auth,
 * the CSRF check and the enrolment wall, because "the account is deactivated" means
 * nothing until the person actually cannot get back in.
 */

let harness: HttpHarness;
let admin: RoleClient;
let admin2: RoleClient;
let superAdmin: { client: Client; userId: string };

const NEW_PASSWORD = 'a-brand-new-passphrase';

beforeAll(async () => {
  harness = await startHttpHarness('users');
  admin = await harness.asRole('org_admin', ORG_A);
  admin2 = await harness.asRole('org_admin', ORG_A);

  // A platform super admin, with no membership anywhere: made by the owner role only.
  const root = await createTestUser({ name: 'Root', isSuperAdmin: true });
  await setPasswordFor(root.email);
  const signedIn = await signIn(root.email);
  await enrol(signedIn.client);
  const entered = await signedIn.client.request('POST', '/v1/me/active-org', {
    body: { orgId: ORG_A },
  });
  expect(entered.statusCode, entered.body).toBe(201);
  superAdmin = { client: signedIn.client, userId: root.id };
}, 300_000);

afterAll(async () => {
  await harness?.close();
}, 60_000);

// --- helpers ---------------------------------------------------------------------------

function json<T>(response: InjectedResponse): T {
  return JSON.parse(response.body) as T;
}

/** Set a password through Better Auth's own reset, from the server (D-402). */
async function setPasswordFor(email: string, password: string = PASSWORD): Promise<void> {
  await harness.auth.auth.api.requestPasswordReset({
    body: { email, redirectTo: '/accept-invite' },
    headers: new Headers(),
  });
  const token = harness.tokens.take(email);
  if (token === undefined) throw new Error(`no token for ${email}`);
  await harness.auth.auth.api.resetPassword({ body: { newPassword: password, token } });
}

async function signIn(
  email: string,
  password: string = PASSWORD,
): Promise<{ client: Client; response: InjectedResponse }> {
  const client = harness.client();
  await client.request('GET', '/v1/auth/login-branding');
  const response = await client.request('POST', '/api/auth/sign-in/email', {
    body: { email, password },
  });
  return { client, response };
}

/** Enrol TOTP the way the console does, and verify it. */
async function enrol(client: Client): Promise<void> {
  const enabled = await client.request('POST', '/api/auth/two-factor/enable', {
    body: { password: PASSWORD, method: 'totp' },
  });
  expect(enabled.statusCode, enabled.body).toBe(200);
  const { totpURI } = json<{ totpURI: string }>(enabled);
  const secret = new TextDecoder().decode(
    base32.decode(new URL(totpURI).searchParams.get('secret') ?? ''),
  );
  const { code } = await harness.auth.auth.api.generateTOTP({ body: { secret } });
  const verified = await client.request('POST', '/api/auth/two-factor/verify-totp', {
    body: { code },
  });
  expect(verified.statusCode, verified.body).toBe(200);
}

interface Member {
  readonly userId: string;
  readonly email: string;
}

/** A person with roles in a brand, optionally with a password already set. */
async function member(
  roles: readonly MembershipRole[],
  options: {
    readonly orgId?: string;
    readonly password?: boolean;
    readonly alsoIn?: { orgId: string; role: MembershipRole };
    readonly twoFactorEnabled?: boolean;
  } = {},
): Promise<Member> {
  const user = await createTestUser({
    name: `Staff ${roles.join('+')}`,
    ...(options.twoFactorEnabled === undefined
      ? {}
      : { twoFactorEnabled: options.twoFactorEnabled }),
  });
  for (const role of roles) {
    await grantMembership({ userId: user.id, orgId: options.orgId ?? ORG_A, role });
  }
  if (options.alsoIn !== undefined) {
    await grantMembership({
      userId: user.id,
      orgId: options.alsoIn.orgId,
      role: options.alsoIn.role,
    });
  }
  if (options.password !== false) await setPasswordFor(user.email);
  return { userId: user.id, email: user.email };
}

/** Signed in and switched into a brand, for someone with no second factor owed. */
async function session(person: Member, orgId: string = ORG_A): Promise<Client> {
  const { client, response } = await signIn(person.email);
  expect(response.statusCode, response.body).toBe(200);
  const entered = await client.request('POST', '/v1/me/active-org', { body: { orgId } });
  expect(entered.statusCode, entered.body).toBe(201);
  return client;
}

async function grantedBy(userId: string, orgId: string = ORG_A): Promise<(string | null)[]> {
  const rows = await withSystem(
    async (tx) =>
      tx.execute<{ granted_by: string | null }>(sql`
        select granted_by from iam.memberships
        where org_id = ${orgId} and user_id = ${userId} and is_active
      `),
    { orgId },
  );
  return [...rows].map((row) => row.granted_by);
}

async function decide(
  checker: Client,
  approvalId: string,
  decision: 'approved' | 'rejected',
): Promise<InjectedResponse> {
  return checker.request('POST', `/v1/approvals/${approvalId}/decide`, { body: { decision } });
}

async function redeem(token: string, password: string = NEW_PASSWORD): Promise<InjectedResponse> {
  const client = harness.client();
  await client.request('GET', '/v1/auth/login-branding');
  return client.request('POST', '/api/auth/reset-password', {
    body: { newPassword: password, token },
  });
}

interface StaffRow {
  userId: string;
  status: string;
  roles: { role: string; branchIds: string[] }[];
  twoFactorEnabled: boolean;
  lastSignInAt: string | null;
  hasPassword: boolean;
  linkExpiresAt: string | null;
  inOtherBrand: boolean;
  isSelf: boolean;
  resetNeedsApproval: boolean;
}

async function staff(client: Client = admin.client): Promise<{
  items: StaffRow[];
  resets: { id: string; userId: string; kind: string; status: string; mine: boolean }[];
}> {
  const listed = await client.request('GET', '/v1/users');
  expect(listed.statusCode, listed.body).toBe(200);
  return json(listed);
}

// --- the list ----------------------------------------------------------------------------

describe('GET /v1/users', () => {
  it("lists this brand's people with their roles and sign-in state, and nobody else's", async () => {
    const here = await member(['sales']);
    const invited = await member(['warehouse'], { password: false });
    const elsewhere = await member(['sales'], { orgId: ORG_B });
    const signedIn = await session(here);
    expect((await signedIn.request('GET', '/v1/me')).statusCode).toBe(200);

    const { items } = await staff();
    const row = items.find((item) => item.userId === here.userId);
    expect(row).toMatchObject({
      status: 'active',
      roles: [{ role: 'sales', branchIds: [] }],
      hasPassword: true,
      isSelf: false,
      resetNeedsApproval: false,
    });
    expect(row?.lastSignInAt).not.toBeNull();
    expect(items.find((item) => item.userId === invited.userId)?.status).toBe('invited');
    expect(items.some((item) => item.userId === elsewhere.userId)).toBe(false);
    expect(items.find((item) => item.userId === admin.userId)).toMatchObject({
      isSelf: true,
      twoFactorEnabled: true,
      resetNeedsApproval: true,
    });
  });

  it('is refused to every role but org_admin', async () => {
    const sales = await harness.asRole('sales', ORG_A);
    const accounts = await harness.asRole('accounts', ORG_A);
    expect((await sales.client.request('GET', '/v1/users')).statusCode).toBe(403);
    expect((await accounts.client.request('GET', '/v1/users')).statusCode).toBe(403);
  });
});

// --- roles ---------------------------------------------------------------------------------

describe('PUT /v1/users/:id/roles', () => {
  it('replaces roles and branch scope, takes effect at once, and records the admin as granter', async () => {
    const person = await member(['sales']);
    const client = await session(person);
    const branch = await createBranch(ORG_A, `U${Date.now().toString(36).slice(-5)}`);

    const changed = await admin.client.request('PUT', `/v1/users/${person.userId}/roles`, {
      body: {
        roles: [
          { role: 'warehouse', branchIds: [] },
          { role: 'branch_manager', branchIds: [branch] },
        ],
      },
    });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(json<StaffRow>(changed).roles).toEqual([
      { role: 'branch_manager', branchIds: [branch] },
      { role: 'warehouse', branchIds: [] },
    ]);

    // The same session, its next request: no sign-in needed for the change to apply.
    const me = json<{ roles: string[]; branchIds: string[] }>(
      await client.request('GET', '/v1/me'),
    );
    expect([...me.roles].sort()).toEqual(['branch_manager', 'warehouse']);
    expect(me.branchIds).toEqual([branch]);
    expect(await grantedBy(person.userId)).toEqual([admin.userId, admin.userId]);

    const audit = await auditRowsFor(ORG_A, person.userId);
    expect(audit.some((row) => row.action === 'iam.roles_changed')).toBe(true);
  });

  it('refuses a change to your own roles, so an admin cannot widen or keep their own access', async () => {
    const own = await admin.client.request('PUT', `/v1/users/${admin.userId}/roles`, {
      body: {
        roles: [
          { role: 'org_admin', branchIds: [] },
          { role: 'accounts', branchIds: [] },
        ],
      },
    });
    expect(own.statusCode).toBe(403);
    expect(json<{ code: string }>(own).code).toBe('USER_SELF_MANAGEMENT');
  });

  it('refuses a sales user changing anyone, themselves included', async () => {
    const sales = await harness.asRole('sales', ORG_A);
    const self = await sales.client.request('PUT', `/v1/users/${sales.userId}/roles`, {
      body: { roles: [{ role: 'org_admin', branchIds: [] }] },
    });
    expect(self.statusCode).toBe(403);
    expect(await grantedBy(sales.userId)).toHaveLength(1);
  });

  it("answers 404 for another brand's person, and refuses another brand's branch", async () => {
    const elsewhere = await member(['sales'], { orgId: ORG_B });
    const foreign = await admin.client.request('PUT', `/v1/users/${elsewhere.userId}/roles`, {
      body: { roles: [{ role: 'warehouse', branchIds: [] }] },
    });
    expect(foreign.statusCode).toBe(404);

    const person = await member(['sales']);
    const otherBranch = await createBranch(ORG_B, `X${Date.now().toString(36).slice(-5)}`);
    const wrongBranch = await admin.client.request('PUT', `/v1/users/${person.userId}/roles`, {
      body: { roles: [{ role: 'branch_manager', branchIds: [otherBranch] }] },
    });
    expect(wrongBranch.statusCode).toBe(400);
    const noBranch = await admin.client.request('PUT', `/v1/users/${person.userId}/roles`, {
      body: { roles: [{ role: 'branch_manager', branchIds: [] }] },
    });
    expect(noBranch.statusCode).toBe(400);
  });

  it('protects a super admin from an org admin, and not from another super admin', async () => {
    const root = await createTestUser({ name: 'Another root', isSuperAdmin: true });
    await grantMembership({ userId: root.id, orgId: ORG_A, role: 'sales' });

    const byAdmin = await admin.client.request('PUT', `/v1/users/${root.id}/roles`, {
      body: { roles: [{ role: 'warehouse', branchIds: [] }] },
    });
    expect(byAdmin.statusCode).toBe(403);
    expect(json<{ code: string }>(byAdmin).code).toBe('USER_PROTECTED');
    for (const path of ['deactivate', 'password-link', 'two-factor/reset']) {
      const refused = await admin.client.request('POST', `/v1/users/${root.id}/${path}`, {
        body: { reason: 'testing protection' },
      });
      expect(refused.statusCode, path).toBe(403);
    }

    const bySuper = await superAdmin.client.request('PUT', `/v1/users/${root.id}/roles`, {
      body: { roles: [{ role: 'warehouse', branchIds: [] }] },
    });
    expect(bySuper.statusCode, bySuper.body).toBe(200);
  });
});

// --- deactivation --------------------------------------------------------------------------

describe('POST /v1/users/:id/deactivate', () => {
  it('ends the leaver’s sessions and refuses their next sign-in, keeping what they wrote', async () => {
    const leaver = await member(['accounts']);
    const signedIn = await signIn(leaver.email);
    await enrol(signedIn.client);
    await signedIn.client.request('POST', '/v1/me/active-org', { body: { orgId: ORG_A } });
    const raised = await signedIn.client.request('POST', '/v1/approvals', {
      body: { type: 'supplier_payment', amountPoisha: '500000' },
    });
    expect(raised.statusCode, raised.body).toBe(201);
    const { id: approvalId } = json<{ id: string }>(raised);

    const done = await admin.client.request('POST', `/v1/users/${leaver.userId}/deactivate`, {
      body: { reason: 'Resigned' },
    });
    expect(done.statusCode, done.body).toBe(201);
    expect(json<{ sessionsEnded: number }>(done).sessionsEnded).toBeGreaterThan(0);

    expect((await signedIn.client.request('GET', '/v1/me')).statusCode).toBe(401);
    const again = await signIn(leaver.email);
    expect(again.response.statusCode).toBe(403);
    expect(json<{ code: string }>(again.response).code).toBe('ACCOUNT_INACTIVE');

    // What they raised is still there, raised by them.
    const [kept] = await withSystem(
      async (tx) =>
        tx.execute<{ requested_by: string }>(sql`
          select requested_by from approvals.approval_requests where id = ${approvalId}
        `),
      { orgId: ORG_A },
    );
    expect(kept?.requested_by).toBe(leaver.userId);

    const { items } = await staff();
    expect(items.find((item) => item.userId === leaver.userId)).toMatchObject({
      status: 'deactivated',
      roles: [],
    });
    const audit = await auditRowsFor(ORG_A, leaver.userId);
    expect(audit.some((row) => row.action === 'iam.user_deactivated')).toBe(true);

    // Giving them a role again lets them back in.
    const back = await admin.client.request('PUT', `/v1/users/${leaver.userId}/roles`, {
      body: { roles: [{ role: 'warehouse', branchIds: [] }] },
    });
    expect(back.statusCode, back.body).toBe(200);
    expect((await signIn(leaver.email)).response.statusCode).toBe(200);
  });

  it('leaves a person who works for another brand signed in there', async () => {
    const shared = await member(['sales'], { alsoIn: { orgId: ORG_B, role: 'warehouse' } });
    const inB = await session(shared, ORG_B);

    const done = await admin.client.request('POST', `/v1/users/${shared.userId}/deactivate`, {
      body: {},
    });
    expect(done.statusCode, done.body).toBe(201);
    expect((await inB.request('GET', '/v1/me')).statusCode).toBe(200);
    expect((await signIn(shared.email)).response.statusCode).toBe(200);
  });

  it('refuses deactivating yourself, and someone already deactivated', async () => {
    const self = await admin.client.request('POST', `/v1/users/${admin.userId}/deactivate`, {
      body: {},
    });
    expect(self.statusCode).toBe(403);

    const person = await member(['sales']);
    await admin.client.request('POST', `/v1/users/${person.userId}/deactivate`, { body: {} });
    const twice = await admin.client.request('POST', `/v1/users/${person.userId}/deactivate`, {
      body: {},
    });
    expect(twice.statusCode).toBe(409);
  });
});

// --- password links ------------------------------------------------------------------------

describe('POST /v1/users/:id/password-link', () => {
  it('sends an invite again for three days, voiding the last one, and it works once', async () => {
    const invited = await member(['sales'], { password: false });

    const first = await admin.client.request('POST', `/v1/users/${invited.userId}/password-link`, {
      body: { reason: 'Lost the first invite' },
    });
    expect(first.statusCode, first.body).toBe(201);
    const firstLink = json<{ outcome: string; kind: string; token: string; expiresAt: string }>(
      first,
    );
    expect(firstLink).toMatchObject({ outcome: 'issued', kind: 'invite' });
    const hours = (Date.parse(firstLink.expiresAt) - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(71);
    expect(hours).toBeLessThanOrEqual(72);

    const second = json<{ token: string }>(
      await admin.client.request('POST', `/v1/users/${invited.userId}/password-link`, {
        body: { reason: 'Again' },
      }),
    );
    expect((await redeem(firstLink.token)).statusCode).toBe(400);
    expect((await redeem(second.token)).statusCode).toBe(200);
    expect((await redeem(second.token, 'yet-another-passphrase')).statusCode).toBe(400);
    expect((await signIn(invited.email, NEW_PASSWORD)).response.statusCode).toBe(200);

    // Whoever held the link could have set the password: they are now the granter.
    expect(await grantedBy(invited.userId)).toEqual([admin.userId]);
  });

  it('resets a password: the old one stops at once, sessions end, the link lasts an hour', async () => {
    const person = await member(['sales']);
    const client = await session(person);

    const issued = await admin.client.request('POST', `/v1/users/${person.userId}/password-link`, {
      body: { reason: 'Forgot it' },
    });
    expect(issued.statusCode, issued.body).toBe(201);
    const link = json<{ kind: string; token: string; expiresAt: string }>(issued);
    expect(link.kind).toBe('password');
    expect((Date.parse(link.expiresAt) - Date.now()) / 60_000).toBeLessThanOrEqual(60);

    expect((await client.request('GET', '/v1/me')).statusCode).toBe(401);
    expect((await signIn(person.email)).response.statusCode).toBe(401);

    expect((await redeem(link.token)).statusCode).toBe(200);
    expect((await signIn(person.email, NEW_PASSWORD)).response.statusCode).toBe(200);

    // The token is never written to the audit log, by the service or by the net.
    const audit = await auditRowsFor(ORG_A, person.userId);
    expect(audit.some((row) => row.action === 'iam.password_link_issued')).toBe(true);
    const everything = await withSystem(
      async (tx) =>
        tx.execute<{ n: number }>(sql`
          select count(*)::int as n from audit.audit_log
          where before::text like ${`%${link.token}%`} or after::text like ${`%${link.token}%`}
        `),
      { orgId: ORG_A },
    );
    expect(everything[0]?.n).toBe(0);
  });

  it('refuses an expired link', async () => {
    const person = await member(['warehouse']);
    const { token } = json<{ token: string }>(
      await admin.client.request('POST', `/v1/users/${person.userId}/password-link`, {
        body: { reason: 'Expiry' },
      }),
    );
    await withGlobal(async (tx) =>
      tx.execute(sql`
        update iam.verifications set expires_at = now() - interval '1 minute'
        where identifier = ${`reset-password:${token}`}
      `),
    );
    expect((await redeem(token)).statusCode).toBe(400);
  });

  it('holds a checker’s reset for a second admin, whom neither the asker nor the person may be', async () => {
    const target = await harness.asRole('org_admin', ORG_A);

    const asked = await admin.client.request('POST', `/v1/users/${target.userId}/password-link`, {
      body: { reason: 'Locked out' },
    });
    expect(asked.statusCode, asked.body).toBe(201);
    const pending = json<{ outcome: string; approvalRequestId: string; resetId: string }>(asked);
    expect(pending.outcome).toBe('pending_approval');

    // The person's sign-in is untouched while it waits.
    expect((await target.client.request('GET', '/v1/me')).statusCode).toBe(200);

    expect((await decide(admin.client, pending.approvalRequestId, 'approved')).statusCode).toBe(
      403,
    );
    expect((await decide(target.client, pending.approvalRequestId, 'approved')).statusCode).toBe(
      403,
    );
    const twice = await admin.client.request('POST', `/v1/users/${target.userId}/password-link`, {
      body: { reason: 'Again' },
    });
    expect(twice.statusCode).toBe(409);

    const approved = await decide(admin2.client, pending.approvalRequestId, 'approved');
    expect(approved.statusCode, approved.body).toBe(201);

    // Only the admin who asked collects it.
    const byOther = await admin2.client.request(
      'POST',
      `/v1/users/${target.userId}/password-link`,
      { body: { reason: 'Mine now' } },
    );
    expect(byOther.statusCode).toBe(409);
    const collected = await admin.client.request(
      'POST',
      `/v1/users/${target.userId}/password-link`,
      { body: { reason: 'Locked out' } },
    );
    expect(collected.statusCode, collected.body).toBe(201);
    const link = json<{ outcome: string; kind: string; token: string }>(collected);
    expect(link).toMatchObject({ outcome: 'issued', kind: 'password' });
    expect((await target.client.request('GET', '/v1/me')).statusCode).toBe(401);
    expect((await redeem(link.token)).statusCode).toBe(200);

    const [reset] = await withSystem(
      async (tx) =>
        tx.execute<{ status: string; decided_by: string }>(sql`
          select status, decided_by from iam.credential_resets where id = ${pending.resetId}
        `),
      { orgId: ORG_A },
    );
    expect(reset).toEqual({ status: 'completed', decided_by: admin2.userId });
  });

  it('lets a rejection end the reset with nothing changed', async () => {
    const target = await harness.asRole('accounts', ORG_A);
    const pending = json<{ approvalRequestId: string; resetId: string }>(
      await admin.client.request('POST', `/v1/users/${target.userId}/password-link`, {
        body: { reason: 'Suspicious' },
      }),
    );
    expect((await decide(admin2.client, pending.approvalRequestId, 'rejected')).statusCode).toBe(
      201,
    );
    expect((await target.client.request('GET', '/v1/me')).statusCode).toBe(200);
    const again = await admin.client.request('POST', `/v1/users/${target.userId}/password-link`, {
      body: { reason: 'Collect?' },
    });
    expect(json<{ outcome: string }>(again).outcome).toBe('pending_approval');
  });

  it('leaves a cross-brand person to a super admin, who acts alone', async () => {
    const shared = await member(['accounts'], { alsoIn: { orgId: ORG_B, role: 'sales' } });
    const refused = await admin.client.request('POST', `/v1/users/${shared.userId}/password-link`, {
      body: { reason: 'Cross brand' },
    });
    expect(refused.statusCode).toBe(403);
    expect(json<{ code: string }>(refused).code).toBe('USER_PROTECTED');

    const bySuper = await superAdmin.client.request(
      'POST',
      `/v1/users/${shared.userId}/password-link`,
      { body: { reason: 'Cross brand' } },
    );
    expect(bySuper.statusCode, bySuper.body).toBe(201);
    expect(json<{ outcome: string }>(bySuper).outcome).toBe('issued');
  });

  it('refuses resetting your own sign-in', async () => {
    const own = await admin.client.request('POST', `/v1/users/${admin.userId}/password-link`, {
      body: { reason: 'Myself' },
    });
    expect(own.statusCode).toBe(403);
    const ownTwoFactor = await admin.client.request(
      'POST',
      `/v1/users/${admin.userId}/two-factor/reset`,
      { body: { reason: 'Myself' } },
    );
    expect(ownTwoFactor.statusCode).toBe(403);
  });

  it('limits one person to five resets a day', async () => {
    const person = await member(['warehouse'], { password: false });
    for (let index = 0; index < 5; index += 1) {
      const issued = await admin.client.request(
        'POST',
        `/v1/users/${person.userId}/password-link`,
        {
          body: { reason: `Attempt ${String(index)}` },
        },
      );
      expect(issued.statusCode, issued.body).toBe(201);
    }
    const sixth = await admin2.client.request('POST', `/v1/users/${person.userId}/password-link`, {
      body: { reason: 'One too many' },
    });
    expect(sixth.statusCode).toBe(429);
  });

  it('keeps the public "send me a reset link" route closed', async () => {
    const client = harness.client();
    await client.request('GET', '/v1/auth/login-branding');
    const response = await client.request('POST', '/api/auth/request-password-reset', {
      body: { email: admin.email, redirectTo: '/accept-invite' },
    });
    expect(response.statusCode).toBe(404);
    expect(harness.tokens.take(admin.email)).toBeUndefined();
  });
});

// --- second factors ------------------------------------------------------------------------

describe('POST /v1/users/:id/two-factor/reset', () => {
  it('removes a sales agent’s second factor at once and ends their sessions', async () => {
    const person = await member(['sales']);
    const client = await session(person);
    await enrol(client);

    const reset = await admin.client.request(
      'POST',
      `/v1/users/${person.userId}/two-factor/reset`,
      {
        body: { reason: 'Lost phone' },
      },
    );
    expect(reset.statusCode, reset.body).toBe(201);
    expect(json<{ outcome: string }>(reset).outcome).toBe('completed');
    expect((await client.request('GET', '/v1/me')).statusCode).toBe(401);

    // Signs straight in: no factor left to ask for, and sales owes none.
    const again = await signIn(person.email);
    expect(again.response.statusCode).toBe(200);
    expect(json<{ twoFactorRedirect?: boolean }>(again.response).twoFactorRedirect).toBeUndefined();

    const nothing = await admin.client.request(
      'POST',
      `/v1/users/${person.userId}/two-factor/reset`,
      { body: { reason: 'Again' } },
    );
    expect(nothing.statusCode).toBe(409);
    expect(json<{ code: string }>(nothing).code).toBe('CREDENTIAL_NOTHING_TO_RESET');
  });

  it('waits for a second admin for an accountant, then walls them until they enrol again', async () => {
    const target = await harness.asRole('accounts', ORG_A);
    const pending = json<{ outcome: string; approvalRequestId: string }>(
      await admin.client.request('POST', `/v1/users/${target.userId}/two-factor/reset`, {
        body: { reason: 'Phone stolen' },
      }),
    );
    expect(pending.outcome).toBe('pending_approval');

    expect((await decide(admin2.client, pending.approvalRequestId, 'approved')).statusCode).toBe(
      201,
    );
    expect((await target.client.request('GET', '/v1/me')).statusCode).toBe(401);

    const again = await signIn(target.email);
    expect(again.response.statusCode).toBe(200);
    expect(json<{ twoFactorRedirect?: boolean }>(again.response).twoFactorRedirect).toBeUndefined();
    const walled = await again.client.request('GET', '/v1/me/orgs');
    expect(walled.statusCode).toBe(403);
    expect(json<{ code: string }>(walled).code).toBe('TWO_FACTOR_ENROLMENT_REQUIRED');

    const audit = await auditRowsFor(ORG_A, target.userId);
    expect(audit.some((row) => row.action === 'iam.two_factor_reset')).toBe(true);
  });

  it('withdraws a waiting reset when the person is deactivated', async () => {
    const target = await harness.asRole('accounts', ORG_A);
    const pending = json<{ approvalRequestId: string; resetId: string }>(
      await admin.client.request('POST', `/v1/users/${target.userId}/two-factor/reset`, {
        body: { reason: 'Leaving' },
      }),
    );
    await admin.client.request('POST', `/v1/users/${target.userId}/deactivate`, { body: {} });

    const [approval] = await withSystem(
      async (tx) =>
        tx.execute<{ status: string }>(sql`
          select status::text as status from approvals.approval_requests
          where id = ${pending.approvalRequestId}
        `),
      { orgId: ORG_A },
    );
    expect(approval?.status).toBe('cancelled');
    expect((await decide(admin2.client, pending.approvalRequestId, 'approved')).statusCode).toBe(
      409,
    );
  });
});

// --- the database --------------------------------------------------------------------------

describe('iam.credential_resets', () => {
  it('keeps every reset: no DELETE, terms frozen, and each brand sees only its own', async () => {
    const person = await member(['sales'], { password: false });
    await admin.client.request('POST', `/v1/users/${person.userId}/password-link`, {
      body: { reason: 'Database checks' },
    });

    await expectRefused(
      withOrg({ orgId: ORG_A, userId: admin.userId }, async (tx) =>
        tx.execute(sql`delete from iam.credential_resets where user_id = ${person.userId}`),
      ),
      /permission denied/,
    );
    await expectRefused(
      withOrg({ orgId: ORG_A, userId: admin.userId }, async (tx) =>
        tx.execute(sql`
          update iam.credential_resets set reason = 'rewritten' where user_id = ${person.userId}
        `),
      ),
      /CREDENTIAL_RESET_INVALID/,
    );
    await expectRefused(
      withOrg({ orgId: ORG_A, userId: admin.userId }, async (tx) =>
        tx.execute(sql`
          insert into iam.credential_resets (org_id, user_id, kind, status, requested_by, reason)
          values (${ORG_A}, ${person.userId}, 'password', 'approved', ${admin.userId}, 'forged')
        `),
      ),
      /credential_resets_pending_has_approval|CREDENTIAL_RESET_INVALID/,
    );

    const fromB = await withOrg({ orgId: ORG_B, userId: admin.userId }, async (tx) =>
      tx.execute<{ n: number }>(sql`
        select count(*)::int as n from iam.credential_resets where user_id = ${person.userId}
      `),
    );
    expect(fromB[0]?.n).toBe(0);
  });
});
