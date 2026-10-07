import { createHmac, createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import AxeBuilder from '@axe-core/playwright';
import { checkOwnerLinkClaims, parseOwnerLink } from '@elysium/domain/iam';
import { expect, test, type Page } from '@playwright/test';

import { STATE_FILE, type StackState } from './global-setup.js';

/**
 * The owner console in a browser, against its real API, worker and two real brand
 * databases (M32): the invite, the password, two-step enrolment, every screen with an axe
 * scan in light and dark, and "Open <brand> ERP" — whose link the brand's public key
 * verifies, and which leaves with no Referer (D-490). Screenshots go to docs/review/M32/.
 */

const SHOTS = path.resolve(import.meta.dirname, '../../../docs/review/M32');
const PASSWORD = 'a-long-owner-password-2026';

function state(): StackState {
  return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as StackState;
}

/** RFC 6238, as an authenticator app computes it: HMAC-SHA1, 30 seconds, 6 digits. */
function totp(base32Secret: string, now = Date.now()): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of base32Secret.replace(/=+$/, '').toUpperCase()) {
    bits += alphabet.indexOf(char).toString(2).padStart(5, '0');
  }
  const bytes = Buffer.from((bits.match(/.{8}/g) ?? []).map((byte) => Number.parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 1000 / 30)));
  const digest = createHmac('sha1', bytes).update(counter).digest();
  const offset = (digest[digest.length - 1] ?? 0) & 0xf;
  const code = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return code.toString().padStart(6, '0');
}

async function axe(page: Page, label: string): Promise<void> {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  const serious = result.violations.filter(
    (violation) => violation.impact === 'serious' || violation.impact === 'critical',
  );
  expect(
    serious.map(
      (violation) =>
        `${violation.id}: ${violation.nodes
          .slice(0, 4)
          .map((node) => `${node.target.join(' ')} (${node.failureSummary ?? ''})`)
          .join('; ')}`,
    ),
    `${label}: serious or critical axe violations`,
  ).toEqual([]);
}

async function dark(page: Page, on: boolean): Promise<void> {
  await page.evaluate((value) => {
    document.documentElement.classList.toggle('dark', value);
  }, on);
  // axe reads colours as painted: wait until no transition or animation is still running,
  // or a cell caught mid-change measures against the old theme.
  await page.waitForFunction(() =>
    document.getAnimations().every((animation) => animation.playState !== 'running'),
  );
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
}

let secret = '';

test.describe.configure({ mode: 'serial' });

test('the first owner sets a password and enrols two-step sign-in', async ({ page }) => {
  const { inviteLink, email } = state();
  const link = new URL(inviteLink);
  await page.goto(`${link.pathname}${link.hash}`);
  await expect(page.getByRole('heading', { name: 'Set your password' })).toBeVisible();
  await page.getByLabel('New password').fill(PASSWORD);
  await page.getByLabel('Repeat it').fill(PASSWORD);
  await page.getByRole('button', { name: 'Set password' }).click();
  await expect(page.getByText('Your password is set.')).toBeVisible();
  await page.screenshot({ path: path.join(SHOTS, 'accept-invite.png') });
  await page.getByRole('button', { name: 'Go to sign in' }).click();

  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Set up two-step sign-in' })).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();
  const code = page.locator('code').first();
  await expect(code).toHaveText(/[A-Z2-7]{16,}/);
  secret = (await code.textContent())?.trim() ?? '';
  await page.screenshot({ path: path.join(SHOTS, 'enrol.png') });
  await page.getByLabel('I have saved my recovery codes').check();
  await page.getByLabel('Code', { exact: true }).fill(totp(secret));
  await page.getByRole('button', { name: 'Turn on two-step sign-in' }).click();
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
});

async function signIn(page: Page): Promise<void> {
  const { email } = state();
  await page.goto('/');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Two-step sign-in' })).toBeVisible();
  // A fresh code each time: the server refuses a code it has seen.
  await page.waitForTimeout(31_000 - (Date.now() % 30_000));
  await page.getByLabel('Code', { exact: true }).fill(totp(secret));
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
}

