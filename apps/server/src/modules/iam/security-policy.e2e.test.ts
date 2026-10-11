import { withGlobal } from '@elysium/db';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  auditRowsFor,
  ORG_A,
  ORG_B,
  PASSWORD,
  startHttpHarness,
  type Client,
  type HttpHarness,
} from '../../testing/http-harness.js';
import { codeFor, enrol, enter, json, person, signIn, signInFully } from './sign-in.testing.js';

/**
 * Settings → Security and the Staff screen's sign-out and turn-off on real Postgres (M40,
 * D-691, D-692, D-696, D-697).
 *
 * The policy is checked where it bites: a sales person without two-step sign-in is let in, then
 * walled at their very next request once a super admin requires it for sales, and let in again
 * once it is switched off — with nobody's factor removed either way. The scanner's sign-in and
 * its device tokens follow the same answer.
 */

let harness: HttpHarness;
let root: { client: Client; userId: string };
let admin: { client: Client; userId: string; secret: string };

const DEFAULT_ROLES = ['org_admin', 'accounts', 'investor'];

beforeAll(async () => {
  harness = await startHttpHarness('security-policy');

  const rootPerson = await person(harness, [], { isSuperAdmin: true });
  const rootIn = await signIn(harness, rootPerson.email);
  await enrol(harness, rootIn.client);
  expect((await enter(rootIn.client)).statusCode).toBe(201);
  root = { client: rootIn.client, userId: rootPerson.userId };

  const adminPerson = await person(harness, ['org_admin']);
  const adminIn = await signIn(harness, adminPerson.email);
  const { secret } = await enrol(harness, adminIn.client);
  expect((await enter(adminIn.client)).statusCode).toBe(201);
  admin = { client: adminIn.client, userId: adminPerson.userId, secret };
}, 300_000);

afterAll(async () => {
  await harness?.close();
}, 60_000);

interface PolicyBody {
  roles: {
    role: string;
    required: boolean;
    byDefault: boolean;
    members: number;
    withoutTwoFactor: number;
  }[];
  superAdminsAlways: boolean;
  isDefault: boolean;
  newlyWalled?: number;
}

async function setPolicy(requiredRoles: readonly string[]): Promise<PolicyBody> {
  const response = await root.client.request('PUT', '/v1/security/two-factor-policy', {
    body: { requiredRoles },
  });
  expect(response.statusCode, response.body).toBe(200);
  return json<PolicyBody>(response);
}

async function twoFactorEnabled(userId: string): Promise<boolean> {
  const [row] = await withGlobal((tx) =>
    tx.execute<{ two_factor_enabled: boolean }>(
      sql`select two_factor_enabled from iam.users where id = ${userId}`,
    ),
  );
  return row?.two_factor_enabled === true;
}

describe('the setting itself', () => {
  it('is a super admin’s alone, and shows the default until changed', async () => {
    for (const method of ['GET', 'PUT'] as const) {
      const refused = await admin.client.request(method, '/v1/security/two-factor-policy', {
        ...(method === 'PUT' ? { body: { requiredRoles: [] } } : {}),
      });
      expect(refused.statusCode, `${method} as org_admin`).toBe(403);
    }

    const read = await root.client.request('GET', '/v1/security/two-factor-policy');
    expect(read.statusCode, read.body).toBe(200);
    const view = json<PolicyBody>(read);
    expect(view.isDefault).toBe(true);
    expect(view.superAdminsAlways).toBe(true);
    expect(view.roles.filter((entry) => entry.required).map((entry) => entry.role)).toEqual(
      DEFAULT_ROLES,
    );
    expect(view.roles.map((entry) => entry.role)).toEqual([
      'org_admin',
      'accounts',
      'hr',
      'marketing',
      'branch_manager',
      'warehouse',
      'sales',
      'investor',
      'reseller',
    ]);
  });

  it('refuses something that is not a list of roles', async () => {
    const bad = await root.client.request('PUT', '/v1/security/two-factor-policy', {
      body: { requiredRoles: ['super_admin'] },
    });
    expect(bad.statusCode).toBe(400);
  });
});

