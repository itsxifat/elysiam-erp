import { createPublicKey, randomBytes, verify } from 'node:crypto';

import { SEED_ORG_IDS } from '@elysium/db';
import {
  seedDemoSetUp,
  startTestDatabase,
  stopSharedContainer,
  type TestDatabase,
} from '@elysium/db/testing';
import { DEFAULT_LEADERBOARD_WEIGHTS } from '@elysium/domain/analytics';
import { checkOwnerLinkClaims, parseOwnerLink } from '@elysium/domain/iam';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildMotherApp } from './app.js';
import { createMotherAuth, type MotherAuth } from './auth/auth.js';
import { BrandPools } from './brands/pools.js';
import { bootstrapOwner, breakGlassTwoFactorReset, CliRefused } from './cli.js';
import { secretsKeyFrom } from './crypto/secrets.js';
import { motherSql } from './db/client.js';
import type { PullBrandJob } from './jobs/jobs.js';
import { MemoryRateLimiter } from './http/rate-limit.js';
import { startMotherDatabase, type MotherTestDatabase } from './testing/harness.js';
import {
  acceptAndEnrol,
  Browser,
  PASSWORD,
  PUBLIC_URL,
  signInWithCode,
} from './testing/http-client.js';

/**
 * The mother's HTTP surface end to end (D-487 to D-491): the first owner, the second-factor
 * wall, sessions, CSRF, the credential limiter, the brand registry, the owner sign-in link
 * (check 2's mother half), the people rules and the activity log.
 */

const ORG_A = SEED_ORG_IDS['elysium-lifestyle-bd'] ?? '';
const silent = pino({ level: 'silent' });
const secrets = secretsKeyFrom(randomBytes(32).toString('base64'), 'k1');

let brand: TestDatabase;
let mother: MotherTestDatabase;
let app: NestFastifyApplication;
let auth: MotherAuth;
let pools: BrandPools;
const queued: PullBrandJob[] = [];

const owners: Record<'a' | 'b' | 'c', { email: string; secret: string; browser: Browser }> =
  {} as never;

beforeAll(async () => {
  brand = await startTestDatabase('mhttp_brand', { brands: ['elysium-lifestyle-bd'] });
  await seedDemoSetUp(ORG_A);
  mother = await startMotherDatabase(brand.adminUrl);
  pools = new BrandPools(() => secrets, { connectTimeoutSeconds: 5, statementTimeoutMs: 20_000 });
  auth = createMotherAuth({
    baseUrl: PUBLIC_URL,
    secret: 'test-secret-'.repeat(4),
    trustedOrigins: [PUBLIC_URL],
  });
  app = await buildMotherApp({
    runtime: {
      publicUrl: PUBLIC_URL,
      secrets: () => secrets,
      pools,
      enqueuePull: (job) => {
        queued.push(job);
        return Promise.resolve();
      },
      weights: DEFAULT_LEADERBOARD_WEIGHTS,
      clock: () => new Date(),
      logger: silent,
    },
    auth,
    trustedOrigins: [PUBLIC_URL],
    secure: true,
    trustedProxies: '127.0.0.1',
    limiter: new MemoryRateLimiter(),
  });
}, 300_000);

afterAll(async () => {
  await app?.close();
  await pools?.closeAll();
  await mother?.stop();
  await brand?.stop();
  await stopSharedContainer();
}, 120_000);

