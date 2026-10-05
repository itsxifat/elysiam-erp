import { mkdirSync } from 'node:fs';
import path from 'node:path';

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

import { signIn, user } from './stack/helpers.js';

/**
 * M35a's offers screens against the real stack: Discounts and Flash sales under Campaigns.
 *
 * A marketing user (the role §6 gives promotions) creates an automatic buy-two-get-one
 * discount scoped to the provisioned product, then a flash sale putting that product's sizes
 * on sale, one with five units and one with all its stock, switched on. Every screen is
 * checked with axe (no serious or critical violation) and photographed in both themes into
 * `docs/review/M35a/` for a person to judge. Nothing is stubbed: the rows are the real API's.
 */

test.describe.configure({ mode: 'serial' });

const REVIEW_DIR = path.resolve(import.meta.dirname, '../../../docs/review/M35a');

let page: Page;

async function shot(name: string): Promise<void> {
  mkdirSync(REVIEW_DIR, { recursive: true });
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(REVIEW_DIR, `${name}.png`), fullPage: true });
}

async function noBlockingViolations(label: string): Promise<void> {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const blocking = result.violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .map((violation) => ({ page: label, id: violation.id, help: violation.help }));
  expect(blocking).toEqual([]);
}

/** Both themes, the dark one through the same switch the shell's toggle writes. */
async function bothThemes(name: string): Promise<void> {
  await noBlockingViolations(`${name} (light)`);
  await shot(`${name}-light`);
  await page.evaluate(() => localStorage.setItem('elysium-theme', 'dark'));
  await page.reload();
  await page.waitForLoadState('networkidle');
  await noBlockingViolations(`${name} (dark)`);
  await shot(`${name}-dark`);
  await page.evaluate(() => localStorage.setItem('elysium-theme', 'light'));
  await page.reload();
  await page.waitForLoadState('networkidle');
}

const run = Date.now().toString(36).toUpperCase().slice(-5);

test.beforeAll(async ({ browser }) => {
  page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  // Marketing has no second-factor wall (only money and admin roles do).
  await signIn(page, user('marketing').email);
  await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible();
});

test.afterAll(async () => {
  await page.context().close();
});

test('discounts: an automatic buy-two-get-one on one product, listed', async () => {
  await page.goto('/campaigns');
  await expect(page.getByRole('heading', { name: 'Discounts' })).toBeVisible();

  await page.getByRole('button', { name: 'New discount' }).click();
  const dialog = page.getByRole('dialog', { name: 'New discount' });
  await dialog.getByRole('radio', { name: 'Automatic' }).check();
  const title = `Buy two ${run}`;
  await dialog.getByRole('textbox', { name: 'Name' }).fill(title);
  await dialog.getByRole('combobox', { name: 'Offer type' }).click();
  await page.getByRole('option', { name: 'Buy X get Y' }).click();
  await dialog.getByRole('textbox', { name: 'Buy (units)' }).fill('2');
  await dialog.getByRole('textbox', { name: 'Get (units)' }).fill('1');

  // Scope: the provisioned product, found by name.
  await dialog.getByRole('radio', { name: 'Chosen products' }).check();
  // Nothing picked yet is named beside the scope, not sent.
  await dialog.getByRole('button', { name: 'Create discount' }).click();
  await expect(dialog.getByRole('alert').first()).toContainText('Choose at least one');
  await dialog.getByRole('searchbox', { name: 'Find a product' }).fill('Product e2e');
  await dialog.getByRole('button', { name: 'Add' }).first().click();
  await expect(dialog.getByRole('list', { name: 'Chosen products' })).toContainText('Product e2e');

  await dialog.getByRole('checkbox', { name: /Can combine/ }).check();
  await shot('discount-form');
  await dialog.getByRole('button', { name: 'Create discount' }).click();
  await expect(dialog).toBeHidden();

  const row = page.getByRole('row', { name: new RegExp(title) });
  await expect(row).toContainText('Automatic');
  await expect(row).toContainText('Buy 2');
  await expect(row).toContainText('Active');
  await bothThemes('discounts');
});

test('flash sales: a sale with five units of one size and all stock of another, switched on', async () => {
  await page.goto('/campaigns/flash-sales');
  await expect(page.getByRole('heading', { name: 'Flash sales' })).toBeVisible();
  await page.getByRole('link', { name: 'New flash sale' }).click();
  await expect(page.getByRole('heading', { name: 'New flash sale' })).toBeVisible();

  const title = `Eid flash ${run}`;
  await page.getByRole('textbox', { name: 'Title', exact: true }).fill(title);
  await page.getByRole('searchbox', { name: 'Find a product' }).fill('Product e2e');
  await page.getByRole('button', { name: 'Add its sizes' }).first().click();

  const prices = page.getByRole('textbox', { name: /^Sale price \(Tk\)/ });
  await expect(prices).toHaveCount(2);
  // At the shelf price, the sale is refused beside the row, not sent.
  await prices.nth(0).fill('1500');
  await prices.nth(1).fill('1100');
  await page
    .getByRole('textbox', { name: /^Units at sale price/ })
    .nth(0)
    .fill('5');
  await page.getByRole('checkbox', { name: 'All stock' }).nth(1).check();
  await page.getByRole('checkbox', { name: 'Switched on' }).check();
  await page.getByRole('button', { name: 'Create flash sale' }).click();
  await expect(page.getByText('The sale price has to be below the price.')).toBeVisible();

  await prices.nth(0).fill('1200');
  await page.getByRole('button', { name: 'Create flash sale' }).click();
  await expect(page).toHaveURL(/\/campaigns\/flash-sales\/[0-9a-f-]{36}$/);
  await expect(page.getByText('Live', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('20% off')).toBeVisible();
  await bothThemes('flash-sale-editor');

  await page.goto('/campaigns/flash-sales');
  const row = page.getByRole('row', { name: new RegExp(title) });
  await expect(row).toContainText('Live');
  await expect(row).toContainText('0 / All stock');
  await bothThemes('flash-sales');

  // Switched off from the list: a draft again.
  await row.getByRole('button', { name: 'Switch off' }).click();
  await expect(page.getByRole('row', { name: new RegExp(title) })).toContainText('Off');
});
