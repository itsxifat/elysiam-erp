import { withGlobal } from '@elysium/db';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  auditRowsFor,
  ORG_A,
  PASSWORD,
  startHttpHarness,
  type Client,
  type HttpHarness,
} from '../../testing/http-harness.js';
import {
  codeFor,
  enrol,
  enter,
  json,
  person,
  secretOf,
  signIn,
  signInFully,
} from './sign-in.testing.js';

/**
 * My account on real Postgres (M40, D-693 to D-695): the name, the password, the second
 * factor and the devices of the person signed in — and only theirs. Every outcome is checked by
 * signing in for real afterwards, through Better Auth, the CSRF check and the enrolment wall:
 * "the old password stops working" means nothing until a sign-in with it fails.
 */

let harness: HttpHarness;

beforeAll(async () => {
  harness = await startHttpHarness('account');
}, 300_000);

afterAll(async () => {
  await harness?.close();
}, 60_000);

interface AccountBody {
  name: string;
  roles: string[];
  isSuperAdmin: boolean;
  hasPassword: boolean;
  twoFactor: {
    enabled: boolean;
    enabledAt: string | null;
    backupCodesLeft: number | null;
    required: boolean;
    requiredByRoles: string[];
    canTurnOff: boolean;
    turnOffBlockedBy: string | null;
  };
}

interface SessionBody {
  id: string;
  browser: string | null;
  system: string | null;
  kind: string;
  address: string | null;
  current: boolean;
}

async function account(client: Client): Promise<AccountBody> {
  const response = await client.request('GET', '/v1/account');
  expect(response.statusCode, response.body).toBe(200);
  return json<AccountBody>(response);
}

async function sessions(client: Client): Promise<SessionBody[]> {
  const response = await client.request('GET', '/v1/account/sessions');
  expect(response.statusCode, response.body).toBe(200);
  return json<{ items: SessionBody[] }>(response).items;
}

/** A warehouse person (nothing requires two-step) who set it up anyway. */
async function volunteer(): Promise<{
  email: string;
  userId: string;
  secret: string;
  backupCodes: string[];
  client: Client;
}> {
  const who = await person(harness, ['warehouse']);
  const { client } = await signIn(harness, who.email);
  const { secret, backupCodes } = await enrol(harness, client);
  expect((await enter(client)).statusCode).toBe(201);
  return { ...who, secret, backupCodes, client };
}

describe('reading and renaming', () => {
  it('shows a sales person their roles and two-step state, and renames them, audited', async () => {
    const who = await person(harness, ['sales']);
    const client = await signInFully(harness, who.email);

    const before = await account(client);
    expect(before).toMatchObject({
      roles: ['sales'],
      isSuperAdmin: false,
      hasPassword: true,
      twoFactor: {
        enabled: false,
        required: false,
        requiredByRoles: [],
        canTurnOff: false,
        turnOffBlockedBy: null,
        backupCodesLeft: null,
      },
    });

    const renamed = await client.request('PATCH', '/v1/account/profile', {
      body: { name: '  Rahima Akter  ' },
    });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect((await account(client)).name).toBe('Rahima Akter');
    const empty = await client.request('PATCH', '/v1/account/profile', { body: { name: ' ' } });
    expect(empty.statusCode).toBe(400);

    const rows = await auditRowsFor(ORG_A, who.userId);
    expect(rows.find((row) => row.action === 'account.profile_updated')).toMatchObject({
      actor_user_id: who.userId,
      after: { name: 'Rahima Akter' },
    });
  });

  it('tells an admin their role requires it and it cannot be turned off', async () => {
    const who = await person(harness, ['org_admin']);
    const { client } = await signIn(harness, who.email);
    await enrol(harness, client);
    expect((await enter(client)).statusCode).toBe(201);
    const view = await account(client);
    expect(view.twoFactor).toMatchObject({
      enabled: true,
      required: true,
      requiredByRoles: ['org_admin'],
      canTurnOff: false,
      turnOffBlockedBy: 'role',
      backupCodesLeft: 10,
    });
    // Stamped by the database when the factor was verified (migration 0141).
    expect(view.twoFactor.enabledAt).not.toBeNull();
  });
});