describe('the first owner and the second-factor wall (D-487)', () => {
  it('bootstraps one owner, once, with a link in the fragment', async () => {
    const first = await bootstrapOwner({
      email: 'Owner.A@Example.com',
      name: 'Owner A',
      publicUrl: PUBLIC_URL,
    });
    expect(first.link.startsWith(`${PUBLIC_URL}/accept-invite#token=`)).toBe(true);
    await expect(
      bootstrapOwner({ email: 'other@example.com', name: 'Other', publicUrl: PUBLIC_URL }),
    ).rejects.toBeInstanceOf(CliRefused);

    const browser = new Browser(app);
    // Signed in with a password but no factor: everything is walled but enrolment.
    const reset = await browser.post('/api/auth/reset-password', {
      newPassword: PASSWORD,
      token: decodeURIComponent(new URL(first.link).hash.replace('#token=', '')),
    });
    expect(reset.status).toBe(200);
    const signIn = await browser.post('/api/auth/sign-in/email', {
      email: 'owner.a@example.com',
      password: PASSWORD,
    });
    expect(signIn.status).toBe(200);
    expect(JSON.stringify(signIn.body)).not.toMatch(/"token"/);
    const walled = await browser.get('/v1/me');
    expect(walled.status).toBe(403);
    expect((walled.body as { code: string }).code).toBe('TWO_FACTOR_ENROLMENT_REQUIRED');
    const sideDoor = await browser.post('/api/auth/update-user', { name: 'x' });
    expect(sideDoor.status).not.toBe(200);
  });

  it('opens everything once the factor is enrolled, for eight hours', async () => {
    const browser = new Browser(app);
    const invite = await motherSql()<{ id: string }[]>`
      select id from auth.users where email = 'owner.a@example.com'
    `;
    expect(invite.length).toBe(1);
    // A fresh link, as the operator would mint if the first one were spent.
    const signIn = await browser.post('/api/auth/sign-in/email', {
      email: 'owner.a@example.com',
      password: PASSWORD,
    });
    expect(signIn.status).toBe(200);
    const enabled = await browser.post('/api/auth/two-factor/enable', { password: PASSWORD });
    expect(enabled.status).toBe(200);
    const { totpURI } = enabled.body as { totpURI: string };
    const { base32 } = await import('@better-auth/utils/base32');
    const secret = new TextDecoder().decode(
      base32.decode(new URL(totpURI).searchParams.get('secret') ?? ''),
    );
    const { code } = await auth.api.generateTOTP({ body: { secret } });
    expect((await browser.post('/api/auth/two-factor/verify-totp', { code })).status).toBe(200);
    const me = await browser.get('/v1/me');
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ email: 'owner.a@example.com', name: 'Owner A' });
    owners.a = { email: 'owner.a@example.com', secret, browser };

    const [session] = await motherSql()<{ seconds: number }[]>`
      select extract(epoch from s.expires_at - s.created_at)::int as seconds
      from auth.sessions s join auth.users u on u.id = s.user_id
      where u.email = 'owner.a@example.com' order by s.created_at desc limit 1
    `;
    expect(session?.seconds).toBeGreaterThan(8 * 3600 - 60);
    expect(session?.seconds).toBeLessThanOrEqual(8 * 3600);
  });

  it('asks for the code at every later sign-in', async () => {
    const browser = new Browser(app);
    const first = await browser.post('/api/auth/sign-in/email', {
      email: owners.a.email,
      password: PASSWORD,
    });
    expect((first.body as { twoFactorRedirect?: boolean }).twoFactorRedirect).toBe(true);
    expect((await browser.get('/v1/me')).status).toBe(401);
    const signed = await signInWithCode(new Browser(app), auth, owners.a);
    expect(signed.status).toBe(200);
  });

  it('refuses anyone signed out, and lets the health checks through', async () => {
    const stranger = new Browser(app);
    const answer = await stranger.get('/v1/overview?from=2026-10-01&to=2026-10-05');
    expect(answer.status).toBe(401);
    expect(answer.headers['content-type']).toMatch(/application\/problem\+json/);
    expect((await stranger.get('/v1/health/live')).status).toBe(200);
    expect((await stranger.get('/v1/health/ready')).status).toBe(200);
  });

  it('has no sign-up', async () => {
    const answer = await new Browser(app).post('/api/auth/sign-up/email', {
      email: 'walk-in@example.com',
      password: PASSWORD,
      name: 'Walk In',
    });
    expect(answer.status).not.toBe(200);
    const [row] = await motherSql()<{ count: number }[]>`
      select count(*)::int as count from auth.users where email = 'walk-in@example.com'
    `;
    expect(row?.count).toBe(0);
  });

  it('limits guessing per account, whatever the address', async () => {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 7; attempt += 1) {
      const answer = await new Browser(app).post('/api/auth/sign-in/email', {
        email: 'someone.guessed@example.com',
        password: 'wrong-password-123',
      });
      statuses.push(answer.status);
    }
    expect(statuses.slice(0, 5).every((status) => status === 401)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });

  it('refuses a write without the CSRF token or from another origin (D-491)', async () => {
    const { browser } = owners.a;
    const missing = await browser.post(
      '/v1/people',
      { email: 'x@example.com', name: 'X' },
      { csrf: false },
    );
    expect(missing.status).toBe(403);
    const foreign = await browser.post(
      '/v1/people',
      { email: 'x@example.com', name: 'X' },
      { origin: 'https://evil.example.com' },
    );
    expect(foreign.status).toBe(403);
  });
});

