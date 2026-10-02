import { createHmac } from 'node:crypto';

import { expect, type Page } from '@playwright/test';

import type { StackInfo } from './global-setup.js';

/**
 * What every real-stack spec needs: the stack's details, a sign-in, and a two-factor
 * enrolment done the way a person does it.
 */

export function stack(): StackInfo {
  const raw = process.env.E2E_STACK;
  if (raw === undefined) throw new Error('E2E_STACK is missing: run with -c e2e/stack.config.ts');
  return JSON.parse(raw) as StackInfo;
}

export type StackRole =
  'desk' | 'queue' | 'accounts' | 'switcher' | 'treasurer' | 'marketing' | 'checker';

export function user(role: StackRole) {
  const found = stack().users.find((entry) => entry.role === role);
  if (found === undefined) throw new Error(`no ${role} user was provisioned`);
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

/**
 * Sign in by the form's own input types, so the same helper works in Bangla. The
 * English labels are asserted where a check is about the English screen.
 */
export async function signIn(page: Page, email: string): Promise<void> {
  await page.goto('/');
  const form = page.locator('form').filter({ has: page.locator('input[type="password"]') });
  await expect(form).toBeVisible();
  await form.locator('input[type="email"]').fill(email);
  await form.locator('input[type="password"]').fill(stack().password);
  await form.locator('button[type="submit"]').click();
}

/**
 * Clear §6's enrolment wall exactly as a person would: read the setup key off the
 * screen, compute the code an authenticator app would show, confirm.
 */
export async function enrolSecondFactor(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Set up two-step verification' })).toBeVisible();
  const secret = (await page.locator('code').first().innerText()).trim();
  expect(secret.length).toBeGreaterThan(15);
  await page.getByRole('checkbox', { name: 'I have saved my recovery codes' }).check();
  await page.getByLabel(/^Verification code/).fill(totp(secret));
  await page.getByRole('button', { name: 'Confirm and continue' }).click();
}
