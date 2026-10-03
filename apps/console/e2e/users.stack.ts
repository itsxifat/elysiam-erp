import { mkdirSync } from 'node:fs';
import path from 'node:path';

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type Page } from '@playwright/test';

import { enrolSecondFactor, signIn, user } from './stack/helpers.js';

/**
 * The Staff screen against the real stack (gaps-users-auth).
 *
 * The journeys a human tester hits first, each end to end through the real API, Better
 * Auth and the database: an admin invites someone, who sets a password from the link and
 * signs in; a forgotten password is reset, the old one stops working and the link sets a
 * new one; an accountant's lost phone is reset only after a second admin approves, and
 * they meet the enrolment screen again; a leaver is deactivated and cannot sign back in.
 * Every screen is checked with axe (no serious or critical violation), the main ones in
 * both themes, and photographed for review.
 */

test.describe.configure({ mode: 'serial' });

const REVIEW_DIR = path.resolve(import.meta.dirname, '../../../docs/review/gaps-users-auth');

async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(REVIEW_DIR, { recursive: true });
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(REVIEW_DIR, `${name}.png`), fullPage: true });
}

async function noBlockingViolations(page: Page, label: string): Promise<void> {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const blocking = result.violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .map((violation) => ({ page: label, id: violation.id, help: violation.help }));
  expect(blocking).toEqual([]);
}

async function bothThemes(page: Page, name: string): Promise<void> {
  await noBlockingViolations(page, `${name} (light)`);
  await shot(page, `${name}-light`);
  await page.evaluate(() => localStorage.setItem('elysium-theme', 'dark'));
  await page.reload();
  await page.waitForLoadState('networkidle');
  await noBlockingViolations(page, `${name} (dark)`);
  await shot(page, `${name}-dark`);
  await page.evaluate(() => localStorage.setItem('elysium-theme', 'light'));
  await page.reload();
  await page.waitForLoadState('networkidle');
}