describe('changing the password', () => {
  it('stops the old password, and with "sign out other devices" ends the others only', async () => {
    const who = await person(harness, ['sales']);
    const here = await signInFully(harness, who.email);
    const elsewhere = await signInFully(harness, who.email);

    const changed = await here.request('POST', '/api/auth/change-password', {
      body: {
        currentPassword: PASSWORD,
        newPassword: 'a-much-longer-new-passphrase',
        revokeOtherSessions: true,
      },
    });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(changed.body).not.toMatch(/"token"/);

    // The other device is signed out; this one holds a fresh session, back in the brand.
    expect((await elsewhere.request('GET', '/v1/me')).statusCode).toBe(401);
    expect((await enter(here)).statusCode).toBe(201);
    expect((await here.request('GET', '/v1/account')).statusCode).toBe(200);

    expect((await signIn(harness, who.email, PASSWORD)).response.statusCode).toBe(401);
    expect(
      (await signIn(harness, who.email, 'a-much-longer-new-passphrase')).response.statusCode,
    ).toBe(200);

    const rows = await auditRowsFor(ORG_A, who.userId);
    expect(rows.some((row) => row.action === 'auth.password_changed')).toBe(true);
  });

  it('keeps the other devices signed in when not asked to, and refuses a wrong current password', async () => {
    const who = await person(harness, ['sales']);
    const here = await signInFully(harness, who.email);
    const elsewhere = await signInFully(harness, who.email);

    const wrong = await here.request('POST', '/api/auth/change-password', {
      body: { currentPassword: 'not-my-password', newPassword: 'another-long-passphrase' },
    });
    expect(wrong.statusCode).toBe(400);

    const changed = await here.request('POST', '/api/auth/change-password', {
      body: { currentPassword: PASSWORD, newPassword: 'another-long-passphrase' },
    });
    expect(changed.statusCode, changed.body).toBe(200);
    expect((await elsewhere.request('GET', '/v1/me')).statusCode).toBe(200);
    expect((await here.request('GET', '/v1/me')).statusCode).toBe(200);
  });
});

describe('moving two-step sign-in to a new phone', () => {
  it('needs the password and a current code, and swaps phones only once the new one answers', async () => {
    const who = await volunteer();
    const { client } = who;

    const wrongPassword = await client.request('POST', '/v1/account/two-factor/replace', {
      body: { password: 'not-my-password', code: await codeFor(harness, who.secret) },
    });
    expect(wrongPassword.statusCode).toBe(400);
    expect(json<{ code: string }>(wrongPassword).code).toBe('ACCOUNT_PASSWORD_INVALID');

    const wrongCode = await client.request('POST', '/v1/account/two-factor/replace', {
      body: { password: PASSWORD, code: '000000' },
    });
    expect(wrongCode.statusCode).toBe(400);
    expect(json<{ code: string }>(wrongCode).code).toBe('TWO_FACTOR_CODE_INVALID');

    const started = await client.request('POST', '/v1/account/two-factor/replace', {
      body: { password: PASSWORD, code: await codeFor(harness, who.secret) },
    });
    expect(started.statusCode, started.body).toBe(200);
    expect(started.headers['cache-control']).toBe('no-store');
    const newSecret = secretOf(json<{ totpURI: string }>(started).totpURI);
    expect(newSecret).not.toBe(who.secret);

    // Not swapped yet: the old phone still signs in.
    await signInFully(harness, who.email, { secret: who.secret });

    const badConfirm = await client.request('POST', '/v1/account/two-factor/replace/confirm', {
      body: { code: '123456' },
    });
    expect(badConfirm.statusCode).toBe(400);
    const confirmed = await client.request('POST', '/v1/account/two-factor/replace/confirm', {
      body: { code: await codeFor(harness, newSecret) },
    });
    expect(confirmed.statusCode, confirmed.body).toBe(200);

    // The old phone no longer works; the new one does; the backup codes are the same.
    const old = await signIn(harness, who.email);
    const oldCode = await old.client.request('POST', '/api/auth/two-factor/verify-totp', {
      body: { code: await codeFor(harness, who.secret) },
    });
    expect(oldCode.statusCode).toBe(401);
    await signInFully(harness, who.email, { secret: newSecret });
    const backup = await signIn(harness, who.email);
    const withBackup = await backup.client.request(
      'POST',
      '/api/auth/two-factor/verify-backup-code',
      { body: { code: who.backupCodes[0] } },
    );
    expect(withBackup.statusCode, withBackup.body).toBe(200);

    // Used once, gone.
    const again = await client.request('POST', '/v1/account/two-factor/replace/confirm', {
      body: { code: await codeFor(harness, newSecret) },
    });
    expect(json<{ code: string }>(again).code).toBe('TWO_FACTOR_REPLACEMENT_EXPIRED');

    const actions = (await auditRowsFor(ORG_A, who.userId)).map((row) => row.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'account.two_factor_replacement_started',
        'account.two_factor_replaced',
      ]),
    );
    // The secret never reaches the audit log.
    expect(JSON.stringify(await auditRowsFor(ORG_A, who.userId))).not.toContain(newSecret);
  });

  it('takes a backup code instead of the authenticator, and uses it up', async () => {
    const who = await volunteer();
    const code = who.backupCodes[1] ?? '';
    const started = await who.client.request('POST', '/v1/account/two-factor/replace', {
      body: { password: PASSWORD, code },
    });
    expect(started.statusCode, started.body).toBe(200);
    const reused = await who.client.request('POST', '/v1/account/two-factor/replace', {
      body: { password: PASSWORD, code },
    });
    expect(json<{ code: string }>(reused).code).toBe('TWO_FACTOR_CODE_INVALID');
  });

  it('locks two-step sign-in after ten wrong codes, here and at sign-in alike', async () => {
    const who = await volunteer();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const wrong = await who.client.request('POST', '/v1/account/two-factor/turn-off', {
        body: { password: PASSWORD, code: '000000' },
      });
      expect(wrong.statusCode).toBe(400);
    }
    const locked = await who.client.request('POST', '/v1/account/two-factor/turn-off', {
      body: { password: PASSWORD, code: await codeFor(harness, who.secret) },
    });
    expect(locked.statusCode).toBe(429);
    expect(json<{ code: string }>(locked).code).toBe('TWO_FACTOR_LOCKED');

    const atSignIn = await signIn(harness, who.email);
    const refused = await atSignIn.client.request('POST', '/api/auth/two-factor/verify-totp', {
      body: { code: await codeFor(harness, who.secret) },
    });
    expect(refused.statusCode).toBe(429);
  });
});