describe('the enrolment wall follows the setting at once', () => {
  it('walls a sales person when sales is required, and lets them in when it is not', async () => {
    const seller = await person(harness, ['sales']);
    const client = await signInFully(harness, seller.email);
    expect((await client.request('GET', '/v1/me')).statusCode).toBe(200);

    const on = await setPolicy([...DEFAULT_ROLES, 'sales']);
    expect(on.isDefault).toBe(false);
    expect(on.newlyWalled).toBeGreaterThanOrEqual(1);

    // Their very next request, with the session they already hold.
    const walled = await client.request('GET', '/v1/me');
    expect(walled.statusCode).toBe(403);
    expect(json<{ code: string }>(walled).code).toBe('TWO_FACTOR_ENROLMENT_REQUIRED');
    // Better Auth's other endpoints too, past the enrolment allow-list.
    const renamed = await client.request('POST', '/api/auth/update-user', {
      body: { name: 'x' },
    });
    expect(renamed.statusCode).toBe(403);

    // The Staff list says so.
    const staff = await admin.client.request('GET', '/v1/users');
    const row = json<{ items: { userId: string; twoFactorRequired: boolean }[] }>(staff).items.find(
      (entry) => entry.userId === seller.userId,
    );
    expect(row?.twoFactorRequired).toBe(true);

    // They set it up from the session they hold, and are through.
    const { secret } = await enrol(harness, client);
    expect((await enter(client)).statusCode).toBe(201);
    const view = json<{
      twoFactor: { required: boolean; requiredByRoles: string[]; canTurnOff: boolean };
    }>(await client.request('GET', '/v1/account'));
    expect(view.twoFactor).toMatchObject({
      required: true,
      requiredByRoles: ['sales'],
      canTurnOff: false,
    });
    const refused = await client.request('POST', '/v1/account/two-factor/turn-off', {
      body: { password: PASSWORD, code: await codeFor(harness, secret) },
    });
    expect(json<{ code: string }>(refused).code).toBe('TWO_FACTOR_REQUIRED');

    // Switched off again: the unenrolled are let through, the enrolled keep their factor.
    const other = await person(harness, ['sales']);
    const otherIn = await signIn(harness, other.email);
    expect((await enter(otherIn.client)).statusCode).toBe(403);
    await setPolicy(DEFAULT_ROLES);
    expect((await enter(otherIn.client)).statusCode).toBe(201);
    expect(await twoFactorEnabled(seller.userId)).toBe(true);
    const after = json<{ twoFactor: { required: boolean; canTurnOff: boolean } }>(
      await client.request('GET', '/v1/account'),
    );
    expect(after.twoFactor).toMatchObject({ required: false, canTurnOff: true });

    const changes = (await auditRowsFor(ORG_A, ORG_A)).filter(
      (entry) => entry.action === 'security.two_factor_policy_changed',
    );
    expect(changes.length).toBeGreaterThanOrEqual(2);
    expect(changes.some((entry) => JSON.stringify(entry.after).includes('"added":["sales"]'))).toBe(
      true,
    );
    expect(
      changes.some((entry) => JSON.stringify(entry.after).includes('"removed":["sales"]')),
    ).toBe(true);
  });

  it("never lets one brand's setting reach a role held in another brand", async () => {
    const seller = await person(harness, ['sales'], { orgId: ORG_B });
    await setPolicy([...DEFAULT_ROLES, 'sales']);
    try {
      const client = await signInFully(harness, seller.email, { orgId: ORG_B });
      expect((await client.request('GET', '/v1/me')).statusCode).toBe(200);
    } finally {
      await setPolicy(DEFAULT_ROLES);
    }
  });

  it('switching a default role off lets its unenrolled people in, and back on walls them', async () => {
    const accountant = await person(harness, ['accounts']);
    const signedIn = await signIn(harness, accountant.email);
    expect((await enter(signedIn.client)).statusCode).toBe(403);
    await setPolicy(['org_admin', 'investor']);
    try {
      expect((await enter(signedIn.client)).statusCode).toBe(201);
    } finally {
      await setPolicy(DEFAULT_ROLES);
    }
    expect((await signedIn.client.request('GET', '/v1/me')).statusCode).toBe(403);
  });
});