describe('the brand registry and the owner sign-in link (D-481, D-490)', () => {
  let brandId = '';

  it('refuses a connection that is not the read-only role', async () => {
    const answer = await owners.a.browser.post('/v1/brands', {
      slug: 'elysium-lifestyle-bd',
      displayName: 'Elysium Lifestyle BD',
      adminUrl: 'https://admin.elysium.example',
      readConnection: brand.ownerUrl,
    });
    expect(answer.status).toBe(400);
    expect((answer.body as { code: string }).code).toBe('VALIDATION_FAILED');
    expect(JSON.stringify(answer.body)).not.toContain('erp_owner:');
  });

  it('adds a brand, queues its first full pull, and never echoes the connection', async () => {
    const answer = await owners.a.browser.post('/v1/brands', {
      slug: 'elysium-lifestyle-bd',
      displayName: 'Elysium Lifestyle BD',
      adminUrl: 'https://admin.elysium.example',
      readConnection: brand.analyticsUrl,
    });
    expect(answer.status).toBe(201);
    const body = answer.body as {
      id: string;
      connectionFingerprint: string;
      hasOwnerLinkKey: boolean;
    };
    brandId = body.id;
    expect(body.hasOwnerLinkKey).toBe(false);
    expect(JSON.stringify(answer.body)).not.toContain('erp_analytics:');
    expect(queued).toContainEqual({ brandId, trigger: 'first', full: true });
    const again = await owners.a.browser.post('/v1/brands', {
      slug: 'elysium-lifestyle-bd',
      displayName: 'Again',
      adminUrl: 'https://admin.elysium.example',
      readConnection: brand.analyticsUrl,
    });
    expect((again.body as { code: string }).code).toBe('BRAND_SLUG_TAKEN');
  });

  it('tests the connection', async () => {
    const answer = await owners.a.browser.post(`/v1/brands/${brandId}/test`);
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ ok: true, code: 'ok', brandFound: true });
  });

  it('needs a key before it can make a link', async () => {
    const answer = await owners.a.browser.post(`/v1/brands/${brandId}/owner-link`);
    expect(answer.status).toBe(409);
    expect((answer.body as { code: string }).code).toBe('OWNER_LINK_KEY_MISSING');
  });

  it('mints links the brand verifies with the public key it was shown once', async () => {
    const key = await owners.a.browser.post(`/v1/brands/${brandId}/owner-link-key`);
    expect(key.status).toBe(201);
    const { publicKey, envLine, fingerprint } = key.body as {
      publicKey: string;
      envLine: string;
      fingerprint: string;
    };
    expect(envLine).toBe(`OWNER_LINK_PUBLIC_KEY=${publicKey}`);
    const listed = await owners.a.browser.get('/v1/brands');
    expect(JSON.stringify(listed.body)).not.toContain(publicKey);
    expect(JSON.stringify(listed.body)).toContain(fingerprint);

    const minted = await owners.a.browser.post(`/v1/brands/${brandId}/owner-link`);
    expect(minted.status).toBe(200);
    const { url } = minted.body as { url: string };
    const parsedUrl = new URL(url);
    expect(`${parsedUrl.origin}${parsedUrl.pathname}`).toBe(
      'https://admin.elysium.example/owner-link',
    );
    expect(parsedUrl.search).toBe('');
    const token = parsedUrl.hash.replace('#token=', '');

    const parsed = parseOwnerLink(token);
    if (!parsed.ok) throw new Error(parsed.reason);
    const key0 = createPublicKey({
      key: Buffer.from(publicKey, 'base64'),
      format: 'der',
      type: 'spki',
    });
    expect(verify(null, Buffer.from(parsed.signedText, 'utf8'), key0, parsed.signature)).toBe(true);
    const now = Math.floor(Date.now() / 1000);
    expect(
      checkOwnerLinkClaims(parsed.claims, { audience: 'elysium-lifestyle-bd', nowSeconds: now }),
    ).toBeUndefined();
    expect(parsed.claims.sub).toBe('owner.a@example.com');
    expect(parsed.claims.name).toBe('Owner A');
    expect(
      checkOwnerLinkClaims(parsed.claims, { audience: 'oura-lifestyle', nowSeconds: now }),
    ).toBe('wrong_audience');

    // Every link is its own: a brand that records each id refuses the second use (M31).
    const second = await owners.a.browser.post(`/v1/brands/${brandId}/owner-link`);
    const token2 = new URL((second.body as { url: string }).url).hash.replace('#token=', '');
    const parsed2 = parseOwnerLink(token2);
    if (!parsed2.ok) throw new Error(parsed2.reason);
    expect(parsed2.claims.jti).not.toBe(parsed.claims.jti);

    // Rotating the key: links signed before no longer verify with the new public key.
    const rotated = await owners.a.browser.post(`/v1/brands/${brandId}/owner-link-key`);
    const newKey = createPublicKey({
      key: Buffer.from((rotated.body as { publicKey: string }).publicKey, 'base64'),
      format: 'der',
      type: 'spki',
    });
    expect(verify(null, Buffer.from(parsed.signedText, 'utf8'), newKey, parsed.signature)).toBe(
      false,
    );

    const [issued] = await motherSql()<{ count: number }[]>`
      select count(*)::int as count from mother.audit_log
      where action = 'brand.owner_link.issued' and detail->>'jti' in (${parsed.claims.jti}, ${parsed2.claims.jti})
    `;
    expect(issued?.count).toBe(2);
  });

  it('reads the brand’s live lists over HTTP', async () => {
    const answer = await owners.a.browser.get(`/v1/brands/${brandId}/live`);
    expect(answer.status).toBe(200);
    expect((answer.body as { ok: boolean }).ok).toBe(true);
  });

  it('queues a pull on request, and audits it', async () => {
    const answer = await owners.a.browser.post(`/v1/brands/${brandId}/pull`, { full: true });
    expect(answer.status).toBe(202);
    expect(queued).toContainEqual({ brandId, trigger: 'owner', full: true });
  });

  it('changes a brand and audits what changed', async () => {
    const answer = await owners.a.browser.patch(`/v1/brands/${brandId}`, {
      displayName: 'Elysium',
    });
    expect(answer.status).toBe(200);
    expect((answer.body as { displayName: string }).displayName).toBe('Elysium');
    const [row] = await motherSql()<{ detail: { changed: Record<string, unknown> } }[]>`
      select detail from mother.audit_log where action = 'brand.changed' order by id desc limit 1
    `;
    expect(row?.detail.changed).toEqual({
      displayName: { from: 'Elysium Lifestyle BD', to: 'Elysium' },
    });
  });
});

