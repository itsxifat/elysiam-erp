import { mkdirSync } from 'node:fs';
import path from 'node:path';

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

import { signIn, stack, user } from './stack/helpers.js';

/**
 * M16's buyer and campaign screens against the real stack.
 *
 * A marketing user — the role §6 gives promo codes, templates and the lapsed list — makes a
 * code, writes a greeting template, records an opt-out, finds the provisioned lapsed buyer
 * and opens their profile. Every screen is checked with axe (no serious or critical
 * violation) and photographed in both themes for a person to judge.
 *
 * Nothing is stubbed: the code, the template and the opt-out are rows the real API wrote.
 */

test.describe.configure({ mode: 'serial' });

const REVIEW_DIR = path.resolve(import.meta.dirname, '../../../docs/review/M16');

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

test('discounts: marketing makes a code, sees it listed, and pauses it', async () => {
  await page.goto('/campaigns');
  // M35a renamed the screen Discounts; a code is still made the M16 way (D-541).
  await expect(page.getByRole('heading', { name: 'Discounts' })).toBeVisible();
  // The desk's seeded code is already there.
  await expect(page.getByText(stack().promoCode, { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'New discount' }).click();
  const dialog = page.getByRole('dialog', { name: 'New discount' });
  const code = `WIN${run}`;
  await dialog.getByRole('textbox', { name: 'Code' }).fill(code);
  // A wrong rate is named beside the field, not sent.
  await dialog.getByRole('textbox', { name: 'Percent off' }).fill('150');
  await dialog.getByRole('button', { name: 'Create discount' }).click();
  await expect(dialog.getByRole('alert')).toContainText('between 0.01 and 100');

  await dialog.getByRole('textbox', { name: 'Percent off' }).fill('12.5');
  await dialog.getByRole('textbox', { name: 'Minimum order (Tk)' }).fill('1000');
  await dialog.getByRole('textbox', { name: 'Total uses' }).fill('200');
  await dialog.getByRole('checkbox', { name: 'Facebook' }).check();
  await dialog.getByRole('button', { name: 'Create discount' }).click();
  await expect(dialog).toBeHidden();

  const row = page.getByRole('row', { name: new RegExp(code) });
  await expect(row).toContainText('12.5%');
  await expect(row).toContainText('0 / 200');
  await expect(row).toContainText('Active');
  await bothThemes('promo-codes');

  await row.getByRole('button', { name: 'Pause' }).click();
  await expect(page.getByRole('row', { name: new RegExp(code) })).toContainText('Paused');
});

test('templates: the birthday greeting the occasions job needs', async () => {
  await page.goto('/campaigns/templates');
  await page.getByRole('button', { name: 'New template' }).click();
  const dialog = page.getByRole('dialog', { name: 'New template' });
  await dialog.getByRole('textbox', { name: 'Template key' }).fill('occasion.birthday');
  await dialog
    .getByRole('textbox', { name: 'Bangla text' })
    .fill('শুভ জন্মদিন {name}! আপনার কোড {code}');
  await dialog
    .getByRole('textbox', { name: 'English text' })
    .fill('Happy birthday {name}! Your code is {code}');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('row', { name: /occasion\.birthday/ })).toContainText('Offer');
  await bothThemes('templates');
});

test('opt-outs: a number added here is listed', async () => {
  await page.goto('/campaigns/opt-outs');
  const phone = `017${String(10_000_000 + Math.floor(Math.random() * 89_999_999))}`;
  await page.getByRole('textbox', { name: 'Phone' }).fill(phone);
  await page.getByRole('textbox', { name: 'Reason' }).fill('Asked on Messenger');
  await page.getByRole('button', { name: 'Add opt-out' }).click();
  await expect(page.getByRole('row', { name: new RegExp(phone) })).toContainText(
    'Asked on Messenger',
  );
  await bothThemes('opt-outs');

  await page.goto('/campaigns/log');
  await expect(page.getByRole('heading', { name: 'Delivery log' })).toBeVisible();
  await bothThemes('delivery-log');
});

test('lapsed buyers and the profile: the provisioned buyer is found and opened', async () => {
  const { lapsedBuyer } = stack();
  await page.goto('/customers/lapsed?days=90');
  await expect(page.getByRole('heading', { name: 'Lapsed buyers' })).toBeVisible();
  await expect(page.getByTestId('lapsed-count')).toContainText(/Total: \d+/);
  const row = page.getByRole('row', { name: new RegExp(lapsedBuyer.name) });
  await expect(row).toBeVisible();
  await bothThemes('lapsed-buyers');

  // Shorter than the gap, so still listed; longer than it, so gone.
  await page.goto('/customers/lapsed?days=120');
  await expect(page.getByRole('row', { name: new RegExp(lapsedBuyer.name) })).toHaveCount(0);

  await page.goto('/customers/lapsed?days=90');
  await page.getByRole('link', { name: lapsedBuyer.name, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/customers/${lapsedBuyer.id}$`));
  await expect(page.getByRole('heading', { name: lapsedBuyer.name, exact: true })).toBeVisible();
  // 2 × ৳1,200 delivered, one order: the average is the whole.
  await expect(page.getByRole('region', { name: 'Totals' })).toContainText('2,400');
  await expect(page.getByRole('heading', { name: 'Recent orders' })).toBeVisible();
  await bothThemes('buyer-profile');

  // Capture: the occasions job greets on these dates.
  await page.getByRole('button', { name: 'Edit dates' }).click();
  // The kit's date picker since the design refresh (D-459): month and year from its
  // lists, then the day.
  await page.getByLabel('Birthday').click();
  await page.getByRole('combobox', { name: 'Month' }).click();
  await page.getByRole('option', { name: 'Nov', exact: true }).click();
  await page.getByRole('combobox', { name: 'Year' }).click();
  await page.getByRole('option', { name: '1993', exact: true }).click();
  await page.getByRole('button', { name: /14 November 1993/ }).click();
  await page.getByRole('button', { name: 'Save dates' }).click();
  await expect(page.getByRole('button', { name: 'Edit dates' })).toBeVisible();
  await expect(page.getByText('1993-11-14')).toBeVisible();
});