test('the overview adds both brands together, in light and dark', async ({ page }) => {
  await signIn(page);
  const table = page.getByRole('table', { name: 'Orders and revenue' });
  await expect(table.getByRole('link', { name: 'Elysiam Lifestyle BD' })).toBeVisible();
  await expect(table.getByRole('link', { name: 'Oura Lifestyle' })).toBeVisible();
  await expect(table.getByRole('rowheader', { name: 'All brands' })).toBeVisible();
  await expect(page.getByRole('img', { name: /Trend by brand/ })).toBeVisible();
  await page.screenshot({ path: path.join(SHOTS, 'overview-light.png'), fullPage: true });
  await axe(page, 'overview, light');
  await dark(page, true);
  await page.screenshot({ path: path.join(SHOTS, 'overview-dark.png'), fullPage: true });
  await axe(page, 'overview, dark');
  await dark(page, false);

  await page.getByRole('button', { name: 'Show as table' }).click();
  await expect(page.getByRole('table', { name: /Trend by brand/ })).toBeVisible();

  for (const [name, heading, file] of [
    ['Leaderboard', 'Leaderboard', 'leaderboard'],
    ['Accounts', 'Accounts across brands', 'accounts'],
    ['Brands', 'Brands', 'brands'],
    ['People', 'People', 'people'],
    ['Activity', 'Activity', 'activity'],
  ] as const) {
    await page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('link', { name, exact: true })
      .click();
    await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
    await page.waitForLoadState('networkidle');
    await page.screenshot({ path: path.join(SHOTS, `${file}.png`), fullPage: true });
    await axe(page, `${file}, light`);
    await dark(page, true);
    await axe(page, `${file}, dark`);
    await dark(page, false);
  }
});

/** A cookie jar for one origin, for talking to a brand's own API from the test. */
class Jar {
  private readonly cookies = new Map<string, string>();

  absorb(response: Response): void {
    for (const line of response.headers.getSetCookie()) {
      const pair = line.split(';')[0] ?? '';
      const index = pair.indexOf('=');
      if (index > 0) this.cookies.set(pair.slice(0, index), pair.slice(index + 1));
    }
  }

  get header(): string {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  get(name: string): string | undefined {
    return this.cookies.get(name);
  }
}

/**
 * M31's real verifier: POST the link's token to the brand's own `/v1/auth/owner-link`, as
 * its console's `/owner-link` page does (CSRF cookie first). Returns the session's jar.
 */
async function redeemAtBrand(apiUrl: string, token: string): Promise<{ status: number; jar: Jar }> {
  const jar = new Jar();
  jar.absorb(await fetch(`${apiUrl}/health/live`));
  const response = await fetch(`${apiUrl}/v1/auth/owner-link`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: jar.header,
      'x-csrf-token': jar.get('erp_csrf') ?? '',
    },
    body: JSON.stringify({ token }),
  });
  jar.absorb(response);
  return { status: response.status, jar };
}

/** A link minted by the mother API for this owner, as "Open <brand> ERP" mints it. */
async function mint(page: Page, brandId: string): Promise<string> {
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'owner_csrf');
  const answer = await page.request.post(`/v1/brands/${brandId}/owner-link`, {
    headers: { 'x-owner-csrf': csrf?.value ?? '' },
  });
  expect(answer.status()).toBe(200);
  const { url } = (await answer.json()) as { url: string };
  return new URL(url).hash.replace('#token=', '');
}

