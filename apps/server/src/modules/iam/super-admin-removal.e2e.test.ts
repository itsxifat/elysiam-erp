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
 * Removing a super admin against real Postgres (D-685 to D-689).
 *
 * A super admin steps down at once, never the last one. Another is removed only when the
 * first super admin (or an owner) starts it and every other super admin says yes; with two,
 * the first removes the second at once. The removed person's sessions end and their super
 * admin power is gone; an admin role in the brand stays. `iam.demote_super_admin` refuses a
 * removal the rule does not allow, whoever calls it.
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

  // The rule names the earliest active super admin; this suite's must be that one.
  const [earliest] = await withSystem(async (tx) =>
    tx.execute<{ id: string }>(sql`
      select id from iam.users where is_super_admin and is_active and not is_owner
      order by created_at, id limit 1
    `),
  );
  expect(earliest?.id).toBe(first.userId);
}, 300_000);

afterAll(async () => {
  await harness?.close();
}, 60_000);

describe('removing a super admin (D-685 to D-689)', () => {
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

    // A super admin, with the other votes missing.
    const early = await refusal(
      withOrg({ orgId: ORG_A, userId: second.userId }, (tx) =>
        tx.execute(sql`select iam.demote_super_admin(${third.userId})`),
      ),
    );
    expect(early.code).toBe('42501');
    expect(early.text).toContain('SUPER_ADMIN_REMOVAL_VOTES_MISSING');

    // A second super admin starting one by writing its first vote.
    const started = await refusal(
      withOrg({ orgId: ORG_A, userId: second.userId }, (tx) =>
        tx.execute(sql`
          insert into iam.super_admin_removal_votes (org_id, voter_user_id, target_user_id)
          values (${ORG_A}, ${second.userId}, ${third.userId})
        `),
      ),
    );
    expect(started.text).toContain('only the first super admin starts a removal');

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

  it('a super admin who is not the first cannot start a removal, nor remove the first', async () => {
    const started = await remove(second.client, third.userId);
    expect(started.statusCode, started.body).toBe(403);
    expect(started.body).toContain('Only the first super admin');

    const ofFirst = await remove(second.client, first.userId);
    expect(ofFirst.statusCode, ofFirst.body).toBe(409);
    expect(json<{ code: string }>(ofFirst).code).toBe('SUPER_ADMIN_NOT_REMOVABLE');
    expect(await isSuperAdmin(first.userId)).toBe(true);
  });

  it('with three, the first starts it, a withdrawal clears it, and every other must vote', async () => {
    const started = await remove(first.client, third.userId);
    expect(started.statusCode, started.body).toBe(201);
    expect(json(started)).toMatchObject({ outcome: 'pending', votes: 1, needed: 2 });
    expect(await isSuperAdmin(third.userId)).toBe(true);

    // It shows on the Staff list, as the target sees it too.
    const listed = json<{
      items: { userId: string; superAdminRemoval: Record<string, unknown> | null }[];
    }>(await third.client.request('GET', '/v1/users'));
    const row = listed.items.find((item) => item.userId === third.userId);
    expect(row?.superAdminRemoval).toMatchObject({
      pending: true,
      votes: 1,
      needed: 2,
      canVote: false,
      canWithdraw: false,
    });

    // The target cannot withdraw their own removal; another super admin can.
    const own = await third.client.request(
      'DELETE',
      `/v1/users/${third.userId}/super-admin-removal`,
    );
    expect(own.statusCode, own.body).toBe(403);
    const withdrawn = await second.client.request(
      'DELETE',
      `/v1/users/${third.userId}/super-admin-removal`,
    );
    expect(withdrawn.statusCode, withdrawn.body).toBe(200);
    expect(json(withdrawn)).toMatchObject({ withdrawnVotes: 1 });

    // Withdrawn means not started: the second still cannot start it.
    expect((await remove(second.client, third.userId)).statusCode).toBe(403);

    expect((await remove(first.client, third.userId)).statusCode).toBe(201);
    const last = await remove(second.client, third.userId);
    expect(last.statusCode, last.body).toBe(201);
    expect(json(last)).toMatchObject({ outcome: 'removed', votes: 2, needed: 2 });
    expect(await isSuperAdmin(third.userId)).toBe(false);
    expect((await third.client.request('GET', '/v1/me')).statusCode).toBe(401);

    const audited = await actions(third.userId);
    expect(audited).toEqual(
      expect.arrayContaining([
        'iam.super_admin_removal_started',
        'iam.super_admin_removal_withdrawn',
        'iam.super_admin_removal_voted',
        'iam.super_admin_removal_completed',
      ]),
    );
  });

  it('with two, the first removes the second at once; their admin role stays, their power goes', async () => {
    const removed = await remove(first.client, second.userId);
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
    expect((await remove(second.client, first.userId)).statusCode).toBe(403);

    const completed = (await auditRowsFor(ORG_A, second.userId)).find(
      (row) => row.action === 'iam.super_admin_removal_completed',
    );
    expect(completed?.actor_user_id).toBe(first.userId);
    expect(completed?.after).toMatchObject({ isSuperAdmin: false, superAdminsBefore: 2 });
  });

  it('the last super admin cannot step down', async () => {
    const refused = await first.client.request('POST', '/v1/users/me/step-down');
    expect(refused.statusCode, refused.body).toBe(409);
    expect(json<{ code: string }>(refused).code).toBe('SUPER_ADMIN_LAST');
    expect(await isSuperAdmin(first.userId)).toBe(true);
  });

  it('a super admin steps down at once; the next earliest becomes the first, and a removal of them goes', async () => {
    const next = await superAdmin('Next');
    const later = await superAdmin('Later');
    const pending = await remove(first.client, next.userId);
    expect(json(pending)).toMatchObject({ outcome: 'pending', votes: 1, needed: 2 });

    const stepped = await first.client.request('POST', '/v1/users/me/step-down');
    expect(stepped.statusCode, stepped.body).toBe(201);
    expect(await isSuperAdmin(first.userId)).toBe(false);
    expect((await first.client.request('GET', '/v1/me')).statusCode).toBe(401);

    const row = (await auditRowsFor(ORG_A, first.userId)).find(
      (entry) => entry.action === 'iam.super_admin_removal_stepped_down',
    );
    expect(row?.before).toMatchObject({ isSuperAdmin: true, wasFirst: true });
    expect(row?.after).toMatchObject({
      isSuperAdmin: false,
      firstNow: next.userId,
      clearedRemovalVoters: [first.userId],
    });

    // The first now: they start what the first starts, and nobody can remove them.
    const listed = json<{
      canStartSuperAdmin: boolean;
      items: { userId: string; superAdminRemoval: { pending: boolean; isFirst: boolean } | null }[];
    }>(await next.client.request('GET', '/v1/users'));
    expect(listed.canStartSuperAdmin).toBe(true);
    expect(
      listed.items.find((item) => item.userId === next.userId)?.superAdminRemoval,
    ).toMatchObject({ pending: false, isFirst: true });
    expect((await remove(later.client, next.userId)).statusCode).toBe(409);

    expect((await later.client.request('POST', '/v1/users/me/step-down')).statusCode).toBe(201);
    const last = await next.client.request('POST', '/v1/users/me/step-down');
    expect(last.statusCode, last.body).toBe(409);
  });
});
