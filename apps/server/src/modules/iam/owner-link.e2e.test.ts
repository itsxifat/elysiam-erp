import { generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto';

import { withGlobal, withSystem } from '@elysium/db';
import {
  assembleOwnerLink,
  encodeOwnerLinkPayload,
  type OwnerLinkClaims,
} from '@elysium/domain/iam';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ORG_A,
  startHttpHarness,
  type Client,
  type HttpHarness,
  type RoleClient,
} from '../../testing/http-harness.js';
import { seedProductWithSkus } from '../inventory/inventory.testing.js';
import { seedCustomer, seedOrder } from '../orders/orders.testing.js';

/**
 * The owner sign-in link, end to end (M31 check 4, D-473).
 *
 * The brand is `elysium-lifestyle-bd` (ORG_A) and its public key is a fresh Ed25519 key;
 * links are minted here with the private half exactly as the minter would
 * (`packages/domain/src/iam/owner-link.ts`). A good link opens a two-hour session that
 * passes the enrolment wall and lands in the brand; a replayed, expired, wrong-audience,
 * wrong-key, tampered, oversize or malformed one is refused with one identical answer. An
 * owner is never on the Staff screen, and on a record is "Owner" to everyone but another
 * owner.
 */

const AUDIENCE = 'elysium-lifestyle-bd';
const keys = generateKeyPairSync('ed25519');
const otherKeys = generateKeyPairSync('ed25519');

let harness: HttpHarness;
let admin: RoleClient;
const saved = {
  key: process.env.OWNER_LINK_PUBLIC_KEY,
  slug: process.env.ERP_BRAND_SLUG,
};

function claims(overrides: Partial<OwnerLinkClaims> = {}): OwnerLinkClaims {
  const now = Math.floor(Date.now() / 1000);
  return {
    v: 1,
    aud: AUDIENCE,
    sub: 'owner.one@example.invalid',
    name: 'Owner One',
    jti: randomUUID(),
    iat: now,
    exp: now + 60,
    ...overrides,
  };
}

function mint(c: OwnerLinkClaims, key: KeyObject = keys.privateKey): string {
  const payload = encodeOwnerLinkPayload(c);
  return assembleOwnerLink(payload, sign(null, Buffer.from(payload, 'utf8'), key));
}

async function present(client: Client, token: unknown) {
  // A GET first, as the console's page does, for the CSRF cookie.
  await client.request('GET', '/v1/auth/login-branding');
  return client.request('POST', '/v1/auth/owner-link', { body: { token } });
}

/** Everything an error says, down its causes: a database refusal arrives wrapped. */
async function failure(work: Promise<unknown>): Promise<string> {
  try {
    await work;
    return '';
  } catch (error) {
    const lines: string[] = [];
    for (let cause: unknown = error; cause instanceof Error; cause = cause.cause) {
      lines.push(cause.message);
    }
    return lines.join('\n');
  }
}

/** A refusal's body with the request-specific `instance` dropped: every refusal must match. */
function refusal(body: string): Record<string, unknown> {
  const { instance: _instance, ...rest } = JSON.parse(body) as Record<string, unknown>;
  return rest;
}

beforeAll(async () => {
  process.env.OWNER_LINK_PUBLIC_KEY = keys.publicKey
    .export({ format: 'der', type: 'spki' })
    .toString('base64');
  process.env.ERP_BRAND_SLUG = AUDIENCE;
  harness = await startHttpHarness('owner-link');
  admin = await harness.asRole('org_admin', ORG_A);
}, 300_000);

afterAll(async () => {
  await harness?.close();
  if (saved.key === undefined) delete process.env.OWNER_LINK_PUBLIC_KEY;
  else process.env.OWNER_LINK_PUBLIC_KEY = saved.key;
  if (saved.slug === undefined) delete process.env.ERP_BRAND_SLUG;
  else process.env.ERP_BRAND_SLUG = saved.slug;
}, 120_000);

let owner: Client;
let ownerId = '';