test('a brand page reads live lists, and Open ERP hands over a link the brand accepts once', async ({
  page,
}) => {
  const { brands } = state();
  const brand = brands[0];
  if (brand === undefined) throw new Error('no brand in the stack');
  await signIn(page);
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('link', { name: 'Elysiam Lifestyle BD' })
    .click();
  await expect(page.getByRole('heading', { name: 'Elysiam Lifestyle BD', level: 1 })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Latest orders' })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Wallets' })).toBeVisible();
  await page.screenshot({ path: path.join(SHOTS, 'brand-page.png'), fullPage: true });
  await axe(page, 'brand page, light');
  await dark(page, true);
  await axe(page, 'brand page, dark');
  await dark(page, false);

  let landed: { url: string; referer: string | undefined } | null = null;
  await page.route(`https://admin.${brand.slug}.example/**`, async (route) => {
    landed = { url: route.request().url(), referer: route.request().headers().referer };
    await route.fulfill({ status: 200, contentType: 'text/html', body: '<title>brand</title>' });
  });
  await page.getByRole('button', { name: 'Open Elysiam Lifestyle BD ERP' }).click();
  await expect.poll(() => landed).not.toBeNull();
  const arrived = landed as unknown as { url: string; referer: string | undefined };
  // The fragment never reaches a server; the browser keeps it on the page. No Referer.
  expect(arrived.url).toBe(`https://admin.${brand.slug}.example/owner-link`);
  expect(arrived.referer).toBeUndefined();
  const token = new URL(page.url()).hash.replace('#token=', '');

  // The format holds against the shared rules...
  const parsed = parseOwnerLink(token);
  if (!parsed.ok) throw new Error(parsed.reason);
  const key = createPublicKey({
    key: Buffer.from(brand.publicKey, 'base64'),
    format: 'der',
    type: 'spki',
  });
  expect(verify(null, Buffer.from(parsed.signedText, 'utf8'), key, parsed.signature)).toBe(true);
  expect(
    checkOwnerLinkClaims(parsed.claims, {
      audience: brand.slug,
      nowSeconds: Math.floor(Date.now() / 1000),
    }),
  ).toBeUndefined();
  expect(parsed.claims.sub).toBe('owner@example.com');

  // ...and the brand's own API signs the owner in with it, once (check 2).
  const first = await redeemAtBrand(brand.apiUrl, token);
  expect(first.status).toBe(200);
  const me = await fetch(`${brand.apiUrl}/v1/me`, { headers: { cookie: first.jar.header } });
  expect(me.status).toBe(200);
  const replay = await redeemAtBrand(brand.apiUrl, token);
  expect(replay.status).toBe(401);
  // A link for one brand opens no other.
  const other = brands[1];
  if (other !== undefined) {
    const wrong = await redeemAtBrand(other.apiUrl, await mint(page, brand.id));
    expect(wrong.status).toBe(401);
  }
});

test('check 1: the overview is the sum of each brand’s own dashboard', async ({ page }) => {
  const { brands } = state();
  await signIn(page);
  const today = new Date(Date.now() + 6 * 3_600_000).toISOString().slice(0, 10);
  const from = new Date(Date.now() + 6 * 3_600_000 - 29 * 86_400_000).toISOString().slice(0, 10);
  const overview = (await (
    await page.request.get(`/v1/overview?from=${from}&to=${today}`)
  ).json()) as {
    totals: Record<string, unknown>;
    brands: { brand: { id: string }; figures: Record<string, unknown> }[];
  };

  const FIELDS = [
    'ordersPlaced',
    'ordersConfirmed',
    'ordersDelivered',
    'ordersReturned',
    'ordersCancelled',
    'deliveredRevenuePoisha',
    'grossProfitPoisha',
    'spendPoisha',
  ] as const;
  const sums = new Map<string, bigint>(FIELDS.map((field) => [field, 0n]));
  for (const brand of brands) {
    // The brand's own dashboard, as its owner sees it there: signed in by the mother's link.
    const { status, jar } = await redeemAtBrand(brand.apiUrl, await mint(page, brand.id));
    expect(status).toBe(200);
    const answer = await fetch(`${brand.apiUrl}/v1/analytics/dashboard?from=${from}&to=${today}`, {
      headers: { cookie: jar.header },
    });
    expect(answer.status).toBe(200);
    const own = ((await answer.json()) as { totals: Record<string, unknown> }).totals;
    const row = overview.brands.find((entry) => entry.brand.id === brand.id);
    expect(row, brand.slug).toBeDefined();
    for (const field of FIELDS) {
      expect(String(row?.figures[field]), `${brand.slug} ${field}`).toBe(String(own[field]));
      sums.set(field, (sums.get(field) ?? 0n) + BigInt(String(own[field])));
    }
    expect(Number(own.ordersPlaced), `${brand.slug} has demo orders`).toBeGreaterThan(0);
  }
  for (const field of FIELDS) {
    expect(String(overview.totals[field]), `total ${field}`).toBe(String(sums.get(field)));
  }
});