describe('the scanner follows the setting', () => {
  async function scannerSignIn(email: string) {
    const response = await harness.server.inject({
      method: 'POST',
      url: '/v1/scanner/sign-in',
      headers: { 'content-type': 'application/json', origin: 'https://localhost' },
      payload: JSON.stringify({ email, password: PASSWORD }),
    });
    return {
      status: response.statusCode,
      body: JSON.parse(response.body) as Record<string, unknown>,
    };
  }

  async function lookup(token: string) {
    const response = await harness.server.inject({
      method: 'GET',
      url: '/v1/scanner/shipment?code=NO-SUCH-CODE',
      headers: { authorization: `Bearer ${token}`, origin: 'https://localhost' },
    });
    return response.statusCode;
  }

  it('refuses a packer without two-step sign-in while warehouse requires it', async () => {
    const packer = await person(harness, ['warehouse']);
    const first = await scannerSignIn(packer.email);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const token = first.body.token as string;
    expect(await lookup(token)).toBe(200);

    await setPolicy([...DEFAULT_ROLES, 'warehouse']);
    try {
      const refused = await scannerSignIn(packer.email);
      expect(refused.status).toBe(403);
      expect(refused.body.code).toBe('SCANNER_ENROLMENT_REQUIRED');
      // A phone already paired stops working too.
      expect(await lookup(token)).toBe(401);
    } finally {
      await setPolicy(DEFAULT_ROLES);
    }
    expect(await lookup(token)).toBe(200);
    expect((await scannerSignIn(packer.email)).status).toBe(200);
  });
});

describe('Staff: sign out everywhere', () => {
  it('ends every session of a person, audited, and never your own or a super admin’s', async () => {
    const seller = await person(harness, ['sales']);
    const one = await signInFully(harness, seller.email);
    const two = await signInFully(harness, seller.email);

    const done = await admin.client.request(
      'POST',
      `/v1/users/${seller.userId}/sign-out-everywhere`,
    );
    expect(done.statusCode, done.body).toBe(201);
    expect(json<{ sessionsEnded: number; scope: string }>(done)).toMatchObject({
      sessionsEnded: 2,
      scope: 'all',
    });
    expect((await one.request('GET', '/v1/me')).statusCode).toBe(401);
    expect((await two.request('GET', '/v1/me')).statusCode).toBe(401);
    // They sign in again as before.
    await signInFully(harness, seller.email);
    const rows = await auditRowsFor(ORG_A, seller.userId);
    expect(rows.find((row) => row.action === 'iam.user_signed_out_everywhere')).toMatchObject({
      actor_user_id: admin.userId,
      after: { sessionsEnded: 2, scope: 'all' },
    });

    const self = await admin.client.request(
      'POST',
      `/v1/users/${admin.userId}/sign-out-everywhere`,
    );
    expect(self.statusCode).toBe(403);
    expect(json<{ code: string }>(self).code).toBe('USER_SELF_MANAGEMENT');

    const superAdmin = await person(harness, ['org_admin'], { isSuperAdmin: true });
    const protectedOne = await admin.client.request(
      'POST',
      `/v1/users/${superAdmin.userId}/sign-out-everywhere`,
    );
    expect(protectedOne.statusCode).toBe(403);
    expect(json<{ code: string }>(protectedOne).code).toBe('USER_PROTECTED');
    const byRoot = await root.client.request(
      'POST',
      `/v1/users/${superAdmin.userId}/sign-out-everywhere`,
    );
    expect(byRoot.statusCode, byRoot.body).toBe(201);

    // A role without `update User` is refused by the guard.
    const sales = await harness.asRole('sales', ORG_A);
    const bySales = await sales.client.request(
      'POST',
      `/v1/users/${seller.userId}/sign-out-everywhere`,
    );
    expect(bySales.statusCode).toBe(403);
  });

  it('ends every session of someone who also works elsewhere, which would otherwise return in one click', async () => {
    const both = await person(harness, ['sales']);
    const { grantMembership } = await import('@elysium/db/testing');
    await grantMembership({ userId: both.userId, orgId: ORG_B, role: 'sales' });
    const here = await signInFully(harness, both.email, { orgId: ORG_A });
    const there = await signInFully(harness, both.email, { orgId: ORG_B });

    const done = await admin.client.request('POST', `/v1/users/${both.userId}/sign-out-everywhere`);
    expect(json<{ scope: string; sessionsEnded: number }>(done)).toMatchObject({
      scope: 'all',
      sessionsEnded: 2,
    });
    expect((await here.request('GET', '/v1/me')).statusCode).toBe(401);
    expect((await there.request('GET', '/v1/me')).statusCode).toBe(401);
  });
});