describe('a valid link', () => {
  it('signs the owner in once, into the brand, past the enrolment wall', async () => {
    owner = harness.client();
    const response = await present(owner, mint(claims()));
    expect(response.statusCode, response.body).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ ok: true });
    expect(String(response.headers['cache-control'])).toContain('no-store');
    // The session cookie, as a sign-in sets it, and no token in the body.
    const raw: unknown = response.headers['set-cookie'];
    const cookies = Array.isArray(raw) ? raw.map(String) : typeof raw === 'string' ? [raw] : [];
    expect(cookies.some((cookie) => cookie.includes('session_token='))).toBe(true);
    expect(response.body).not.toMatch(/token/);

    const me = await owner.request('GET', '/v1/me');
    expect(me.statusCode, me.body).toBe(200);
    const context = JSON.parse(me.body) as {
      userId: string;
      orgId: string;
      isSuperAdmin: boolean;
      isOwner?: boolean;
    };
    expect(context).toMatchObject({ orgId: ORG_A, isSuperAdmin: true, isOwner: true });
    ownerId = context.userId;

    // A super admin with no second factor here, yet not walled: the link carried it.
    const staff = await owner.request('GET', '/v1/users');
    expect(staff.statusCode, staff.body).toBe(200);

    const [row] = await withGlobal((tx) =>
      tx.execute<{
        is_owner: boolean;
        is_super_admin: boolean;
        has_password: boolean;
        sessions: number;
        seconds: number;
      }>(sql`
        select u.is_owner, u.is_super_admin,
               exists (select 1 from iam.accounts a where a.user_id = u.id) as has_password,
               (select count(*)::int from iam.sessions s where s.user_id = u.id and s.owner_link)
                 as sessions,
               (select extract(epoch from max(s.expires_at - s.created_at))::int
                  from iam.sessions s where s.user_id = u.id) as seconds
        from iam.users u where u.id = ${ownerId}
      `),
    );
    expect(row).toMatchObject({
      is_owner: true,
      is_super_admin: true,
      has_password: false,
      sessions: 1,
    });
    expect(row?.seconds).toBeGreaterThan(7_190);
    expect(row?.seconds).toBeLessThanOrEqual(7_200);

    const audited = await withSystem(
      (tx) =>
        tx.execute<{ n: number }>(sql`
          select count(*)::int as n from audit.audit_log
          where actor_user_id = ${ownerId} and action = 'auth.owner_link_signed_in'
        `),
      { orgId: ORG_A },
    );
    expect(audited[0]?.n).toBe(1);
  });

  it('reuses the owner’s identity on the next link, and keeps the name the minter sends', async () => {
    const again = harness.client();
    const response = await present(again, mint(claims({ name: 'Owner One Renamed' })));
    expect(response.statusCode, response.body).toBe(200);
    const me = JSON.parse((await again.request('GET', '/v1/me')).body) as { userId: string };
    expect(me.userId).toBe(ownerId);
    const [row] = await withGlobal((tx) =>
      tx.execute<{ name: string }>(sql`select name from iam.users where id = ${ownerId}`),
    );
    expect(row?.name).toBe('Owner One Renamed');
  });
});