describe('new backup codes', () => {
  it('needs the password, and the old codes stop working', async () => {
    const who = await volunteer();
    const noPassword = await who.client.request(
      'POST',
      '/api/auth/two-factor/generate-backup-codes',
      {
        body: {},
      },
    );
    expect(noPassword.statusCode).toBe(400);
    const wrong = await who.client.request('POST', '/api/auth/two-factor/generate-backup-codes', {
      body: { password: 'not-my-password' },
    });
    expect(wrong.statusCode).toBeGreaterThanOrEqual(400);

    const fresh = await who.client.request('POST', '/api/auth/two-factor/generate-backup-codes', {
      body: { password: PASSWORD },
    });
    expect(fresh.statusCode, fresh.body).toBe(200);
    const codes = json<{ backupCodes: string[] }>(fresh).backupCodes;
    expect(codes).toHaveLength(10);

    const old = await signIn(harness, who.email);
    const oldCode = await old.client.request('POST', '/api/auth/two-factor/verify-backup-code', {
      body: { code: who.backupCodes[0] },
    });
    expect(oldCode.statusCode).toBe(401);
    const next = await signIn(harness, who.email);
    const newCode = await next.client.request('POST', '/api/auth/two-factor/verify-backup-code', {
      body: { code: codes[0] },
    });
    expect(newCode.statusCode, newCode.body).toBe(200);

    expect((await account(who.client)).twoFactor.backupCodesLeft).toBe(9);
    const actions = (await auditRowsFor(ORG_A, who.userId)).map((row) => row.action);
    expect(actions).toContain('auth.backup_codes_regenerated');
  });
});

