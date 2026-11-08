import { base32 } from '@better-auth/utils/base32';
import { withOrg, withSystem } from '@elysium/db';
import { createTestUser, grantMembership } from '@elysium/db/testing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  auditRowsFor,
  ORG_A,
  PASSWORD,
  startHttpHarness,
  type Client,
  type HttpHarness,
  type RoleClient,
} from '../../testing/http-harness.js';
import { pgCode } from './users.errors.js';

/**
 * Removing a super admin against real Postgres (D-954).
 *
 * Any super admin removes another at once, and steps down at once; never the last one, never
 * an owner. The removed person's sessions end and their super admin power is gone; an admin
 * role in the brand stays. `iam.demote_super_admin` refuses a removal the rule does not
 * allow, whoever calls it.
 */

interface SuperAdmin {
  client: Client;
  readonly userId: string;
  readonly email: string;
  readonly secret: string;
}

let harness: HttpHarness;
let first: SuperAdmin;
let second: SuperAdmin;
let third: SuperAdmin;
let admin: RoleClient;

function json<T>(response: { body: string }): T {
  return JSON.parse(response.body) as T;
}

async function enter(client: Client): Promise<void> {
  const entered = await client.request('POST', '/v1/me/active-org', { body: { orgId: ORG_A } });
  expect(entered.statusCode, entered.body).toBe(201);
}

async function superAdmin(
  name: string,
  options: { adminHere?: boolean } = {},
): Promise<SuperAdmin> {
  const user = await createTestUser({ name, isSuperAdmin: true });
  if (options.adminHere === true) {
    await grantMembership({ userId: user.id, orgId: ORG_A, role: 'org_admin' });
  }
  await harness.auth.auth.api.requestPasswordReset({
    body: { email: user.email, redirectTo: '/accept-invite' },
    headers: new Headers(),
  });
  const token = harness.tokens.take(user.email);
  if (token === undefined) throw new Error(`no token for ${user.email}`);
  await harness.auth.auth.api.resetPassword({ body: { newPassword: PASSWORD, token } });

  const client = harness.client();
  await client.request('GET', '/v1/auth/login-branding');
  await client.request('POST', '/api/auth/sign-in/email', {
    body: { email: user.email, password: PASSWORD },
  });
  const enabled = await client.request('POST', '/api/auth/two-factor/enable', {
    body: { password: PASSWORD, method: 'totp' },
  });
  const { totpURI } = json<{ totpURI: string }>(enabled);
  const secret = new TextDecoder().decode(
    base32.decode(new URL(totpURI).searchParams.get('secret') ?? ''),
  );
  const { code } = await harness.auth.auth.api.generateTOTP({ body: { secret } });
  await client.request('POST', '/api/auth/two-factor/verify-totp', { body: { code } });
  await enter(client);
  return { client, userId: user.id, email: user.email, secret };
}

/** Sign in again, password and second factor, as a person whose sessions were ended. */
async function signInAgain(who: SuperAdmin): Promise<Client> {
  const client = harness.client();
  await client.request('GET', '/v1/auth/login-branding');
  const signed = await client.request('POST', '/api/auth/sign-in/email', {
    body: { email: who.email, password: PASSWORD },
  });
  expect(signed.statusCode, signed.body).toBe(200);
  const { code } = await harness.auth.auth.api.generateTOTP({ body: { secret: who.secret } });
  const verified = await client.request('POST', '/api/auth/two-factor/verify-totp', {
    body: { code },
  });
  expect(verified.statusCode, verified.body).toBe(200);
  await enter(client);
  return client;
}

async function isSuperAdmin(userId: string): Promise<boolean> {
  const [row] = await withSystem(async (tx) =>
    tx.execute<{ flag: boolean }>(
      sql`select is_super_admin as flag from iam.users where id = ${userId}`,
    ),
  );
  return row?.flag === true;
}

async function actions(userId: string): Promise<string[]> {
  return (await auditRowsFor(ORG_A, userId)).map((row) => row.action);
}

const remove = (voter: Client, userId: string) =>
  voter.request('POST', `/v1/users/${userId}/super-admin-removal`);

/** What a refused statement says, its causes included, and its SQLSTATE. */
async function refusal(work: Promise<unknown>): Promise<{ code?: string; text: string }> {
  const error = await work.then(
    () => null,
    (cause: unknown) => cause,
  );
  expect(error, 'the statement should have been refused').not.toBeNull();
  const texts: string[] = [];
  for (let current = error; current instanceof Error; current = current.cause) {
    texts.push(current.message);
  }
  const code = pgCode(error);
  return { ...(code === undefined ? {} : { code }), text: texts.join(' | ') };
}

