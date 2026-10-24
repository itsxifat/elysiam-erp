import { mkdirSync } from 'node:fs';
import path from 'node:path';

import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

import { totp } from '../stack/helpers.js';
import { PREVIEW_PORTS, type PreviewInfo, type PreviewLoginInfo } from './global-setup.js';

/**
 * Signing in as the owner would, from the credentials file, and looking at a screen.
 */

export function preview(): PreviewInfo {
  const raw = process.env.E2E_PREVIEW;
  if (raw === undefined)
    throw new Error('E2E_PREVIEW is missing: run with -c e2e/preview.config.ts');
  return JSON.parse(raw) as PreviewInfo;
}

/**
 * The preview's API, which the console, portal and till call across origins (their
 * `VITE_API_URL`). A test asks it what a person would read off a screen, in that person's
 * session: `page.request` carries the page's cookies.
 */
export function previewApiUrl(): string {
  return `http://localhost:${String(PREVIEW_PORTS.api)}`;
}

export function login(key: string): PreviewLoginInfo {
  const found = preview().logins[key];
  if (found === undefined) throw new Error(`the credentials file has no ${key} login`);
  return found;
}

const SHOTS = path.resolve(import.meta.dirname, '../../../../docs/review/preview');

/**
 * Better Auth's two-factor plugin allows three calls to `/two-factor/*` from one address in
 * ten seconds, and every enrolment starts with one. Enrolling four people back to back
 * from one machine is refused ("Too many attempts"), as it would be for an office behind
 * one public address. The limiter stays as it is; the run waits as a person would.
 */
const ENROLMENT_WINDOW_MS = 11_000;
let lastEnrolment = 0;

/** Call before the sign-in that leads to an enrolment: it starts the two-factor calls. */
export async function spaceEnrolment(page: Page): Promise<void> {
  const wait = lastEnrolment + ENROLMENT_WINDOW_MS - Date.now();
  if (wait > 0) await page.waitForTimeout(wait);
}

/** The enrolment screen as a person clears it: the key off the screen, an app's code. */
export async function enrolSecondFactor(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Set up two-step verification' })).toBeVisible();
  const secret = (await page.locator('code').first().innerText()).trim();
  await page.getByRole('checkbox', { name: 'I have saved my recovery codes' }).check();
  await page.getByLabel(/^Verification code/).fill(totp(secret));
  await page.getByRole('button', { name: 'Confirm and continue' }).click();
  lastEnrolment = Date.now();
}

/** The credentials form, then the two-step enrolment for the roles §6 walls. */
export async function signIn(page: Page, url: string, who: PreviewLoginInfo): Promise<void> {
  await page.goto(url);
  const form = page.locator('form').filter({ has: page.locator('input[type="password"]') });
  await expect(form).toBeVisible();
  await form.locator('input[type="email"]').fill(who.email);
  await form.locator('input[type="password"]').fill(who.password);
  if (who.twoFactor) await spaceEnrolment(page);
  await form.locator('button[type="submit"]').click();
  if (who.twoFactor) await enrolSecondFactor(page);
}

/** The console's shell, signed in: the primary navigation is on screen. */
export async function inConsole(page: Page): Promise<void> {
  await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible();
}

const FAILURES =
  /Something went wrong|You do not have permission|could not be reached|could not be loaded|No such screen/;

/**
 * Open a console screen: its heading shows, no failure is on it, and a screenshot is kept
 * for the review folder.
 */
export async function look(
  page: Page,
  shot: string,
  route: string,
  heading: string | RegExp,
  expectText?: RegExp,
): Promise<void> {
  await page.goto(route);
  await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
  if (expectText !== undefined) {
    await expect(page.getByText(expectText).first()).toBeVisible();
  }
  // Data loads after the heading; give it the moment a person would. Bounded, because the
  // realtime socket may keep a long-poll open and the network is then never idle.
  await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);
  await expect(page.getByText(FAILURES)).toHaveCount(0);
  await snap(page, shot);
  await accessible(page, shot, async () => {
    await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
    await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);
  });
}

/**
 * M30's accessibility pass: axe, WCAG 2.0 and 2.1 A and AA, on the screen as it stands, in
 * the light theme and then the dark one.
 *
 * The dark scan reloads with the theme stored, as a person switching would. Flipping the
 * `dark` class alone is not the dark theme: the brand accent's lightness is solved for the
 * theme when the app starts (`brand.ts`), so a class flip leaves the light accent on a dark
 * surface and reports contrast failures nobody will ever see. `ready` is what the screen
 * shows once it has loaded again. Recorded softly: every screen of the run is scanned and
 * reported before the test fails. Serious and critical only, the threshold every stack spec
 * uses.
 */
export async function accessible(
  page: Page,
  label: string,
  ready: () => Promise<void> = async () => {
    await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);
  },
): Promise<void> {
  for (const theme of ['light', 'dark'] as const) {
    if (theme === 'dark') {
      await page.evaluate(() => localStorage.setItem('erp-theme', 'dark'));
      await page.reload();
      await ready();
      await expect(page.locator('html')).toHaveClass(/dark/);
    }
    const result = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    const blocking = result.violations
      .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
      .map((violation) => ({
        id: violation.id,
        help: violation.help,
        targets: violation.nodes.slice(0, 5).map((node) => node.target.join(' ')),
      }));
    expect.soft(blocking, `${label} (${theme})`).toEqual([]);
  }
  // Back to light for whatever the test does next, as it started.
  await page.evaluate(() => localStorage.setItem('erp-theme', 'light'));
  await page.reload();
  await ready();
}

export async function snap(page: Page, name: string): Promise<void> {
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: false });
}
