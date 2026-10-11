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
import type { Actor } from './audit/audit.js';
import { createMotherAuth, type MotherAuth } from './auth/auth.js';
import { BrandPools } from './brands/pools.js';
import { createBrand } from './brands/registry.js';
import {
  bootstrapOwner,
  breakGlassTwoFactorReset,
  CliRefused,
  describeConnectionTest,
  listBrandsFromServer,
  registerBrandFromServer,
  rotateBrandKeyFromServer,
  setBrandConnectionFromServer,
  testBrandFromServer,
} from './cli.js';
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
  secretOf,
  signInWithCode,
} from './testing/http-client.js';

/**
 * The mother's HTTP surface end to end (D-487 to D-491, D-700 to D-705): the first owner,
 * the second-factor wall, sessions, CSRF, the credential limiter, the brand registry (whose
 * changes are the server's alone), the owner sign-in link (check 2's mother half), My
 * account, the people rules and the activity log.
 */

const ORG_A = SEED_ORG_IDS['elysium-lifestyle-bd'] ?? '';
const silent = pino({ level: 'silent' });
const OPERATOR: Actor = {
  userId: 'system:operator',
  email: 'system:operator',
  name: 'Operator',
  ipAddress: null,
  requestId: null,
};
const secrets = secretsKeyFrom(randomBytes(32).toString('base64'), 'k1');