describe('Staff: turn off two-step', () => {
  it('turns it off for a role that does not require it, and refuses one that does', async () => {
    // Marketing: nothing requires it, and it decides no approval, so one admin may (D-404).
    const marketer = await person(harness, ['marketing']);
    const marketerIn = await signIn(harness, marketer.email);
    await enrol(harness, marketerIn.client);

    const off = await admin.client.request(
      'POST',
      `/v1/users/${marketer.userId}/two-factor/turn-off`,
      { body: { reason: 'They asked to stop using it' } },
    );
    expect(off.statusCode, off.body).toBe(201);
    expect(json<{ outcome: string }>(off).outcome).toBe('completed');
    expect(await twoFactorEnabled(marketer.userId)).toBe(false);
    const again = await signIn(harness, marketer.email);
    expect(json<{ twoFactorRedirect?: boolean }>(again.response).twoFactorRedirect).toBeUndefined();
    const rows = await auditRowsFor(ORG_A, marketer.userId);
    expect(rows.some((row) => row.action === 'iam.two_factor_turned_off')).toBe(true);

    const accountant = await person(harness, ['accounts']);
    const accountantIn = await signIn(harness, accountant.email);
    await enrol(harness, accountantIn.client);
    const refused = await admin.client.request(
      'POST',
      `/v1/users/${accountant.userId}/two-factor/turn-off`,
      { body: { reason: 'They asked to stop using it' } },
    );
    expect(refused.statusCode).toBe(409);
    expect(json<{ code: string }>(refused).code).toBe('TWO_FACTOR_REQUIRED');
    expect(await twoFactorEnabled(accountant.userId)).toBe(true);
  });

  it('still needs a second admin for a money role, even where the setting no longer requires it', async () => {
    const accountant = await person(harness, ['accounts']);
    const accountantIn = await signIn(harness, accountant.email);
    await enrol(harness, accountantIn.client);
    await setPolicy(['org_admin', 'investor']);
    try {
      const asked = await admin.client.request(
        'POST',
        `/v1/users/${accountant.userId}/two-factor/turn-off`,
        { body: { reason: 'Moving to a shared till' } },
      );
      expect(asked.statusCode, asked.body).toBe(201);
      expect(json<{ outcome: string }>(asked).outcome).toBe('pending_approval');
      expect(await twoFactorEnabled(accountant.userId)).toBe(true);
    } finally {
      await setPolicy(DEFAULT_ROLES);
    }
  });

  it('answers 404 for someone with no role here, saying nothing of another brand (W2)', async () => {
    const elsewhere = await person(harness, ['accounts'], { orgId: ORG_B });
    const answer = await admin.client.request(
      'POST',
      `/v1/users/${elsewhere.userId}/two-factor/turn-off`,
      { body: { reason: 'Probing another brand' } },
    );
    expect(answer.statusCode).toBe(404);
    expect(json<{ code: string }>(answer).code).toBe('USER_NOT_FOUND');
  });

  it('is refused for a super admin, and for yourself', async () => {
    const superAdmin = await person(harness, ['org_admin'], { isSuperAdmin: true });
    const superAdminIn = await signIn(harness, superAdmin.email);
    await enrol(harness, superAdminIn.client);
    const byRoot = await root.client.request(
      'POST',
      `/v1/users/${superAdmin.userId}/two-factor/turn-off`,
      { body: { reason: 'Not allowed' } },
    );
    expect(json<{ code: string }>(byRoot).code).toBe('TWO_FACTOR_REQUIRED');

    const self = await admin.client.request(
      'POST',
      `/v1/users/${admin.userId}/two-factor/turn-off`,
      {
        body: { reason: 'Not allowed' },
      },
    );
    // Nobody turns off their own here: My account does that, with a current code.
    expect(self.statusCode).toBe(403);
    expect(json<{ code: string }>(self).code).toBe('USER_SELF_MANAGEMENT');
  });
});