describe('every bad link is the same refusal', () => {
  it('refuses a replayed, expired, wrong-audience, wrong-key, tampered, oversize or malformed link alike', async () => {
    const used = mint(claims());
    expect((await present(harness.client(), used)).statusCode).toBe(200);

    const now = Math.floor(Date.now() / 1000);
    const good = claims();
    const goodPayload = encodeOwnerLinkPayload(good);
    const goodSignature = sign(null, Buffer.from(goodPayload, 'utf8'), keys.privateKey);
    const tamperedPayload = encodeOwnerLinkPayload({
      ...good,
      sub: 'someone.else@example.invalid',
    });

    const bad: Record<string, unknown> = {
      replayed: used,
      expired: mint(claims({ iat: now - 600, exp: now - 540 })),
      notYetValid: mint(claims({ iat: now + 600, exp: now + 660 })),
      tooLong: mint(claims({ iat: now, exp: now + 3_600 })),
      wrongAudience: mint(claims({ aud: 'oura-lifestyle' })),
      wrongKey: mint(claims(), otherKeys.privateKey),
      tampered: assembleOwnerLink(tamperedPayload, goodSignature),
      oversize: `${'A'.repeat(3_000)}.${'B'.repeat(86)}`,
      garbage: 'not-a-link',
      notAString: 42,
      empty: '',
    };

    const answers = new Map<string, { status: number; body: Record<string, unknown> }>();
    for (const [name, token] of Object.entries(bad)) {
      const response = await present(harness.client(), token);
      answers.set(name, { status: response.statusCode, body: refusal(response.body) });
      expect(response.headers['set-cookie'] ?? [], name).not.toEqual(
        expect.arrayContaining([expect.stringMatching(/session_token=[^;]+/)]),
      );
    }
    const first = answers.get('replayed');
    expect(first?.status).toBe(401);
    for (const [name, answer] of answers) expect(answer, name).toEqual(first);
    // The reason is the server log's; the caller reads one sentence.
    expect(first?.body).toMatchObject({ code: 'UNAUTHENTICATED' });

    // The good link above was never presented; the tampered one did not spend it.
    expect(
      (await present(harness.client(), assembleOwnerLink(goodPayload, goodSignature))).statusCode,
    ).toBe(200);
  });

  it('never takes over an account that is not an owner’s', async () => {
    // The org admin's own address, in a link: a staff account is someone else's sign-in.
    const response = await present(harness.client(), mint(claims({ sub: admin.email })));
    expect(response.statusCode).toBe(401);
    const [row] = await withGlobal((tx) =>
      tx.execute<{ is_owner: boolean; is_super_admin: boolean }>(
        sql`select is_owner, is_super_admin from iam.users where id = ${admin.userId}`,
      ),
    );
    expect(row).toEqual({ is_owner: false, is_super_admin: false });
  });

  it('cannot be reached through Better Auth’s own router', async () => {
    const client = harness.client();
    await client.request('GET', '/v1/auth/login-branding');
    const response = await client.request('POST', '/api/auth/owner-session', {
      body: { userId: ownerId, activeOrgId: ORG_A },
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('the session it opens', () => {
  it('ends two hours after it began, whatever a refresh did to its expiry', async () => {
    const client = harness.client();
    expect((await present(client, mint(claims()))).statusCode).toBe(200);
    const me = JSON.parse((await client.request('GET', '/v1/me')).body) as { userId: string };
    // Aged past two hours, and its expiry pushed out as a refresh would.
    await withGlobal((tx) =>
      tx.execute(sql`
        update iam.sessions
        set created_at = now() - interval '2 hours 1 minute',
            expires_at = now() + interval '10 hours'
        where user_id = ${me.userId} and owner_link
          and created_at > now() - interval '1 minute'
      `),
    );
    expect((await client.request('GET', '/v1/me')).statusCode).toBe(401);
    // Better Auth's own endpoints too, beyond reading the session and signing out.
    const update = await client.request('POST', '/api/auth/update-user', {
      body: { name: 'Owner' },
    });
    expect(update.statusCode).toBe(401);
  });

  it('opens once when the same link arrives twice at once', async () => {
    const token = mint(claims());
    const [first, second] = [harness.client(), harness.client()];
    await Promise.all([
      first.request('GET', '/v1/auth/login-branding'),
      second.request('GET', '/v1/auth/login-branding'),
    ]);
    const answers = await Promise.all([
      first.request('POST', '/v1/auth/owner-link', { body: { token } }),
      second.request('POST', '/v1/auth/owner-link', { body: { token } }),
    ]);
    expect(answers.map((answer) => answer.statusCode).sort()).toEqual([200, 401]);
  });
});

describe('an owner on the brand’s records', () => {
  it('is listed as an owner, nameless to staff, and not to be acted on as staff', async () => {
    // Super admins show on the Staff list (D-658); an owner shows as "Owner", with no name
    // or email to anyone who is not an owner.
    const list = await admin.client.request('GET', '/v1/users');
    expect(list.statusCode).toBe(200);
    const row = (
      JSON.parse(list.body) as {
        items: { userId: string; name: string; email: string; isOwner?: boolean }[];
      }
    ).items.find((item) => item.userId === ownerId);
    expect(row).toMatchObject({ isOwner: true, name: '', email: '' });
    expect(list.body).not.toContain('owner.one@example.invalid');
    const link = await admin.client.request('POST', `/v1/users/${ownerId}/password-link`, {
      body: { reason: 'Trying to give the owner a password' },
    });
    expect([403, 404]).toContain(link.statusCode);
  });

  it('cannot be given a role or an invite here, even by another owner', async () => {
    const another = harness.client();
    expect(
      (
        await present(
          another,
          mint(claims({ sub: 'owner.three@example.invalid', name: 'Owner Three' })),
        )
      ).statusCode,
    ).toBe(200);
    const invite = await another.request('POST', '/v1/users', {
      body: { email: 'owner.one@example.invalid', name: 'Owner', role: 'sales', branchIds: [] },
    });
    expect(invite.statusCode, invite.body).toBe(403);
    expect(JSON.parse(invite.body)).toMatchObject({ code: 'USER_PROTECTED' });
    expect(
      await failure(
        withSystem(
          (tx) =>
            tx.execute(sql`
              insert into iam.memberships (org_id, user_id, role, granted_by)
              values (${ORG_A}, ${ownerId}, 'sales', ${admin.userId})
            `),
          { orgId: ORG_A },
        ),
      ),
    ).toContain('OWNER_HAS_NO_ROLE');
    expect(
      await failure(
        withGlobal((tx) =>
          tx.execute(sql`update iam.users set is_owner = false where id = ${ownerId}`),
        ),
      ),
    ).toContain('OWNER_FLAG_FIXED');
    // Nor can the application make one by hand: only the owner role, through the link.
    expect(
      await failure(
        withGlobal((tx) =>
          tx.execute(sql`
            insert into iam.users (id, email, name, email_verified, is_owner)
            values ('usr_forged_owner', 'forged@example.invalid', 'Forged', true, true)
          `),
        ),
      ),
    ).toContain('only the owner role makes an owner');
    // The single-use record is the owner role's alone: the application can neither write a
    // use of its own (to spend or pre-spend a link) nor read the list.
    expect(
      await failure(
        withGlobal((tx) =>
          tx.execute(sql`insert into iam.owner_link_uses (jti) values (${randomUUID()})`),
        ),
      ),
    ).toContain('permission denied');
    expect(
      await failure(withGlobal((tx) => tx.execute(sql`select count(*) from iam.owner_link_uses`))),
    ).toContain('permission denied');
    // And only an owner's session may say it came by link, from the start.
    expect(
      await failure(
        withGlobal((tx) =>
          tx.execute(
            sql`update iam.sessions set owner_link = true where user_id = ${admin.userId}`,
          ),
        ),
      ),
    ).toContain('OWNER_LINK');
    expect(
      await failure(
        withGlobal((tx) =>
          tx.execute(sql`update iam.sessions set owner_link = false where user_id = ${ownerId}`),
        ),
      ),
    ).toContain('OWNER_LINK_FIXED');
    // Nor a password, by any road: an owner never holds an account row.
    expect(
      await failure(
        withGlobal((tx) =>
          tx.execute(sql`
            insert into iam.accounts (id, account_id, provider_id, user_id, password)
            values ('acc_forged', ${ownerId}, 'credential', ${ownerId}, 'not-a-hash')
          `),
        ),
      ),
    ).toContain('OWNER_HAS_NO_PASSWORD');
  });

  it('reads "Owner" on an order to staff, and the name to another owner', async () => {
    const { skus } = await seedProductWithSkus(ORG_A, 'ownerlink', 1);
    const sku = skus[0];
    if (sku === undefined) throw new Error('no sku');
    const customerId = await seedCustomer(ORG_A, {
      phoneE164: '+8801711000123',
      name: 'Owner Link Buyer',
    });
    const { id } = await seedOrder(ORG_A, {
      status: 'pending',
      customerId,
      createdBy: ownerId,
      lines: [
        {
          skuId: sku.id,
          skuCode: sku.code,
          productName: 'Owner kurta',
          qty: 1,
          unitPricePoisha: 100_000n,
        },
      ],
    });
    await withSystem(
      (tx) =>
        tx.execute(sql`
          insert into audit.audit_log
            (org_id, actor_user_id, operation, action, entity_type, entity_id)
          values (${ORG_A}, ${ownerId}, 'update', 'order.edited', 'order', ${id})
        `),
      { orgId: ORG_A },
    );

    const asStaff = await admin.client.request('GET', `/v1/orders/${id}`);
    expect(asStaff.statusCode, asStaff.body).toBe(200);
    const seen = JSON.parse(asStaff.body) as { owners: { userId: string; name: string | null }[] };
    expect(seen.owners).toEqual([{ userId: ownerId, name: null }]);
    expect(asStaff.body).not.toContain('Owner One');

    const second = harness.client();
    expect(
      (await present(second, mint(claims({ sub: 'owner.two@example.invalid', name: 'Owner Two' }))))
        .statusCode,
    ).toBe(200);
    const asOwner = JSON.parse((await second.request('GET', `/v1/orders/${id}`)).body) as {
      owners: { userId: string; name: string | null }[];
    };
    const [named] = await withGlobal((tx) =>
      tx.execute<{ name: string }>(sql`select name from iam.users where id = ${ownerId}`),
    );
    expect(asOwner.owners).toEqual([{ userId: ownerId, name: named?.name }]);
    expect(named?.name).toMatch(/^Owner One/);
  });
});
