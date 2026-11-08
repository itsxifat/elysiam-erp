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
 * Super admins making super admins against real Postgres (D-954): any super admin promotes an
 * active admin of the brand, at once. No votes, no "first super admin".
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

/** `iam.promote_super_admin` called straight, as the application role, acting as `actorId`. */
function promoteAs(actorId: string, candidateId: string) {
  return withOrg({ orgId: ORG_A, userId: actorId }, (tx) =>
    tx.execute(sql`select iam.promote_super_admin(${candidateId})`),
  );
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

describe('super admins make super admins (D-954)', () => {
  it('refuses anyone who is not a super admin', async () => {
    const refused = await nominate(candidate.client, invitedLater.userId);
    expect(refused.statusCode, refused.body).toBe(403);
    expect(JSON.parse(refused.body)).toMatchObject({ code: 'USER_PROTECTED' });
  });

  it('a super admin promotes an admin at once', async () => {
    const answer = await nominate(first.client, promoted.userId);
    expect(answer.statusCode, answer.body).toBe(201);
    expect(JSON.parse(answer.body)).toMatchObject({ outcome: 'promoted' });
    expect(await isSuperAdmin(promoted.userId)).toBe(true);
    const audited = await auditRowsFor(ORG_A, promoted.userId);
    expect(audited.map((row) => row.action)).toContain('iam.super_admin_promoted');
  });

  it('any other super admin promotes at once too, and may invite one', async () => {
    const listed = await promoted.client.request('GET', '/v1/users');
    expect(JSON.parse(listed.body)).toMatchObject({ canStartSuperAdmin: true });

    const answer = await nominate(promoted.client, candidate.userId);
    expect(answer.statusCode, answer.body).toBe(201);
    expect(JSON.parse(answer.body)).toMatchObject({ outcome: 'promoted' });
    expect(await isSuperAdmin(candidate.userId)).toBe(true);

    const invite = await promoted.client.request('POST', '/v1/users', {
      body: {
        email: `later-${Date.now()}@example.invalid`,
        name: 'Later',
        role: 'org_admin',
        branchIds: [],
        superAdmin: true,
      },
    });
    expect(invite.statusCode, invite.body).toBe(201);
    expect(JSON.parse(invite.body)).toMatchObject({ superAdmin: { outcome: 'promoted' } });
  });
});

describe('the database refuses a forged promotion, whoever calls it (D-954)', () => {
  it('refuses an actor who is not a super admin', async () => {
    const plain = await createTestUser({ name: 'Plain admin', twoFactorEnabled: true });
    await grantMembership({ userId: plain.id, orgId: ORG_A, role: 'org_admin' });
    const forged = await refusal(promoteAs(plain.id, invitedLater.userId));
    expect(forged.code).toBe('42501');
    expect(forged.text).toContain('only an active super admin makes a super admin');
    expect(await isSuperAdmin(invitedLater.userId)).toBe(false);
  });

  it('refuses a super admin without two-step sign-in', async () => {
    const bare = await createTestUser({ name: 'No second factor', isSuperAdmin: true });
    const forged = await refusal(promoteAs(bare.id, invitedLater.userId));
    expect(forged.code).toBe('42501');
    expect(forged.text).toContain('only an active super admin makes a super admin');
    expect(await isSuperAdmin(invitedLater.userId)).toBe(false);
  });

  it('refuses promoting yourself', async () => {
    const forged = await refusal(promoteAs(invitedLater.userId, invitedLater.userId));
    expect(forged.code).toBe('42501');
    expect(forged.text).toContain('nobody makes themselves a super admin');
  });

  it('refuses a candidate who is not an active admin of this brand', async () => {
    const seller = await createTestUser({ name: 'Seller' });
    await grantMembership({ userId: seller.id, orgId: ORG_A, role: 'sales' });
    const forged = await refusal(promoteAs(first.userId, seller.id));
    expect(forged.code).toBe('23514');
    expect(forged.text).toContain('is not an active admin of this brand');
    expect(await isSuperAdmin(seller.id)).toBe(false);
  });

  it('refuses setting the flag past the function', async () => {
    const forged = await refusal(
      withOrg({ orgId: ORG_A, userId: first.userId }, (tx) =>
        tx.execute(
          sql`update iam.users set is_super_admin = true where id = ${invitedLater.userId}`,
        ),
      ),
    );
    expect(forged.code).toBe('42501');
    expect(await isSuperAdmin(invitedLater.userId)).toBe(false);
  });
});