describe('the policy reader and the set-up stamp (W6)', () => {
  it('refuses to read a policy outside that brand, rather than read it as the default', async () => {
    const { loadTwoFactorPolicy, withOrg: inOrg, withUser } = await import('@elysium/db');
    await expect(
      withUser({ userId: admin.userId }, (tx) => loadTwoFactorPolicy(tx, ORG_A)),
    ).rejects.toThrow(/withOrg/);
    await expect(inOrg({ orgId: ORG_B }, (tx) => loadTwoFactorPolicy(tx, ORG_A))).rejects.toThrow(
      /withOrg/,
    );
    const policy = await inOrg({ orgId: ORG_A }, (tx) => loadTwoFactorPolicy(tx, ORG_A));
    expect(policy.requiredRoles).toEqual(DEFAULT_ROLES);
  });

  it('reads a hand-edited row naming an unknown role as the default at the wall', async () => {
    const { withSystem } = await import('@elysium/db');
    const accountant = await person(harness, ['accounts']);
    const seller = await person(harness, ['sales']);
    await withSystem(
      (tx) =>
        tx.execute(sql`
          insert into org.settings (org_id, key, value)
          values (${ORG_A}, 'security.two_factor', '{"requiredRoles":["sales","org-admin"]}'::jsonb)
          on conflict (org_id, key) do update set value = excluded.value
        `),
      { orgId: ORG_A },
    );
    try {
      // Read naively it would require sales only; read as the default, accounts is walled
      // and sales is not.
      const accountantIn = await signIn(harness, accountant.email);
      expect((await enter(accountantIn.client)).statusCode).toBe(403);
      const sellerIn = await signIn(harness, seller.email);
      expect((await enter(sellerIn.client)).statusCode).toBe(201);
    } finally {
      await setPolicy(DEFAULT_ROLES);
    }
  });

  it('stamps the set-up time once, keeps it through codes used and counted, and clears it on a pending row', async () => {
    const packer = await person(harness, ['warehouse']);
    const packerIn = await signIn(harness, packer.email);
    await enrol(harness, packerIn.client);
    const stamp = async () => {
      const [row] = await withGlobal((tx) =>
        tx.execute<{ enabled_at: Date | null }>(
          sql`select enabled_at from iam.two_factors where user_id = ${packer.userId}`,
        ),
      );
      return row?.enabled_at === null || row?.enabled_at === undefined
        ? null
        : new Date(row.enabled_at).toISOString();
    };
    const first = await stamp();
    expect(first).not.toBeNull();
    await withGlobal((tx) =>
      tx.execute(sql`
        update iam.two_factors
        set failed_verification_count = failed_verification_count + 1, backup_codes = backup_codes
        where user_id = ${packer.userId}
      `),
    );
    expect(await stamp()).toBe(first);
    await withGlobal((tx) =>
      tx.execute(sql`update iam.two_factors set verified = false where user_id = ${packer.userId}`),
    );
    expect(await stamp()).toBeNull();
  });
});