describe('turning two-step sign-in off', () => {
  it('is allowed where nothing requires it, and the next sign-in asks for no code', async () => {
    const who = await volunteer();
    expect((await account(who.client)).twoFactor).toMatchObject({
      enabled: true,
      required: false,
      canTurnOff: true,
    });

    const wrongPassword = await who.client.request('POST', '/v1/account/two-factor/turn-off', {
      body: { password: 'not-my-password', code: await codeFor(harness, who.secret) },
    });
    expect(json<{ code: string }>(wrongPassword).code).toBe('ACCOUNT_PASSWORD_INVALID');

    const off = await who.client.request('POST', '/v1/account/two-factor/turn-off', {
      body: { password: PASSWORD, code: await codeFor(harness, who.secret) },
    });
    expect(off.statusCode, off.body).toBe(200);
    // This session stays.
    expect((await account(who.client)).twoFactor.enabled).toBe(false);
    const again = await signIn(harness, who.email);
    expect(json<{ twoFactorRedirect?: boolean }>(again.response).twoFactorRedirect).toBeUndefined();
    expect((await enter(again.client)).statusCode).toBe(201);

    const rows = await auditRowsFor(ORG_A, who.userId);
    // The audit log redacts anything named like a factor; the row and its actor are the record.
    expect(rows.find((row) => row.action === 'account.two_factor_turned_off')).toMatchObject({
      actor_user_id: who.userId,
      operation: 'update',
    });
  });

  it('is refused for a role that requires it, and for a super admin', async () => {
    const admin = await person(harness, ['org_admin']);
    const signedIn = await signIn(harness, admin.email);
    const { secret } = await enrol(harness, signedIn.client);
    expect((await enter(signedIn.client)).statusCode).toBe(201);
    const refused = await signedIn.client.request('POST', '/v1/account/two-factor/turn-off', {
      body: { password: PASSWORD, code: await codeFor(harness, secret) },
    });
    expect(refused.statusCode).toBe(409);
    expect(json<{ code: string }>(refused).code).toBe('TWO_FACTOR_REQUIRED');

    const root = await person(harness, [], { isSuperAdmin: true });
    const rootIn = await signIn(harness, root.email);
    const rootFactor = await enrol(harness, rootIn.client);
    expect((await enter(rootIn.client)).statusCode).toBe(201);
    expect((await account(rootIn.client)).twoFactor.turnOffBlockedBy).toBe('super_admin');
    const rootRefused = await rootIn.client.request('POST', '/v1/account/two-factor/turn-off', {
      body: { password: PASSWORD, code: await codeFor(harness, rootFactor.secret) },
    });
    expect(json<{ code: string }>(rootRefused).code).toBe('TWO_FACTOR_REQUIRED');

    // Still on for both.
    for (const id of [admin.userId, root.userId]) {
      const [row] = await withGlobal((tx) =>
        tx.execute<{ two_factor_enabled: boolean }>(
          sql`select two_factor_enabled from iam.users where id = ${id}`,
        ),
      );
      expect(row?.two_factor_enabled).toBe(true);
    }
  });

  it("keeps Better Auth's own password-only switch closed", async () => {
    const who = await volunteer();
    const direct = await who.client.request('POST', '/api/auth/two-factor/disable', {
      body: { password: PASSWORD },
    });
    expect(direct.statusCode).toBe(404);
    expect((await account(who.client)).twoFactor.enabled).toBe(true);
  });
});

describe('devices', () => {
  it('lists this and the other devices with the address hidden, and signs others out', async () => {
    const who = await person(harness, ['sales']);
    const here = await signInFully(harness, who.email);
    const phone = await signInFully(harness, who.email);
    const laptop = await signInFully(harness, who.email);

    const listed = await sessions(here);
    expect(listed).toHaveLength(3);
    expect(listed.filter((entry) => entry.current)).toHaveLength(1);
    for (const entry of listed) {
      expect(entry.address).toMatch(/^\d+\.\d+\.\d+\.x$/);
      expect(JSON.stringify(entry)).not.toMatch(/token/i);
    }

    const current = listed.find((entry) => entry.current);
    const refused = await here.request('DELETE', `/v1/account/sessions/${current?.id ?? ''}`);
    expect(refused.statusCode).toBe(409);
    expect(json<{ code: string }>(refused).code).toBe('SESSION_CURRENT');

    const phoneSession = (await sessions(phone)).find((entry) => entry.current);
    const ended = await here.request('DELETE', `/v1/account/sessions/${phoneSession?.id ?? ''}`);
    expect(ended.statusCode, ended.body).toBe(200);
    expect((await phone.request('GET', '/v1/me')).statusCode).toBe(401);
    expect((await laptop.request('GET', '/v1/me')).statusCode).toBe(200);

    const missing = await here.request('DELETE', '/v1/account/sessions/no-such-session');
    expect(missing.statusCode).toBe(404);

    const others = await here.request('POST', '/v1/account/sessions/sign-out-others');
    expect(others.statusCode, others.body).toBe(200);
    expect(json<{ sessionsEnded: number }>(others).sessionsEnded).toBe(1);
    expect((await laptop.request('GET', '/v1/me')).statusCode).toBe(401);
    expect((await here.request('GET', '/v1/me')).statusCode).toBe(200);
    expect(await sessions(here)).toHaveLength(1);

    const actions = (await auditRowsFor(ORG_A, who.userId)).map((row) => row.action);
    expect(actions).toEqual(
      expect.arrayContaining(['account.session_ended', 'account.other_sessions_ended']),
    );
  });

  it("never reaches another person's session", async () => {
    const one = await person(harness, ['sales']);
    const other = await person(harness, ['sales']);
    const mine = await signInFully(harness, one.email);
    const theirs = await signInFully(harness, other.email);
    const theirSession = (await sessions(theirs)).find((entry) => entry.current);

    const reached = await mine.request('DELETE', `/v1/account/sessions/${theirSession?.id ?? ''}`);
    expect(reached.statusCode).toBe(404);
    expect((await theirs.request('GET', '/v1/me')).statusCode).toBe(200);
    expect((await sessions(mine)).map((entry) => entry.id)).not.toContain(theirSession?.id);
  });
});
