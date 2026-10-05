import { mkdirSync } from 'node:fs';
import path from 'node:path';

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

import { enrolSecondFactor, signIn, stack, user } from './stack/helpers.js';

/**
 * M17's screens against the real stack: an advance from claim to verification, and the
 * returns report.
 *
 * The desk agent records a bKash claim on an order they work; the order's COD does not move.
 * An accounts user (through the real second-factor enrolment) finds it in the queue and
 * verifies it into a wallet; the agent then sees it verified and the COD lowered. The
 * returns report shows the provisioned return under its reason. Every screen is checked with
 * axe (no serious or critical violation) and photographed in both themes.
 *
 * Nothing is stubbed: the claim and the verification are rows and a journal the real API
 * wrote.
 */

test.describe.configure({ mode: 'serial' });

const REVIEW_DIR = path.resolve(import.meta.dirname, '../../../docs/review/M17');

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

const run = Date.now().toString(36).toUpperCase().slice(-6);
const reference = `E2E${run}9`;

let desk: Page;
let checker: Page;

test.beforeAll(async ({ browser }) => {
  desk = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await signIn(desk, user('desk').email);
  await expect(desk.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible();

  checker = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await signIn(checker, user('checker').email);
  await enrolSecondFactor(checker);
  await expect(checker.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible();
});

test.afterAll(async () => {
  await desk.context().close();
  await checker.context().close();
});

test('the desk records an advance claim, and nothing changes until accounts verifies it', async () => {
  const order = stack().advanceOrder;
  await desk.goto(`/orders/${order.id}`);
  await expect(desk.getByRole('heading', { name: order.orderNo })).toBeVisible();
  const panel = desk
    .locator('section')
    .filter({ has: desk.getByRole('heading', { name: 'Advances' }) });
  await expect(panel.getByText('No advance recorded.')).toBeVisible();

  await panel.getByRole('button', { name: 'Record advance' }).click();
  const dialog = desk.getByRole('dialog', { name: 'Record an advance' });
  await dialog.getByLabel('Transaction id').fill(reference);
  await dialog.getByLabel('Amount').fill('60');
  await dialog.getByRole('button', { name: 'Record' }).click();
  await expect(dialog).toBeHidden();

  await expect(panel.getByText(reference)).toBeVisible();
  await expect(panel.getByText('Waiting for accounts')).toBeVisible();
  // The COD the rider collects is untouched: ৳1,500 + ৳60 delivery.
  await expect(desk.getByText('৳1,560.00').first()).toBeVisible();
  await bothThemes(desk, 'order-advance-claimed');
});

test('accounts verifies it from the queue, and the order shows it verified', async () => {
  await checker.goto('/accounts/advances');
  await expect(checker.getByRole('heading', { name: 'Advances to check' })).toBeVisible();
  const row = checker.getByRole('row').filter({ hasText: reference });
  await expect(row).toBeVisible();
  await bothThemes(checker, 'advances-queue');

  await row.getByRole('button', { name: 'Verify' }).click();
  const dialog = checker.getByRole('dialog');
  // The bank wallet the stack provisions (code 1100), whatever its display name is. The wallet
  // picker is the kit's Select (D-443): open it, then choose from its listbox, which is drawn
  // in a portal outside the dialog.
  await dialog.getByRole('combobox', { name: /Wallet it arrived in/ }).click();
  await checker.getByRole('option', { name: /1100/ }).click();
  await shot(checker, 'advances-verify-dialog');
  await dialog.getByRole('button', { name: 'Verify' }).click();
  await expect(checker.getByText('Saved.')).toBeVisible();
  await expect(checker.getByRole('row').filter({ hasText: reference })).toHaveCount(0);

  await desk.goto(`/orders/${stack().advanceOrder.id}`);
  const panel = desk
    .locator('section')
    .filter({ has: desk.getByRole('heading', { name: 'Advances' }) });
  await expect(panel.getByText('Verified')).toBeVisible();
  // Verified money lowers the COD: ৳1,560 − ৳60.
  await expect(desk.getByText('৳1,500.00').first()).toBeVisible();
});

test('returns by reason shows the provisioned return under its reason', async () => {
  await desk.goto('/orders/returns');
  await expect(desk.getByRole('heading', { name: 'Returns by reason' })).toBeVisible();
  await expect(desk.getByRole('row').filter({ hasText: 'Buyer refused it' })).toBeVisible();
  await bothThemes(desk, 'returns-by-reason');
});
