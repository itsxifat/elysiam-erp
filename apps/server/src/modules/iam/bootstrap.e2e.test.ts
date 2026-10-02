import { withSystem } from '@elysium/db';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startHttpHarness, type HttpHarness } from '../../testing/http-harness.js';
import { BootstrapRefused, bootstrapSuperAdmin, consoleUrlFrom, inviteLink } from './bootstrap.js';

/**
 * `pnpm admin:bootstrap` (M30): the first super admin on a new database, through the same
 * link the Staff screen hands out, redeemed and signed in with over real HTTP.
 */

let harness: HttpHarness;
const CONSOLE = 'https://erp.example.com';
const PASSWORD = 'a-long-first-admin-password-1';

beforeAll(async () => {
  harness = await startHttpHarness('admin-bootstrap');
}, 300_000);

afterAll(async () => {
  await harness?.close();
}, 60_000);

function tokenOf(link: string): string {
  const token = new URLSearchParams(new URL(link).hash.slice(1)).get('token');
  if (token === null) throw new Error(`no token in ${link}`);
  return token;
}

/** Take the flag off every super admin, as the owner role, so a case can start clean. */
async function noSuperAdmins(): Promise<void> {
  await withSystem((tx) =>
    tx.execute(sql`update iam.users set is_super_admin = false where is_super_admin`),
  );
}

describe('admin:bootstrap', () => {
  let first: Awaited<ReturnType<typeof bootstrapSuperAdmin>>;

  it('creates a super admin with a one-time invite link and audits it in every brand', async () => {
    first = await bootstrapSuperAdmin({
      email: 'Owner@Example.invalid',
      name: 'First Admin',
      consoleUrl: `${CONSOLE}/`,
    });

    expect(first.email).toBe('owner@example.invalid');
    expect(first.link.startsWith(`${CONSOLE}/accept-invite#token=`)).toBe(true);
    // D-402's invite lifetime: 72 hours, give or take the test's own runtime.
    const hours = (first.expiresAt.getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(71.9);
    expect(hours).toBeLessThanOrEqual(72);

    const rows = await withSystem((tx) =>
      tx.execute<{ is_super_admin: boolean; email_verified: boolean }>(sql`
        select is_super_admin, email_verified from iam.users where id = ${first.userId}
      `),
    );
    expect(rows[0]).toEqual({ is_super_admin: true, email_verified: true });

    const orgs = await withSystem((tx) =>
      tx.execute<{ n: number }>(sql`select count(*)::int as n from org.organizations`),
    );
    expect(first.auditedOrgs).toBe(orgs[0]?.n);
    let audited = 0;
    for (const org of await withSystem((tx) =>
      tx.execute<{ id: string }>(sql`select id from org.organizations`),
    )) {
      const entries = await withSystem(
        (tx) =>
          tx.execute<{ n: number; token_logged: number }>(sql`
            select count(*)::int as n,
                   count(*) filter (where after::text like ${`%${tokenOf(first.link)}%`})::int
                     as token_logged
            from audit.audit_log
            where action = 'iam.super_admin.bootstrapped' and entity_id = ${first.userId}
          `),
        { orgId: org.id },
      );
      audited += entries[0]?.n ?? 0;
      // The link is a credential: the audit row records that one exists, never the token.
      expect(entries[0]?.token_logged).toBe(0);
    }
    expect(audited).toBe(first.auditedOrgs);
  });

  it('gives a link that sets the password once, after which the person signs in', async () => {
    const client = harness.client();
    await client.request('GET', '/v1/auth/login-branding');
    const set = await client.request('POST', '/api/auth/reset-password', {
      body: { newPassword: PASSWORD, token: tokenOf(first.link) },
    });
    expect(set.statusCode, set.body).toBe(200);

    const again = await client.request('POST', '/api/auth/reset-password', {
      body: { newPassword: `${PASSWORD}-2`, token: tokenOf(first.link) },
    });
    expect(again.statusCode).toBeGreaterThanOrEqual(400);

    const signedIn = await client.request('POST', '/api/auth/sign-in/email', {
      body: { email: first.email, password: PASSWORD },
    });
    expect(signedIn.statusCode, signedIn.body).toBe(200);

    // §6: a super admin enrols a second factor before anything else.
    const me = await client.request('GET', '/v1/me/orgs');
    expect(me.statusCode).toBe(403);
    expect(me.body).toContain('TWO_FACTOR_ENROLMENT_REQUIRED');
  });

  it('refuses once a super admin exists', async () => {
    await expect(
      bootstrapSuperAdmin({ email: 'second@example.invalid', name: 'Second', consoleUrl: CONSOLE }),
    ).rejects.toThrow(/already exists/);
  });

  it('never promotes an existing account', async () => {
    await noSuperAdmins();
    try {
      await expect(
        bootstrapSuperAdmin({ email: first.email, name: 'Again', consoleUrl: CONSOLE }),
      ).rejects.toThrow(BootstrapRefused);
    } finally {
      await withSystem((tx) =>
        tx.execute(sql`update iam.users set is_super_admin = true where id = ${first.userId}`),
      );
    }
  });

  it('makes exactly one super admin when two operators run it at once', async () => {
    await noSuperAdmins();
    try {
      const outcomes = await Promise.allSettled([
        bootstrapSuperAdmin({ email: 'race-a@example.invalid', name: 'A', consoleUrl: CONSOLE }),
        bootstrapSuperAdmin({ email: 'race-b@example.invalid', name: 'B', consoleUrl: CONSOLE }),
      ]);
      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      const refused = outcomes.find((outcome) => outcome.status === 'rejected');
      expect(refused?.status === 'rejected' ? String(refused.reason) : '').toMatch(
        /already exists/,
      );
      const admins = await withSystem((tx) =>
        tx.execute<{ n: number }>(
          sql`select count(*)::int as n from iam.users where is_super_admin`,
        ),
      );
      expect(admins[0]?.n).toBe(1);
    } finally {
      await withSystem((tx) =>
        tx.execute(sql`update iam.users set is_super_admin = true where id = ${first.userId}`),
      );
    }
  });

  it('refuses a malformed address before touching the database', async () => {
    await expect(
      bootstrapSuperAdmin({ email: 'not-an-address', name: 'X', consoleUrl: CONSOLE }),
    ).rejects.toThrow(/email/);
  });
});

describe('the console address for the link', () => {
  it('prefers the flag, then CONSOLE_PUBLIC_URL, then the first trusted origin, then the API', () => {
    expect(consoleUrlFrom('https://a.example', { CONSOLE_PUBLIC_URL: 'https://b.example' })).toBe(
      'https://a.example',
    );
    expect(consoleUrlFrom(undefined, { CONSOLE_PUBLIC_URL: 'https://b.example' })).toBe(
      'https://b.example',
    );
    expect(
      consoleUrlFrom(undefined, {
        TRUSTED_ORIGINS: 'https://console.example, https://portal.example',
      }),
    ).toBe('https://console.example');
    expect(consoleUrlFrom(undefined, { API_PUBLIC_URL: 'https://erp.example/api' })).toBe(
      'https://erp.example',
    );
    expect(() => consoleUrlFrom(undefined, {})).toThrow(BootstrapRefused);
  });

  it('puts the token in the fragment, encoded, with one slash before the path', () => {
    expect(inviteLink('https://erp.example.com//', 'a+b/c=')).toBe(
      'https://erp.example.com/accept-invite#token=a%2Bb%2Fc%3D',
    );
  });
});
