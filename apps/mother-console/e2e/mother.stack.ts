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
    serious.map((violation) => `${violation.id}: ${violation.nodes.length}`),
    `${label}: serious or critical axe violations`,
  ).toEqual([]);
}

async function dark(page: Page, on: boolean): Promise<void> {
  await page.evaluate((value) => {
    document.documentElement.classList.toggle('dark', value);
  }, on);
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
  await expect(table.getByRole('link', { name: 'Elysium Lifestyle BD' })).toBeVisible();
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

test('a brand page reads live lists, and Open ERP hands over a link the brand verifies', async ({
  page,
}) => {
  const { publicKey, brandSlugs } = state();
  await signIn(page);
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('link', { name: 'Elysium Lifestyle BD' })
    .click();
  await expect(page.getByRole('heading', { name: 'Elysium Lifestyle BD', level: 1 })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Latest orders' })).toBeVisible();
  await expect(page.getByRole('table', { name: 'COD with couriers' })).toContainText('Steadfast');
  await page.screenshot({ path: path.join(SHOTS, 'brand-page.png'), fullPage: true });
  await axe(page, 'brand page, light');
  await dark(page, true);
  await axe(page, 'brand page, dark');
  await dark(page, false);

  const slug = brandSlugs[0] ?? '';
  let landed: { url: string; referer: string | undefined } | null = null;
  await page.route(`https://admin.${slug}.example/**`, async (route) => {
    landed = { url: route.request().url(), referer: route.request().headers().referer };
    await route.fulfill({ status: 200, contentType: 'text/html', body: '<title>brand</title>' });
  });
  await page.getByRole('button', { name: 'Open Elysium Lifestyle BD ERP' }).click();
  await expect.poll(() => landed).not.toBeNull();
  const arrived = landed as unknown as { url: string; referer: string | undefined };
  // The fragment never reaches a server; the browser keeps it on the page.
  expect(arrived.url).toBe(`https://admin.${slug}.example/owner-link`);
  expect(arrived.referer).toBeUndefined();
  const token = new URL(page.url()).hash.replace('#token=', '');
  const parsed = parseOwnerLink(token);
  if (!parsed.ok) throw new Error(parsed.reason);
  const key = createPublicKey({
    key: Buffer.from(publicKey, 'base64'),
    format: 'der',
    type: 'spki',
  });
  expect(verify(null, Buffer.from(parsed.signedText, 'utf8'), key, parsed.signature)).toBe(true);
  expect(
    checkOwnerLinkClaims(parsed.claims, {
      audience: slug,
      nowSeconds: Math.floor(Date.now() / 1000),
    }),
  ).toBeUndefined();
  expect(parsed.claims.sub).toBe('owner@example.com');
});