describe('owners invite owners; a lost factor needs a third owner (D-488, D-489)', () => {
  it('invites two more owners, who enrol', async () => {
    for (const [key, name] of [
      ['b', 'Owner B'],
      ['c', 'Owner C'],
    ] as const) {
      const email = `owner.${key}@example.com`;
      const invite = await owners.a.browser.post('/v1/people', { email, name });
      expect(invite.status).toBe(201);
      const browser = new Browser(app);
      const { secret } = await acceptAndEnrol(browser, auth, {
        link: (invite.body as { link: string }).link,
        email,
      });
      owners[key] = { email, secret, browser };
      expect((await browser.get('/v1/me')).status).toBe(200);
    }
    const taken = await owners.a.browser.post('/v1/people', {
      email: 'owner.b@example.com',
      name: 'Again',
    });
    expect((taken.body as { code: string }).code).toBe('EMAIL_TAKEN');
  });

  it('clears a factor only when a third owner approves', async () => {
    const people = (await owners.a.browser.get('/v1/people')).body as {
      people: { id: string; email: string }[];
    };
    const idOf = (email: string) =>
      people.people.find((person) => person.email === email)?.id ?? '';
    const b = idOf(owners.b.email);

    const self = await owners.b.browser.post(`/v1/people/${b}/two-factor-resets`, {
      reason: 'lost my phone',
    });
    expect((self.body as { code: string }).code).toBe('SELF_ACTION_REFUSED');

    const raised = await owners.a.browser.post(`/v1/people/${b}/two-factor-resets`, {
      reason: 'B lost the phone',
    });
    expect(raised.status).toBe(201);
    const resetId = (raised.body as { id: string }).id;

    for (const who of [owners.a, owners.b]) {
      const answer = await who.browser.post(`/v1/two-factor-resets/${resetId}/approve`);
      expect((answer.body as { code: string }).code).toBe('RESET_NOT_DECIDABLE');
    }
    expect((await owners.c.browser.post(`/v1/two-factor-resets/${resetId}/approve`)).status).toBe(
      200,
    );
    // B's sessions ended, and the next sign-in meets the wall again.
    expect((await owners.b.browser.get('/v1/me')).status).toBe(401);
    const again = new Browser(app);
    const signIn = await again.post('/api/auth/sign-in/email', {
      email: owners.b.email,
      password: PASSWORD,
    });
    expect((signIn.body as { twoFactorRedirect?: boolean }).twoFactorRedirect).not.toBe(true);
    expect((await again.get('/v1/me')).status).toBe(403);
    const decidedTwice = await owners.c.browser.post(`/v1/two-factor-resets/${resetId}/approve`);
    expect((decidedTwice.body as { code: string }).code).toBe('RESET_NOT_DECIDABLE');
  });

  it('removes an owner, ends their sessions, and refuses their next sign-in', async () => {
    const people = (await owners.a.browser.get('/v1/people')).body as {
      people: { id: string; email: string }[];
    };
    const c = people.people.find((person) => person.email === owners.c.email)?.id ?? '';
    const a = people.people.find((person) => person.email === owners.a.email)?.id ?? '';
    expect((await owners.a.browser.post(`/v1/people/${a}/remove`)).body).toMatchObject({
      code: 'SELF_ACTION_REFUSED',
    });
    expect((await owners.a.browser.post(`/v1/people/${c}/remove`)).status).toBe(200);
    expect((await owners.c.browser.get('/v1/me')).status).toBe(401);
    const back = await signInWithCode(new Browser(app), auth, owners.c);
    expect(back.status).not.toBe(200);
  });

  it('has a break-glass reset on the server, audited', async () => {
    await breakGlassTwoFactorReset(owners.a.email);
    const [row] = await motherSql()<{ count: number }[]>`
      select count(*)::int as count from mother.audit_log
      where action = 'person.two_factor_reset.break_glass'
    `;
    expect(row?.count).toBe(1);
    expect((await owners.a.browser.get('/v1/me')).status).toBe(401);
  });
});

