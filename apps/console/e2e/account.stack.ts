import { mkdirSync } from 'node:fs';
import path from 'node:path';

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type Page } from '@playwright/test';

import { signIn, stack, totp, user } from './stack/helpers.js';

/**
 * My account against the real stack (M40): a sales person finds My account in the account
 * menu, renames themselves, sets up two-step sign-in from the QR code's key, sees a second
 * device and signs it out, turns two-step off again, and changes their password with their
 * other devices signed out. Each screen is checked with axe (no serious or critical
 * violation) in both themes and photographed for review.
 */

test.describe.configure({ mode: 'serial' });

const REVIEW_DIR = path.resolve(import.meta.dirname, '../../../docs/review/M40');
const NEW_PASSWORD = 'a-brand-new-account-passphrase';

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
  await page.evaluate(() => localStorage.setItem('erp-theme', 'dark'));
  await page.reload();
  await page.waitForLoadState('networkidle');
  await noBlockingViolations(page, `${name} (dark)`);
  await shot(page, `${name}-dark`);
  await page.evaluate(() => localStorage.setItem('erp-theme', 'light'));
  await page.reload();
  await page.waitForLoadState('networkidle');
}

async function freshPage(browser: Browser): Promise<Page> {
  return (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
}

let secret = '';

test('My account is in the account menu, and renames its person', async ({ browser }) => {
  const page = await freshPage(browser);
  await signIn(page, user('self').email);
  await expect(page.getByRole('button', { name: 'Account' })).toBeVisible();
  // The menu is its own chunk (D-451): until it lands the topbar shows the same button, inert.
  // The real trigger is the one that says whether its menu is open.
  await expect(page.getByRole('button', { name: 'Account' })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  await page.getByRole('button', { name: 'Account' }).click();
  await page.getByRole('menuitem', { name: 'My account' }).click();
  await expect(page).toHaveURL(/\/account$/);
  await expect(page.getByRole('heading', { name: 'My account' })).toBeVisible();
  await expect(page.getByText('No: your choice')).toBeVisible();
  await expect(page.getByText('This device', { exact: true })).toBeVisible();
  await bothThemes(page, 'a-account');

  await page.getByLabel('Name', { exact: true }).fill('Rahima Akter');
  await page.getByRole('button', { name: 'Save name' }).click();
  await expect(page.getByText('Your name is saved.')).toBeVisible();
  await page.context().close();
});

test('sets up two-step sign-in from the QR code’s key, and the next sign-in asks for it', async ({
  browser,
}) => {
  const page = await freshPage(browser);
  await signIn(page, user('self').email);
  await expect(page.getByRole('button', { name: 'Account' })).toBeVisible();
  await page.goto('/account');
  await page.getByRole('button', { name: 'Set up two-step sign-in' }).click();
  const dialog = page.getByRole('dialog', { name: 'Set up two-step sign-in' });
  await dialog.getByLabel('Your password').fill(stack().password);
  await dialog.getByRole('button', { name: 'Continue' }).click();
  await expect(
    dialog.getByRole('img', { name: 'QR code for your authenticator app' }),
  ).toBeVisible();
  secret = (await dialog.locator('code').first().innerText()).replace(/\s/g, '');
  expect(secret.length).toBeGreaterThan(15);
  await noBlockingViolations(page, 'set-up dialog');
  await shot(page, 'b-set-up');
  await dialog.getByRole('checkbox', { name: 'I have saved my recovery codes' }).check();
  await dialog.getByLabel('Enter the code the app shows now').fill(totp(secret));
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByText('Two-step sign-in is on.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Set up on a new phone' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Turn off' })).toBeEnabled();
  await bothThemes(page, 'c-account-two-step-on');

  // A second device: it is asked for the code, and appears on the first one's list.
  const other = await freshPage(browser);
  await signIn(other, user('self').email);
  await other.getByLabel(/^Verification code/).fill(totp(secret));
  await other.getByRole('button', { name: 'Verify' }).click();
  await expect(other.getByRole('button', { name: 'Account' })).toBeVisible();

  // Every other session of this person: the second device, and the first test's, whose
  // window closed without signing out.
  await page.reload();
  const signOuts = page.getByRole('button', { name: /^Sign out .+ on / });
  await expect(signOuts.first()).toBeVisible();
  const before = await signOuts.count();
  expect(before).toBeGreaterThanOrEqual(1);
  await signOuts.first().click();
  await expect(page.getByText('That device is signed out.')).toBeVisible();
  await expect(signOuts).toHaveCount(before - 1);
  if (before > 1) {
    await page.getByRole('button', { name: 'Sign out all other devices' }).click();
    const confirm = page.getByRole('dialog', { name: 'Sign out all other devices?' });
    await confirm.getByRole('button', { name: 'Sign out all other devices' }).click();
    await expect(page.getByText('Your other devices are signed out.')).toBeVisible();
  }
  await expect(page.getByText('Only this device is signed in.')).toBeVisible();
  await other.reload();
  await expect(other.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await other.context().close();
  await page.context().close();
});

test('turns two-step sign-in off with the password and a code', async ({ browser }) => {
  const page = await freshPage(browser);
  await signIn(page, user('self').email);
  await page.getByLabel(/^Verification code/).fill(totp(secret));
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByRole('button', { name: 'Account' })).toBeVisible();
  await page.goto('/account');
  await page.getByRole('button', { name: 'Turn off' }).click();
  const dialog = page.getByRole('dialog', { name: 'Turn off two-step sign-in?' });
  await dialog.getByLabel('Your password').fill(stack().password);
  await dialog.getByLabel('Code your authenticator app shows now').fill(totp(secret));
  await dialog.getByRole('button', { name: 'Turn off' }).click();
  await expect(page.getByText('Two-step sign-in is off.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Set up two-step sign-in' })).toBeVisible();
  await page.context().close();
});

test('changes the password, signing the other devices out', async ({ browser }) => {
  const page = await freshPage(browser);
  const other = await freshPage(browser);
  await signIn(page, user('self').email);
  await signIn(other, user('self').email);
  await expect(page.getByRole('button', { name: 'Account' })).toBeVisible();
  await expect(other.getByRole('button', { name: 'Account' })).toBeVisible();

  await page.goto('/account');
  await page.getByLabel('Current password').fill(stack().password);
  await page.getByLabel('New password', { exact: true }).fill(NEW_PASSWORD);
  await page.getByLabel('New password again').fill('not-the-same-passphrase');
  await page.getByRole('button', { name: 'Change password' }).click();
  await expect(page.getByText('The two new passwords differ.')).toBeVisible();

  await page.getByLabel('New password again').fill(NEW_PASSWORD);
  await page.getByRole('button', { name: 'Change password' }).click();
  await expect(
    page.getByText('Your password is changed, and your other devices are signed out.'),
  ).toBeVisible();
  // This device carries on in its brand; the other is signed out.
  await expect(page.getByRole('heading', { name: 'My account' })).toBeVisible();
  await other.reload();
  await expect(other.getByRole('heading', { name: 'Sign in' })).toBeVisible();

  const fresh = await freshPage(browser);
  await signIn(fresh, user('self').email, NEW_PASSWORD);
  await expect(fresh.getByRole('button', { name: 'Account' })).toBeVisible();
  await fresh.context().close();
  await other.context().close();
  await page.context().close();
});