async function freshPage(browser: Browser): Promise<Page> {
  return (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
}

/** The link the open link dialog shows, then the dialog closed. */
async function takeLink(page: Page): Promise<string> {
  const dialog = page.getByRole('dialog', { name: /Give them this link/ });
  await expect(dialog).toBeVisible();
  const link = await dialog.getByLabel('Link').inputValue();
  expect(link).toMatch(/#token=/);
  expect(new URL(link).search).toBe('');
  await dialog.getByRole('button', { name: 'Close' }).last().click();
  return link;
}

async function setPasswordFromLink(page: Page, link: string, password: string): Promise<void> {
  await page.goto(link);
  // The token leaves the address bar as soon as it is read.
  await expect(page).not.toHaveURL(/token=/);
  await page.getByLabel('New password').fill(password);
  await page.getByLabel('Type it again').fill(password);
  await page.getByRole('button', { name: 'Set password' }).click();
  await expect(page.getByRole('heading', { name: 'Password set' })).toBeVisible();
}

async function manage(page: Page, name: string): Promise<void> {
  await page.goto('/users');
  await page.getByRole('button', { name: `Manage: ${name}` }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
}

/** Press an action in the open Manage dialog, give a reason, and confirm. */
async function withReason(
  page: Page,
  action: string,
  title: string,
  confirm: string,
): Promise<void> {
  await page.getByRole('dialog').getByRole('button', { name: action }).click();
  const dialog = page.getByRole('dialog', { name: title });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Reason').fill('Asked by the person, on the phone');
  await dialog.getByRole('button', { name: confirm, exact: true }).click();
}

const run = Date.now().toString(36).slice(-6);
const hire = { name: `New Hire ${run}`, email: `e2e.hire.${run}@example.invalid` };
const FIRST_PASSWORD = 'first-light-of-dhaka';
const SECOND_PASSWORD = 'monsoon-over-the-river';

let admin: Page;
let admin2: Page;

test.beforeAll(async ({ browser }) => {
  admin = await freshPage(browser);
  await signIn(admin, user('admin').email);
  await enrolSecondFactor(admin);
  await expect(admin.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible();

  admin2 = await freshPage(browser);
  await signIn(admin2, user('admin2').email);
  await enrolSecondFactor(admin2);
  await expect(admin2.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible();
});

test.afterAll(async () => {
  await admin.context().close();
  await admin2.context().close();
});

test('an admin invites someone, who sets a password from the link and signs in', async ({
  browser,
}) => {
  await admin
    .getByRole('navigation', { name: 'Primary navigation' })
    .getByRole('link', {
      name: 'Staff',
    })
    .click();
  await expect(admin.getByRole('heading', { name: 'Staff', level: 1 })).toBeVisible();
  await bothThemes(admin, 'staff-list');

  await admin.getByRole('button', { name: 'Invite someone' }).click();
  const dialog = admin.getByRole('dialog');
  await dialog.getByLabel('Email').fill(hire.email);
  await dialog.getByLabel('Full name').fill(hire.name);
  // The kit's select since the design refresh (D-443): open it, then choose.
  await dialog.getByRole('combobox', { name: 'Role', exact: true }).click();
  await admin.getByRole('option', { name: 'Sales', exact: true }).click();
  await noBlockingViolations(admin, 'invite dialog');
  await shot(admin, 'invite-dialog');
  await dialog.getByRole('button', { name: 'Invite', exact: true }).click();

  await noBlockingViolations(admin, 'link dialog');
  await shot(admin, 'link-dialog');
  const link = await takeLink(admin);
  expect(new URL(link).pathname).toBe('/accept-invite');

  // The set-password screen, in both themes, from a link that is not the real one.
  const preview = await freshPage(browser);
  await preview.goto('/accept-invite#token=preview-only');
  await expect(preview.getByRole('heading', { name: 'Set your password' })).toBeVisible();
  await noBlockingViolations(preview, 'set password (light)');
  await shot(preview, 'set-password-light');
  await preview.evaluate(() => localStorage.setItem('elysium-theme', 'dark'));
  // A real load, not a fragment change: the stored theme is applied as the page loads.
  await preview.goto('about:blank');
  await preview.goto('/accept-invite#token=preview-only');
  await expect(preview.locator('html')).toHaveClass(/dark/);
  await expect(preview.getByRole('heading', { name: 'Set your password' })).toBeVisible();
  await noBlockingViolations(preview, 'set password (dark)');
  await shot(preview, 'set-password-dark');
  await preview.context().close();

  const person = await freshPage(browser);
  await setPasswordFromLink(person, link, FIRST_PASSWORD);
  await person.getByRole('button', { name: 'Go to sign in' }).click();
  await signIn(person, hire.email, FIRST_PASSWORD);
  await expect(person.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible();

  // A link works once.
  const reused = await freshPage(browser);
  await reused.goto(link);
  await reused.getByLabel('New password').fill(SECOND_PASSWORD);
  await reused.getByLabel('Type it again').fill(SECOND_PASSWORD);
  await reused.getByRole('button', { name: 'Set password' }).click();
  await expect(reused.getByText(/expired or was already used/)).toBeVisible();
  await reused.context().close();
  await person.context().close();

  await admin.goto('/users');
  await expect(admin.getByRole('row', { name: new RegExp(hire.name) })).toContainText('Active');
});

test('a forgotten password: the old one stops at once, and the link sets a new one', async ({
  browser,
}) => {
  const person = await freshPage(browser);
  await signIn(person, hire.email, FIRST_PASSWORD);
  await expect(person.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible();

  await manage(admin, hire.name);
  await noBlockingViolations(admin, 'manage dialog');
  await shot(admin, 'manage-dialog');
  await withReason(admin, 'Reset password', 'Reset their password?', 'Reset');
  const link = await takeLink(admin);
  expect(new URL(link).pathname).toBe('/reset-password');

  // Their open session ended with the reset.
  await person.reload();
  await expect(person.locator('input[type="password"]')).toBeVisible();

  await signIn(person, hire.email, FIRST_PASSWORD);
  await expect(person.getByText('That email and password do not match.')).toBeVisible();

  await setPasswordFromLink(person, link, SECOND_PASSWORD);
  await signIn(person, hire.email, SECOND_PASSWORD);
  await expect(person.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible();
  await person.context().close();
});

test('a lost phone: an accountant is reset only after a second admin approves', async ({
  browser,
}) => {
  const locked = user('locked');
  const accountant = await freshPage(browser);
  await signIn(accountant, locked.email);
  await enrolSecondFactor(accountant);
  await expect(accountant.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible();

  await manage(admin, 'E2E locked agent');
  await expect(admin.getByText('another admin must agree')).toBeVisible();
  await withReason(admin, 'Reset two-step verification', 'Reset two-step verification?', 'Reset');
  await expect(admin.getByText('Asked. Another admin approves it')).toBeVisible();

  // The admin who asked cannot approve it themselves; the screen offers them nothing.
  await admin.goto('/users');
  await expect(admin.getByText('Waiting for another admin to approve.')).toBeVisible();

  // Nothing has happened to the accountant yet.
  await accountant.reload();
  await expect(accountant.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible();

  await admin2.goto('/users');
  const waiting = admin2.getByRole('region', { name: 'Sign-in resets waiting' });
  await expect(waiting).toContainText('E2E locked agent');
  await bothThemes(admin2, 'staff-waiting');
  await waiting.getByRole('button', { name: 'Approve' }).click();
  await admin2.getByRole('dialog').getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(admin2.getByRole('region', { name: 'Sign-in resets waiting' })).toHaveCount(0);

  // Signed out, and the next sign-in is the enrolment screen, not a code prompt.
  await accountant.reload();
  await expect(accountant.locator('input[type="password"]')).toBeVisible();
  await signIn(accountant, locked.email);
  await enrolSecondFactor(accountant);
  await expect(accountant.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible();
  await accountant.context().close();
});

test('a leaver is deactivated and cannot sign back in', async ({ browser }) => {
  await manage(admin, hire.name);
  await withReason(admin, 'Deactivate', 'Deactivate this person?', 'Deactivate');
  await expect(admin.getByText('Deactivated. Their sessions have ended.')).toBeVisible();
  await expect(admin.getByRole('row', { name: new RegExp(hire.name) })).toContainText(
    'Deactivated',
  );

  const person = await freshPage(browser);
  await signIn(person, hire.email, SECOND_PASSWORD);
  await expect(person.getByText('This account is not active.')).toBeVisible();
  await noBlockingViolations(person, 'inactive sign-in');
  await shot(person, 'inactive-sign-in');
  await person.context().close();
});
