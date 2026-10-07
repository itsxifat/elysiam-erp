import { base32 } from '@better-auth/utils/base32';
import { withSystem } from '@elysium/db';
import { createTestUser } from '@elysium/db/testing';
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

/**
 * Super admins making super admins against real Postgres (D-659, D-666).
 *
 * The first super admin promotes an admin at once while they are the only one; from then on
 * a nomination waits for every super admin's yes. Only the first super admin starts one (the
 * owner's decision of 2026-10-07): whoever invites a person holds their set-password link.
 */

let harness: HttpHarness;
let first: { client: Client; userId: string };
let promoted: RoleClient;
let candidate: RoleClient;
let invitedLater: RoleClient;

async function superAdmin(name: string): Promise<{ client: Client; userId: string }> {
  const user = await createTestUser({ name, isSuperAdmin: true });
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
  const { totpURI } = JSON.parse(enabled.body) as { totpURI: string };
  const secret = new TextDecoder().decode(
    base32.decode(new URL(totpURI).searchParams.get('secret') ?? ''),
  );
  const { code } = await harness.auth.auth.api.generateTOTP({ body: { secret } });
  await client.request('POST', '/api/auth/two-factor/verify-totp', { body: { code } });
  const entered = await client.request('POST', '/v1/me/active-org', { body: { orgId: ORG_A } });
  expect(entered.statusCode, entered.body).toBe(201);
  return { client, userId: user.id };
}

async function isSuperAdmin(userId: string): Promise<boolean> {
  const [row] = await withSystem(async (tx) =>
    tx.execute<{ flag: boolean }>(
      sql`select is_super_admin as flag from iam.users where id = ${userId}`,
    ),
  );
  return row?.flag === true;
}

async function nominate(voter: Client, userId: string) {
  return voter.request('POST', `/v1/users/${userId}/super-admin`);
}

beforeAll(async () => {
  harness = await startHttpHarness('super-admin');
  first = await superAdmin('First');
  promoted = await harness.asRole('org_admin', ORG_A);
  candidate = await harness.asRole('org_admin', ORG_A);
  invitedLater = await harness.asRole('org_admin', ORG_A);

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

describe('super admins make super admins (D-659, D-666)', () => {
  it('refuses anyone who is not a super admin', async () => {
    const refused = await nominate(candidate.client, invitedLater.userId);
    expect(refused.statusCode, refused.body).toBe(403);
    expect(JSON.parse(refused.body)).toMatchObject({ code: 'USER_PROTECTED' });
  });

  it('the first super admin, alone, promotes an admin at once', async () => {
    const answer = await nominate(first.client, promoted.userId);
    expect(answer.statusCode, answer.body).toBe(201);
    expect(JSON.parse(answer.body)).toMatchObject({ outcome: 'promoted' });
    expect(await isSuperAdmin(promoted.userId)).toBe(true);
    const audited = await auditRowsFor(ORG_A, promoted.userId);
    expect(audited.map((row) => row.action)).toContain('iam.super_admin_promoted');
  });

  it('the second super admin cannot start a nomination, nor invite one (D-666)', async () => {
    const started = await nominate(promoted.client, candidate.userId);
    expect(started.statusCode, started.body).toBe(403);
    expect(started.body).toContain('Only the first super admin');
    expect(await isSuperAdmin(candidate.userId)).toBe(false);

    const invite = await promoted.client.request('POST', '/v1/users', {
      body: {
        email: `later-${Date.now()}@example.invalid`,
        name: 'Later',
        role: 'org_admin',
        branchIds: [],
        superAdmin: true,
      },
    });
    expect(invite.statusCode, invite.body).toBe(403);

    const listed = await promoted.client.request('GET', '/v1/users');
    expect(JSON.parse(listed.body)).toMatchObject({ canStartSuperAdmin: false });
    const mine = await first.client.request('GET', '/v1/users');
    expect(JSON.parse(mine.body)).toMatchObject({ canStartSuperAdmin: true });
  });

  it('from the third on, the first starts it and every super admin must say yes', async () => {
    const started = await nominate(first.client, candidate.userId);
    expect(started.statusCode, started.body).toBe(201);
    expect(JSON.parse(started.body)).toMatchObject({ outcome: 'pending', votes: 1, needed: 2 });
    expect(await isSuperAdmin(candidate.userId)).toBe(false);

    // The second super admin may vote on a nomination already started.
    const yes = await nominate(promoted.client, candidate.userId);
    expect(yes.statusCode, yes.body).toBe(201);
    expect(JSON.parse(yes.body)).toMatchObject({ outcome: 'promoted' });
    expect(await isSuperAdmin(candidate.userId)).toBe(true);
  });
});
