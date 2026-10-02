import { mkdirSync } from 'node:fs';
import path from 'node:path';

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

import { enrolSecondFactor, signIn, stack, user } from './stack/helpers.js';

/**
 * The console gaps against the real stack (D-392 to D-394).
 *
 * A desk agent walks an order from pending to delivered with nothing but the order detail's
 * buttons — Confirm, Mark packed, Hand to courier, Mark delivered — each a real transition
 * through the API, the stock and the ledger. A second order is packed from the list in bulk.
 * Then an org admin (through the real second-factor enrolment) opens every settings tab, sends
 * a threshold relaxation for approval and issues a website order key, whose secret is shown
 * once. Every screen is checked with axe (no serious or critical violation) and photographed
 * in both themes into `docs/review/gaps/`.
 */

test.describe.configure({ mode: 'serial' });

const REVIEW_DIR = path.resolve(import.meta.dirname, '../../../docs/review/gaps');

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

let desk: Page;
let admin: Page;

test.beforeAll(async ({ browser }) => {
  desk = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await signIn(desk, user('desk').email);
  await expect(desk.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible();

  admin = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await signIn(admin, user('admin').email);
  await enrolSecondFactor(admin);
  await expect(admin.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible();
});

test.afterAll(async () => {
  await desk.context().close();
  await admin.context().close();
});

/** The status in the order detail's heading. */
async function expectStatus(page: Page, orderNo: string, status: string): Promise<void> {
  await expect(page.getByRole('heading', { level: 1 }).filter({ hasText: orderNo })).toContainText(
    status,
  );
}

test('the desk walks an order from pending to delivered with the detail’s buttons', async () => {
  const order = stack().lifecycleOrder;
  await desk.goto(`/orders/${order.id}`);
  await expectStatus(desk, order.orderNo, 'Pending');
  // §9 from pending: confirm or cancel, and nothing a later status would offer.
  await expect(desk.getByRole('button', { name: 'Mark delivered' })).toHaveCount(0);
  await expect(desk.getByText('No parcel booked yet.')).toBeVisible();
  await bothThemes(desk, 'order-detail-pending');

  await desk.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expectStatus(desk, order.orderNo, 'Confirmed');

  await desk.getByRole('button', { name: 'Mark packed' }).click();
  await expectStatus(desk, order.orderNo, 'Packed');
  // Cancel is still allowed from packed; Release is not (the order is not held).
  await expect(desk.getByRole('button', { name: 'Release hold' })).toHaveCount(0);

  await desk.getByRole('button', { name: 'Hand to courier' }).click();
  const ship = desk.getByRole('dialog', { name: 'Hand this order to the courier' });
  await ship.getByLabel('Courier consignment number (optional)').fill('E2E-CN-1');
  await shot(desk, 'order-ship-dialog');
  await ship.getByRole('button', { name: 'Hand to courier' }).click();
  await expect(ship).toBeHidden();
  await expectStatus(desk, order.orderNo, 'Shipped');
  await bothThemes(desk, 'order-detail-shipped');

  await desk.getByRole('button', { name: 'Mark delivered' }).click();
  const deliver = desk.getByRole('dialog', { name: 'Mark this order delivered' });
  // The amount defaults to the order's COD: ৳1,500 + ৳60 delivery.
  await expect(deliver.getByLabel('Amount the rider collected (৳)')).toHaveValue('1560.00');
  await shot(desk, 'order-deliver-dialog');
  await deliver.getByRole('button', { name: 'Mark delivered' }).click();
  await expect(deliver).toBeHidden();
  await expectStatus(desk, order.orderNo, 'Delivered');
  // Delivered: §9's only move left is an exchange, which has its own form — no button here.
  for (const name of ['Start return', 'Hand to courier', 'Mark delivered', 'Cancel']) {
    await expect(desk.getByRole('button', { name, exact: true })).toHaveCount(0);
  }
  await bothThemes(desk, 'order-detail-delivered');
});

test('the list packs selected orders in bulk', async () => {
  const order = stack().bulkOrder;
  await desk.goto('/orders?status=confirmed');
  await desk.getByRole('checkbox', { name: `Select this order ${order.orderNo}` }).check();
  await bothThemes(desk, 'order-list-bulk');
  // `bothThemes` reloads the page, which clears a selection (it is a gesture, not a view).
  await desk.getByRole('checkbox', { name: `Select this order ${order.orderNo}` }).check();
  await desk.getByRole('button', { name: 'Pack selected' }).click();
  await expect(desk.getByRole('status').filter({ hasText: '1 moved' })).toBeVisible();

  await desk.goto(`/orders/${order.id}`);
  await expectStatus(desk, order.orderNo, 'Packed');
});

test('an org admin opens every settings tab from the sidebar', async () => {
  await admin.getByRole('navigation', { name: 'Primary navigation' }).getByText('Settings').click();
  await expect(admin).toHaveURL(/\/settings\/thresholds$/);
  const tabs = admin.getByRole('navigation', { name: 'Settings' });
  for (const name of [
    'Approval thresholds',
    'Delivery zones',
    'Courier accounts',
    'Website order keys',
    'Till registers',
  ]) {
    await expect(tabs.getByRole('link', { name })).toBeVisible();
  }

  // A first threshold is a relaxation from "every request held", so it waits for a second
  // org admin and the screen says so rather than showing it as in force (D-073).
  await expect(admin.getByRole('row').filter({ hasText: 'Supplier payment' })).toBeVisible();
  await bothThemes(admin, 'settings-thresholds');
  const supplier = admin.getByRole('row').filter({ hasText: 'Supplier payment' });
  await supplier.getByRole('textbox').fill('5000');
  await supplier.getByRole('button', { name: 'Set' }).click();
  await expect(supplier.getByText('Sent to another org admin to approve.')).toBeVisible();
  await expect(supplier.getByText('৳5,000.00')).toBeVisible();

  await tabs.getByRole('link', { name: 'Delivery zones' }).click();
  await expect(admin.getByRole('row').filter({ hasText: 'inside_dhaka' })).toBeVisible();
  await bothThemes(admin, 'settings-zones');

  await tabs.getByRole('link', { name: 'Courier accounts' }).click();
  await expect(admin.getByRole('button', { name: 'Set up a courier' })).toBeVisible();
  await bothThemes(admin, 'settings-couriers');
  await admin.getByRole('button', { name: 'Set up a courier' }).click();
  const courierForm = admin.getByRole('dialog', { name: 'Courier account' });
  await courierForm.getByLabel('Adapter').selectOption('steadfast');
  // The adapter's own credential names, as password fields, and the honesty note (D-176).
  await expect(courierForm.locator('input[type="password"]').first()).toBeVisible();
  await expect(
    courierForm.getByText(/not built from the courier’s own documentation/),
  ).toBeVisible();
  await shot(admin, 'settings-courier-form');
  await courierForm.getByRole('button', { name: 'Cancel' }).click();

  await tabs.getByRole('link', { name: 'Website order keys' }).click();
  await admin.getByRole('button', { name: 'Issue a key' }).click();
  const issue = admin.getByRole('dialog', { name: 'Issue a website order key' });
  await issue.getByLabel('Label').fill('E2E landing page');
  await issue.getByRole('button', { name: 'Issue a key' }).click();
  const secret = admin.getByRole('dialog', { name: 'Copy the secret now' });
  await expect(secret.locator('code')).not.toBeEmpty();
  // Not photographed: a review screenshot of a secret is a secret in the repository, even a
  // throwaway one (invariant 10).
  await secret.getByRole('button', { name: 'Close' }).first().click();
  await expect(admin.getByRole('row').filter({ hasText: 'E2E landing page' })).toBeVisible();
  // The secret is not on the page once the dialog is gone.
  await expect(admin.locator('code')).toHaveCount(0);
  await bothThemes(admin, 'settings-site-keys');

  await tabs.getByRole('link', { name: 'Till registers' }).click();
  await expect(admin.getByRole('button', { name: 'Add register' })).toBeVisible();
  await bothThemes(admin, 'settings-registers');
});

test('a sales agent sees no Settings link', async () => {
  const nav = desk.getByRole('navigation', { name: 'Primary navigation' });
  await expect(nav.getByText('Orders')).toBeVisible();
  await expect(nav.getByText('Settings')).toHaveCount(0);
});