describe('the activity log (D-487)', () => {
  it('has every sign-in, link, brand change and people action, newest first, in pages', async () => {
    const browser = new Browser(app);
    // Owner B re-enrols (their factor was cleared above) to read the log.
    const signIn = await browser.post('/api/auth/sign-in/email', {
      email: owners.b.email,
      password: PASSWORD,
    });
    expect(signIn.status).toBe(200);
    const enabled = await browser.post('/api/auth/two-factor/enable', { password: PASSWORD });
    expect(enabled.status, JSON.stringify(enabled.body)).toBe(200);
    const { base32 } = await import('@better-auth/utils/base32');
    const secret = new TextDecoder().decode(
      base32.decode(
        new URL((enabled.body as { totpURI: string }).totpURI).searchParams.get('secret') ?? '',
      ),
    );
    const { code } = await auth.api.generateTOTP({ body: { secret } });
    await browser.post('/api/auth/two-factor/verify-totp', { code });

    const first = await browser.get('/v1/activity?limit=5');
    expect(first.status).toBe(200);
    const page = first.body as { items: { id: number; action: string }[]; next: number | null };
    expect(page.items.length).toBe(5);
    expect(page.next).not.toBeNull();
    const all = await browser.get('/v1/activity?limit=200');
    const actions = new Set((all.body as typeof page).items.map((item) => item.action));
    for (const action of [
      'person.bootstrapped',
      'auth.sign_in.succeeded',
      'auth.sign_in.failed',
      'auth.password_set',
      'brand.added',
      'brand.changed',
      'brand.owner_link_key.created',
      'brand.owner_link_key.rotated',
      'brand.owner_link.issued',
      'brand.pull_requested',
      'person.invited',
      'person.two_factor_reset.requested',
      'person.two_factor_reset.approved',
      'person.removed',
    ]) {
      expect(actions, action).toContain(action);
    }
    // The log never holds a key or a connection string.
    expect(JSON.stringify(all.body)).not.toMatch(/postgres:\/\/|PRIVATE|erp_analytics:/);
  });

  it('cannot be changed, even by the owner role', async () => {
    const owner = (await import('postgres')).default(mother.ownerUrl, {
      max: 1,
      onnotice: () => undefined,
    });
    try {
      await expect(owner`update mother.audit_log set action = 'x'`).rejects.toThrow(/append-only/);
      await expect(owner`delete from mother.audit_log`).rejects.toThrow(/append-only/);
    } finally {
      await owner.end();
    }
    await expect(motherSql()`delete from mother.audit_log`).rejects.toThrow(/permission denied/);
  });
});