beforeAll(async () => {
  harness = await startHttpHarness('super-admin-removal');
  first = await superAdmin('First');
  second = await superAdmin('Second', { adminHere: true });
  third = await superAdmin('Third');
  admin = await harness.asRole('org_admin', ORG_A);
}, 300_000);

afterAll(async () => {
  await harness?.close();
}, 60_000);

describe('removing a super admin (D-954)', () => {
  it('refuses anyone who is not a super admin', async () => {
    const refused = await remove(admin.client, third.userId);
    expect(refused.statusCode, refused.body).toBe(403);
    expect(json<{ code: string }>(refused).code).toBe('USER_PROTECTED');
    const steppedDown = await admin.client.request('POST', '/v1/users/me/step-down');
    expect(steppedDown.statusCode, steppedDown.body).toBe(403);
    expect(await isSuperAdmin(third.userId)).toBe(true);
  });

  it('the database refuses a forged removal, whoever calls it', async () => {
    // Not a super admin, straight at the function, as the application role.
    const forged = await refusal(
      withOrg({ orgId: ORG_A, userId: admin.userId }, (tx) =>
        tx.execute(sql`select iam.demote_super_admin(${third.userId})`),
      ),
    );
    expect(forged.code).toBe('42501');
    expect(forged.text).toContain('only an active super admin removes');

    // The flag itself, past the function.
    const cleared = await refusal(
      withOrg({ orgId: ORG_A, userId: first.userId }, (tx) =>
        tx.execute(sql`update iam.users set is_super_admin = false where id = ${third.userId}`),
      ),
    );
    expect(cleared.code).toBe('42501');
    expect(cleared.text).toContain('only iam.demote_super_admin removes a super admin');
    expect(await isSuperAdmin(third.userId)).toBe(true);
  });

  it('any super admin removes another at once; their admin role stays, their power goes', async () => {
    const removed = await remove(third.client, second.userId);
    expect(removed.statusCode, removed.body).toBe(201);
    const outcome = json<{ outcome: string; sessionsEnded: number }>(removed);
    expect(outcome.outcome).toBe('removed');
    expect(outcome.sessionsEnded).toBeGreaterThanOrEqual(1);
    expect(await isSuperAdmin(second.userId)).toBe(false);
    expect((await second.client.request('GET', '/v1/me')).statusCode).toBe(401);

    const [membership] = await withSystem(
      async (tx) =>
        tx.execute<{ is_active: boolean }>(sql`
          select is_active from iam.memberships
          where org_id = ${ORG_A} and user_id = ${second.userId} and role = 'org_admin'
        `),
      { orgId: ORG_A },
    );
    expect(membership?.is_active).toBe(true);

    // Signed in again: an admin, no longer a super admin.
    second.client = await signInAgain(second);
    const listed = json<{ canStartSuperAdmin: boolean }>(
      await second.client.request('GET', '/v1/users'),
    );
    expect(listed.canStartSuperAdmin).toBe(false);
    const promote = await second.client.request('POST', `/v1/users/${admin.userId}/super-admin`);
    expect(promote.statusCode, promote.body).toBe(403);
    expect(json<{ code: string }>(promote).code).toBe('USER_PROTECTED');

    const completed = (await auditRowsFor(ORG_A, second.userId)).find(
      (row) => row.action === 'iam.super_admin_removal_completed',
    );
    expect(completed?.actor_user_id).toBe(third.userId);
    expect(completed?.after).toMatchObject({ isSuperAdmin: false });
  });

  it('the earliest super admin is removed like any other', async () => {
    const removed = await remove(third.client, first.userId);
    expect(removed.statusCode, removed.body).toBe(201);
    expect(await isSuperAdmin(first.userId)).toBe(false);
  });

  it('a super admin steps down at once, and the last one cannot', async () => {
    const next = await superAdmin('Next');
    const stepped = await third.client.request('POST', '/v1/users/me/step-down');
    expect(stepped.statusCode, stepped.body).toBe(201);
    expect(await isSuperAdmin(third.userId)).toBe(false);
    expect((await third.client.request('GET', '/v1/me')).statusCode).toBe(401);
    expect(await actions(third.userId)).toContain('iam.super_admin_removal_stepped_down');

    const last = await next.client.request('POST', '/v1/users/me/step-down');
    expect(last.statusCode, last.body).toBe(409);
    expect(json<{ code: string }>(last).code).toBe('SUPER_ADMIN_LAST');
    expect(await isSuperAdmin(next.userId)).toBe(true);
  });
});
