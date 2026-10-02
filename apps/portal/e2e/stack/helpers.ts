import { createHmac } from 'node:crypto';

import { expect, type Page } from '@playwright/test';

import type { StackInfo } from './global-setup.js';

/**
 * What the investor portal's real-stack spec needs: the stack's details, a sign-in, the
 * enrolment done the way a person does it, and a way to ask the API something from inside
 * the signed-in browser session.
 */

export function stack(): StackInfo {
  const raw = process.env.E2E_STACK;
  if (raw === undefined) throw new Error('E2E_STACK is missing: run with -c e2e/stack.config.ts');
  return JSON.parse(raw) as StackInfo;
}

export function user(role: 'alpha' | 'beta') {
  const found = stack().users.find((entry) => entry.role === role);
  if (found === undefined) throw new Error(`no ${role} investor was provisioned`);
  return found;
}

/** RFC 4648 base32, as an authenticator app reads a setup key. */
function base32(input: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of input.replace(/[\s=]/g, '').toUpperCase()) {
    const index = alphabet.indexOf(char);
    if (index < 0) throw new Error('the setup key is not base32');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** RFC 6238 TOTP: HMAC-SHA1, 30-second step, 6 digits, which is what an app computes. */
export function totp(secret: string, at: number = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const digest = createHmac('sha1', base32(secret)).update(counter).digest();
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

/** Switch the page to English, from whichever language it is in. */
export async function inEnglish(page: Page): Promise<void> {
  if ((await page.locator('html').getAttribute('lang')) === 'en') return;
  await page.getByRole('button', { name: 'ভাষা বদলান' }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
}

export async function signIn(page: Page, email: string): Promise<void> {
  const form = page.locator('form').filter({ has: page.locator('input[type="password"]') });
  await expect(form).toBeVisible();
  await form.locator('input[type="email"]').fill(email);
  await form.locator('input[type="password"]').fill(stack().password);
  await form.locator('button[type="submit"]').click();
}

/** §6's enrolment wall, cleared as a person clears it: key off the screen, code from it. */
export async function enrolSecondFactor(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Set up two-step verification' })).toBeVisible();
  const secret = (await page.locator('code').first().innerText()).trim();
  expect(secret.length).toBeGreaterThan(15);
  await page.getByRole('checkbox', { name: 'I have saved my recovery codes' }).check();
  await page.getByLabel(/^Verification code/).fill(totp(secret));
  await page.getByRole('button', { name: 'Confirm and continue' }).click();
}

/**
 * A GET to the API from inside the page, with the page's own cookies: what this investor's
 * session can reach, whatever the screen chooses to draw.
 */
export async function apiFromPage(
  page: Page,
  path: string,
): Promise<{ status: number; body: string }> {
  return page.evaluate(
    async ({ base, path: target }) => {
      const response = await fetch(new URL(target, base), { credentials: 'include' });
      return { status: response.status, body: await response.text() };
    },
    { base: stack().apiUrl, path },
  );
}