let brand: TestDatabase;
let mother: MotherTestDatabase;
let app: NestFastifyApplication;
let auth: MotherAuth;
let pools: BrandPools;
const queued: PullBrandJob[] = [];
/** Moves the sign-in limiter's clock: a test that signs in again starts a fresh window. */
let limiterSkewMs = 0;

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
    limiter: new MemoryRateLimiter(() => Date.now() + limiterSkewMs),
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

  it('never trusts a device: the code is asked again in the same browser (D-487)', async () => {
    // This owner has signed in five times already; the limiter's next window, not a refusal.
    limiterSkewMs += 61_000;
    const browser = new Browser(app);
    const first = await browser.post('/api/auth/sign-in/email', {
      email: owners.a.email,
      password: PASSWORD,
    });
    expect((first.body as { twoFactorRedirect?: boolean }).twoFactorRedirect).toBe(true);
    const { code } = await auth.api.generateTOTP({ body: { secret: owners.a.secret } });
    const verified = await browser.post('/api/auth/two-factor/verify-totp', {
      code,
      trustDevice: true,
    });
    expect(verified.status).toBe(200);
    expect(browser.cookieNames().some((name) => /trust/i.test(name))).toBe(false);
    expect((await browser.post('/api/auth/sign-out', {})).status).toBe(200);

    const again = await browser.post('/api/auth/sign-in/email', {
      email: owners.a.email,
      password: PASSWORD,
    });
    expect(again.status).toBe(200);
    expect((again.body as { twoFactorRedirect?: boolean }).twoFactorRedirect).toBe(true);
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

describe('the brand registry and the owner sign-in link (D-481, D-490, D-700)', () => {
  let brandId = '';
  let publicKey = '';

  it('refuses a connection that is not the read-only role, without echoing it', async () => {
    const refused = registerBrandFromServer(secrets, {
      slug: 'elysium-lifestyle-bd',
      displayName: 'Elysium Lifestyle BD',
      adminUrl: 'https://admin.elysium.example',
      readConnection: brand.ownerUrl,
    });
    await expect(refused).rejects.toBeInstanceOf(CliRefused);
    await refused.catch((error: unknown) => {
      expect(String(error)).toMatch(/readConnection/);
      expect(String(error)).not.toContain(new URL(brand.ownerUrl).password);
    });
  });

  it('adds a brand from the server only, with its key, and never echoes the connection', async () => {
    const result = await registerBrandFromServer(secrets, {
      slug: 'elysium-lifestyle-bd',
      displayName: 'Elysium Lifestyle BD',
      adminUrl: 'https://admin.elysium.example',
      readConnection: brand.analyticsUrl,
    });
    brandId = result.id;
    publicKey = result.envLine.replace('OWNER_LINK_PUBLIC_KEY=', '');
    expect(JSON.stringify(result)).not.toContain('erp_analytics:');
    const listed = await owners.a.browser.get('/v1/brands');
    const body = (listed.body as { brands: { id: string; hasOwnerLinkKey: boolean }[] }).brands;
    expect(body.find((row) => row.id === brandId)?.hasOwnerLinkKey).toBe(true);
    expect(JSON.stringify(listed.body)).not.toContain('erp_analytics:');
    await expect(
      registerBrandFromServer(secrets, {
        slug: 'elysium-lifestyle-bd',
        displayName: 'Again',
        adminUrl: 'https://admin.elysium.example',
        readConnection: brand.analyticsUrl,
      }),
    ).rejects.toThrow(/already registered/);
  });

  it('has no route to add a brand, change its connection or replace its key (D-700)', async () => {
    const { browser } = owners.a;
    const before = await browser.get(`/v1/brands/${brandId}`);
    const fingerprint = (before.body as { connectionFingerprint: string }).connectionFingerprint;

    const add = await browser.post('/v1/brands', {
      slug: 'oura-lifestyle',
      displayName: 'Oura',
      adminUrl: 'https://admin.oura.example',
      readConnection: brand.analyticsUrl,
    });
    expect(add.status).toBe(404);
    expect((await browser.post(`/v1/brands/${brandId}/owner-link-key`)).status).toBe(404);
    const repoint = await browser.patch(`/v1/brands/${brandId}`, {
      readConnection: 'postgres://erp_analytics:x@127.0.0.1:9/elsewhere',
    });
    expect(repoint.status).toBe(400);
    const sneaked = await browser.patch(`/v1/brands/${brandId}`, {
      displayName: 'Elysium Lifestyle BD',
      readConnection: 'postgres://erp_analytics:x@127.0.0.1:9/elsewhere',
    });
    expect(sneaked.status).toBe(400);

    const after = await browser.get(`/v1/brands/${brandId}`);
    expect((after.body as { connectionFingerprint: string }).connectionFingerprint).toBe(
      fingerprint,
    );
    const [row] = await motherSql()<{ count: number }[]>`
      select count(*)::int as count from mother.brands where slug = 'oura-lifestyle'
    `;
    expect(row?.count).toBe(0);
  });

  it('tests the connection', async () => {
    const answer = await owners.a.browser.post(`/v1/brands/${brandId}/test`);
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ ok: true, code: 'ok', brandFound: true });
  });

  it('needs a key before it can make a link', async () => {
    // A brand registered before D-690 made its key at once.
    const keyless = await createBrand(
      secrets,
      {
        slug: 'wear-x-clothing',
        displayName: 'Wear X',
        adminUrl: 'https://admin.wearx.example',
        readConnection: brand.analyticsUrl,
      },
      OPERATOR,
    );
    const answer = await owners.a.browser.post(`/v1/brands/${keyless.id}/owner-link`);
    expect(answer.status).toBe(409);
    expect((answer.body as { code: string }).code).toBe('OWNER_LINK_KEY_MISSING');
  });

  it('mints links the brand verifies with the public key it was shown once', async () => {
    const listed = await owners.a.browser.get('/v1/brands');
    expect(JSON.stringify(listed.body)).not.toContain(publicKey);

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

    // Replacing the key on the server: links signed before no longer verify with the new one.
    const rotated = await rotateBrandKeyFromServer(secrets, 'elysium-lifestyle-bd');
    expect(rotated.replaced).toBe(true);
    expect(rotated.envLine).toMatch(/^OWNER_LINK_PUBLIC_KEY=[A-Za-z0-9+/=]+$/);
    const newKey = createPublicKey({
      key: Buffer.from(rotated.envLine.replace('OWNER_LINK_PUBLIC_KEY=', ''), 'base64'),
      format: 'der',
      type: 'spki',
    });
    expect(verify(null, Buffer.from(parsed.signedText, 'utf8'), newKey, parsed.signature)).toBe(
      false,
    );
    const after = (await owners.a.browser.get(`/v1/brands/${brandId}`)).body as {
      ownerLinkKeyFingerprint: string;
    };
    expect(after.ownerLinkKeyFingerprint).toBe(rotated.fingerprint);

    const [issued] = await motherSql()<{ count: number }[]>`
      select count(*)::int as count from mother.audit_log
      where action = 'brand.owner_link.issued' and detail->>'jti' in (${parsed.claims.jti}, ${parsed2.claims.jti})
    `;
    expect(issued?.count).toBe(2);
    const [byOperator] = await motherSql()<{ actor_user_id: string | null }[]>`
      select actor_user_id from mother.audit_log
      where action = 'brand.owner_link_key.rotated' and entity_id = ${brandId}
      order by id desc limit 1
    `;
    expect(byOperator?.actor_user_id).toBe('system:operator');
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

  it('lists, re-points and tests a brand from the server, never printing the connection', async () => {
    const secretOfUrl = (url: string) => new URL(url).password;
    const lines = await listBrandsFromServer();
    expect(lines.some((line) => line.startsWith('elysium-lifestyle-bd '))).toBe(true);
    const printed = lines.join('\n');
    expect(printed).not.toMatch(/postgres:\/\//);
    expect(printed).not.toContain(secretOfUrl(brand.analyticsUrl));

    const wrongRole = setBrandConnectionFromServer(secrets, {
      slug: 'elysium-lifestyle-bd',
      readConnection: brand.ownerUrl,
    });
    await expect(wrongRole).rejects.toBeInstanceOf(CliRefused);
    await wrongRole.catch((error: unknown) => {
      expect(String(error)).not.toContain(secretOfUrl(brand.ownerUrl));
    });
    await expect(
      setBrandConnectionFromServer(secrets, {
        slug: 'no-such-brand',
        readConnection: brand.analyticsUrl,
      }),
    ).rejects.toThrow(/No brand with the slug/);

    const before = (await owners.a.browser.get(`/v1/brands/${brandId}`)).body as {
      connectionFingerprint: string;
    };
    const moved = await setBrandConnectionFromServer(secrets, {
      slug: 'elysium-lifestyle-bd',
      readConnection: `${brand.analyticsUrl}?sslmode=disable`,
    });
    expect(moved.fingerprint).not.toBe(before.connectionFingerprint);
    expect(JSON.stringify(moved)).not.toMatch(/postgres:\/\//);
    const [audited] = await motherSql()<{ actor_user_id: string; detail: unknown }[]>`
      select actor_user_id, detail from mother.audit_log
      where action = 'brand.connection_changed' and entity_id = ${brandId}
      order by id desc limit 1
    `;
    expect(audited?.actor_user_id).toBe('system:operator');
    expect(audited?.detail).toMatchObject({
      connectionFingerprint: { from: before.connectionFingerprint, to: moved.fingerprint },
    });
    expect(JSON.stringify(audited)).not.toMatch(/postgres:\/\//);

    const tested = await testBrandFromServer(pools, 'elysium-lifestyle-bd');
    expect(tested).toMatchObject({ ok: true, code: 'ok' });
    expect(describeConnectionTest(tested)).toMatch(
      /^Connection test: ok \(version \d+ of \d+\)\.$/,
    );
    const listedAfter = (await owners.a.browser.get(`/v1/brands/${brandId}`)).body as {
      connectionFingerprint: string;
    };
    expect(listedAfter.connectionFingerprint).toBe(moved.fingerprint);
  });
});

describe('my account: name, password, two-step sign-in and devices (M40, D-701 to D-705)', () => {
  const CHROME =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
  const IPHONE =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
  const email = 'owner.d@example.com';
  let password = PASSWORD;
  let secret = '';
  let backupCodes: string[] = [];
  let desk: Browser;

  const signIn = async (userAgent?: string) => {
    limiterSkewMs += 61_000;
    const browser = new Browser(app, userAgent);
    const answer = await signInWithCode(browser, auth, { email, secret, password });
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    return browser;
  };
  const audited = async (action: string) => {
    const [row] = await motherSql()<{ count: number }[]>`
      select count(*)::int as count from mother.audit_log a
      join auth.users u on u.id = a.actor_user_id
      where u.email = ${email} and a.action = ${action}
    `;
    return row?.count ?? 0;
  };

  beforeAll(async () => {
    const invite = await owners.a.browser.post('/v1/people', { email, name: 'Owner D' });
    desk = new Browser(app, CHROME);
    const enrolled = await acceptAndEnrol(desk, auth, {
      link: (invite.body as { link: string }).link,
      email,
    });
    secret = enrolled.secret;
    backupCodes = enrolled.backupCodes;
  });

  it('shows who I am, and that two-step sign-in is on with ten recovery codes', async () => {
    const answer = await desk.get('/v1/account');
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({
      name: 'Owner D',
      email,
      twoFactor: { enabled: true, backupCodesLeft: 10, backupCodesIssued: 10 },
    });
    expect((answer.body as { passwordChangedAt: string | null }).passwordChangedAt).not.toBeNull();
    expect(JSON.stringify(answer.body)).not.toMatch(/secret|backupCodes"/i);
  });

  it('changes my name, audited, and the console sees it at once', async () => {
    const answer = await desk.patch('/v1/account', { name: '  Owner Dee ' });
    expect(answer.status).toBe(200);
    expect((answer.body as { name: string }).name).toBe('Owner Dee');
    expect((await desk.get('/v1/me')).body).toMatchObject({ name: 'Owner Dee' });
    expect((await desk.patch('/v1/account', { name: '' })).status).toBe(400);
    expect(await audited('account.name_changed')).toBe(1);
  });

  it('closes Better Auth’s own account routes: no change goes round the audit (D-705)', async () => {
    for (const path of [
      '/api/auth/two-factor/disable',
      '/api/auth/two-factor/get-totp-uri',
      '/api/auth/two-factor/generate-backup-codes',
      '/api/auth/change-password',
      '/api/auth/list-sessions',
      '/api/auth/revoke-session',
      '/api/auth/revoke-sessions',
      '/api/auth/revoke-other-sessions',
      '/api/auth/update-session',
      '/api/auth/update-user',
    ]) {
      const answer = await desk.post(path, { password, currentPassword: password });
      expect(answer.status, path).toBe(404);
    }
    const [row] = await motherSql()<{ two_factor_enabled: boolean }[]>`
      select two_factor_enabled from auth.users where email = ${email}
    `;
    expect(row?.two_factor_enabled).toBe(true);
  });

  it('lists my devices, masked, with this one marked, and signs one or all others out', async () => {
    const phone = await signIn(IPHONE);
    const laptop = await signIn();
    const answer = await desk.get('/v1/account/sessions');
    expect(answer.status).toBe(200);
    const { sessions } = answer.body as {
      sessions: {
        id: string;
        current: boolean;
        browser: string | null;
        os: string | null;
        address: string | null;
        lastActiveAt: string;
      }[];
    };
    expect(sessions.length).toBe(3);
    expect(sessions[0]).toMatchObject({ current: true, browser: 'Chrome', os: 'Windows' });
    expect(sessions.filter((session) => session.current).length).toBe(1);
    expect(sessions.some((row) => row.browser === 'Safari' && row.os === 'iPhone')).toBe(true);
    for (const session of sessions) expect(session.address).toMatch(/^10\.9\.\*\.\*$/);
    // No token, and no whole address, ever leaves.
    const [tokens] = await motherSql()<{ list: string[] }[]>`
      select array_agg(token) as list from auth.sessions s join auth.users u on u.id = s.user_id
      where u.email = ${email}
    `;
    for (const token of tokens?.list ?? [])
      expect(JSON.stringify(answer.body)).not.toContain(token);
    expect(JSON.stringify(answer.body)).not.toContain(desk.ip);

    const current = sessions.find((session) => session.current)?.id ?? '';
    const own = await desk.post(`/v1/account/sessions/${current}/sign-out`);
    expect((own.body as { code: string }).code).toBe('CONFLICT');
    const iphone = sessions.find((session) => session.os === 'iPhone')?.id ?? '';
    expect((await desk.post(`/v1/account/sessions/${iphone}/sign-out`)).status).toBe(200);
    expect((await phone.get('/v1/me')).status).toBe(401);
    expect((await laptop.get('/v1/me')).status).toBe(200);
    // Someone else's session is not mine to end.
    const [others] = await motherSql()<{ id: string }[]>`
      select s.id from auth.sessions s join auth.users u on u.id = s.user_id
      where u.email = ${owners.a.email} limit 1
    `;
    const foreign = await desk.post(`/v1/account/sessions/${others?.id ?? 'none'}/sign-out`);
    expect(foreign.status).toBe(404);

    const rest = await desk.post('/v1/account/sessions/sign-out-others');
    expect(rest.body).toEqual({ signedOut: 1 });
    expect((await laptop.get('/v1/me')).status).toBe(401);
    expect((await desk.get('/v1/me')).status).toBe(200);
    expect(await audited('account.session.signed_out')).toBe(1);
    expect(await audited('account.sessions.signed_out_others')).toBe(1);
  });

  it('keeps each session’s last activity, at most a minute stale', async () => {
    await motherSql()`
      update auth.sessions set last_active_at = now() - interval '10 minutes'
      where user_id = (select id from auth.users where email = ${email})
    `;
    const answer = await desk.get('/v1/account/sessions');
    const [session] = (answer.body as { sessions: { lastActiveAt: string }[] }).sessions;
    expect(Date.now() - new Date(session?.lastActiveAt ?? 0).getTime()).toBeLessThan(60_000);
  });

  it('changes my password with the current one, signing my other devices out', async () => {
    const other = await signIn();
    const wrong = await desk.post('/v1/account/password', {
      currentPassword: 'not-my-password-at-all',
      newPassword: 'a-brand-new-password-1',
    });
    expect(wrong.status).toBe(400);
    expect((wrong.body as { code: string }).code).toBe('INVALID_PASSWORD');
    expect(await audited('account.check_failed')).toBe(1);
    const short = await desk.post('/v1/account/password', {
      currentPassword: password,
      newPassword: 'short',
    });
    expect((short.body as { code: string }).code).toBe('VALIDATION_FAILED');

    const changed = await desk.post('/v1/account/password', {
      currentPassword: password,
      newPassword: 'a-brand-new-password-1',
      signOutOtherDevices: true,
    });
    expect(changed.status).toBe(200);
    expect(changed.body).toEqual({ signedOutOtherDevices: 1 });
    expect((await other.get('/v1/me')).status).toBe(401);
    expect((await desk.get('/v1/me')).status).toBe(200);
    expect(await audited('account.password_changed')).toBe(1);

    limiterSkewMs += 61_000;
    const old = await new Browser(app).post('/api/auth/sign-in/email', { email, password });
    expect(old.status).toBe(401);
    password = 'a-brand-new-password-1';
    await signIn();

    // Keeping the other devices signed in is a choice.
    const kept = await signIn();
    const again = await desk.post('/v1/account/password', {
      currentPassword: password,
      newPassword: 'another-new-password-2',
      signOutOtherDevices: false,
    });
    expect(again.body).toEqual({ signedOutOtherDevices: 0 });
    expect((await kept.get('/v1/me')).status).toBe(200);
    password = 'another-new-password-2';
  });

  it('moves two-step sign-in to a new phone only with the password and a code held now', async () => {
    const totpNow = async (key: string) =>
      (await auth.api.generateTOTP({ body: { secret: key } })).code;
    const wrongPassword = await desk.post('/v1/account/two-factor/new-app', {
      password: 'not-my-password-at-all',
      code: await totpNow(secret),
    });
    expect((wrongPassword.body as { code: string }).code).toBe('INVALID_PASSWORD');
    const wrongCode = await desk.post('/v1/account/two-factor/new-app', {
      password,
      code: '000000',
    });
    expect((wrongCode.body as { code: string }).code).toBe('INVALID_CODE');

    const started = await desk.post('/v1/account/two-factor/new-app', {
      password,
      code: await totpNow(secret),
    });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const { totpURI } = started.body as { totpURI: string; expiresAt: string };
    expect(totpURI).toMatch(/^otpauth:\/\/totp\//);
    const fresh = secretOf(totpURI);
    expect(fresh).not.toBe(secret);

    // Until the new phone answers, the old one still signs in.
    await signIn();
    // The new key waits for this session only.
    const elsewhere = await signIn();
    const stranger = await elsewhere.post('/v1/account/two-factor/new-app/confirm', {
      code: await totpNow(fresh),
    });
    expect((stranger.body as { code: string }).code).toBe('TWO_FACTOR_SETUP_EXPIRED');
    const badConfirm = await desk.post('/v1/account/two-factor/new-app/confirm', {
      code: '000000',
    });
    expect((badConfirm.body as { code: string }).code).toBe('INVALID_CODE');
    const confirmed = await desk.post('/v1/account/two-factor/new-app/confirm', {
      code: await totpNow(fresh),
    });
    expect(confirmed.status).toBe(200);

    // The old phone no longer signs in; the new one does.
    limiterSkewMs += 61_000;
    const oldPhone = await signInWithCode(new Browser(app), auth, { email, secret, password });
    expect(oldPhone.status).not.toBe(200);
    secret = fresh;
    await signIn();
    expect(await audited('account.two_factor.new_app_started')).toBe(1);
    expect(await audited('account.two_factor.new_app_confirmed')).toBe(1);
    // Spent: the same key cannot be confirmed twice.
    const twice = await desk.post('/v1/account/two-factor/new-app/confirm', {
      code: await totpNow(fresh),
    });
    expect((twice.body as { code: string }).code).toBe('TWO_FACTOR_SETUP_EXPIRED');
  });

  it('takes a recovery code as the code held now, and uses it up', async () => {
    const code = backupCodes[0] ?? '';
    const started = await desk.post('/v1/account/two-factor/new-app', { password, code });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    expect(
      ((await desk.get('/v1/account')).body as { twoFactor: { backupCodesLeft: number } }).twoFactor
        .backupCodesLeft,
    ).toBe(9);
    const reused = await desk.post('/v1/account/two-factor/new-app', { password, code });
    expect((reused.body as { code: string }).code).toBe('INVALID_CODE');
  });

  it('makes new recovery codes with the password, shown once; the old ones stop working', async () => {
    const renewed = await desk.post('/v1/account/two-factor/backup-codes', { password });
    expect(renewed.status).toBe(200);
    const codes = (renewed.body as { backupCodes: string[] }).backupCodes;
    expect(codes.length).toBe(10);
    for (const code of codes) expect(code).toMatch(/^[A-Za-z0-9]{5}-[A-Za-z0-9]{5}$/);
    expect(new Set(codes).size).toBe(10);
    expect(
      ((await desk.get('/v1/account')).body as { twoFactor: { backupCodesLeft: number } }).twoFactor
        .backupCodesLeft,
    ).toBe(10);
    expect(JSON.stringify((await desk.get('/v1/account')).body)).not.toContain(codes[0] ?? '-');

    const signInWithBackup = async (backup: string) => {
      limiterSkewMs += 61_000;
      const browser = new Browser(app);
      const first = await browser.post('/api/auth/sign-in/email', { email, password });
      expect((first.body as { twoFactorRedirect?: boolean }).twoFactorRedirect).toBe(true);
      return browser.post('/api/auth/two-factor/verify-backup-code', { code: backup });
    };
    expect((await signInWithBackup(backupCodes[1] ?? '')).status).not.toBe(200);
    expect((await signInWithBackup(codes[0] ?? '')).status).toBe(200);
    expect(await audited('account.backup_codes.renewed')).toBe(1);
  });

  it('stops every check after five wrong answers in fifteen minutes (D-705)', async () => {
    // Its own owner, so the wrong answers above do not count here.
    const invite = await owners.a.browser.post('/v1/people', {
      email: 'owner.e@example.com',
      name: 'Owner E',
    });
    const browser = new Browser(app);
    await acceptAndEnrol(browser, auth, {
      link: (invite.body as { link: string }).link,
      email: 'owner.e@example.com',
    });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const answer = await browser.post('/v1/account/two-factor/backup-codes', {
        password: `wrong-password-${String(attempt)}`,
      });
      expect((answer.body as { code: string }).code).toBe('INVALID_PASSWORD');
    }
    const locked = await browser.post('/v1/account/two-factor/backup-codes', {
      password: PASSWORD,
    });
    expect(locked.status).toBe(429);
    expect((locked.body as { code: string }).code).toBe('RATE_LIMITED');
    const lockedPassword = await browser.post('/v1/account/password', {
      currentPassword: PASSWORD,
      newPassword: 'yet-another-password-3',
    });
    expect(lockedPassword.status).toBe(429);
    const [failures] = await motherSql()<{ count: number }[]>`
      select count(*)::int as count from mother.audit_log a
      join auth.users u on u.id = a.actor_user_id
      where u.email = 'owner.e@example.com' and a.action = 'account.check_failed'
    `;
    expect(failures?.count).toBe(5);
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

  it('registers a brand from the server, with its owner-link key, audited (D-690)', async () => {
    const result = await registerBrandFromServer(secrets, {
      slug: 'beownz',
      displayName: 'Server Added',
      adminUrl: 'https://erp.example.com',
      readConnection: brand.analyticsUrl,
    });
    expect(result.envLine).toMatch(/^OWNER_LINK_PUBLIC_KEY=[A-Za-z0-9+/=]+$/);
    const [row] = await motherSql()<{ count: number }[]>`
      select count(*)::int as count from mother.audit_log
      where entity_id = ${result.id} and action in ('brand.added', 'brand.owner_link_key.created')
    `;
    expect(row?.count).toBe(2);
    await expect(
      registerBrandFromServer(secrets, {
        slug: 'oura-lifestyle',
        displayName: 'Wrong Role',
        adminUrl: 'https://erp.example.com',
        readConnection: brand.ownerUrl,
      }),
    ).rejects.toThrow(/readConnection/);
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
      'brand.connection_changed',
      'brand.owner_link_key.created',
      'brand.owner_link_key.rotated',
      'brand.owner_link.issued',
      'brand.pull_requested',
      'person.invited',
      'person.two_factor_reset.requested',
      'person.two_factor_reset.approved',
      'person.removed',
      'account.name_changed',
      'account.password_changed',
      'account.check_failed',
      'account.two_factor.new_app_confirmed',
      'account.backup_codes.renewed',
      'account.sessions.signed_out_others',
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
