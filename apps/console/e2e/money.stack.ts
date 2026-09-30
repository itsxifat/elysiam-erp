import { mkdirSync } from 'node:fs';
import path from 'node:path';

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

import { enrolSecondFactor, signIn, user } from './stack/helpers.js';

/**
 * The money screens against the real stack (M08's follow-up build).
 *
 * One accounts user does a small day's work and reads it back everywhere it should
 * show: records ৳5,000 of other income into the head office till, moves ৳1,000 of it
 * to the bank with a ৳10 bank charge, and then checks both cash books, the P&L, the
 * trial balance, and closing last month. Every figure asserted is what the ledger
 * must say if the transfer posted as §7 describes: the till down by the amount and
 * the charge, the bank up by the amount, and the charge an expense.
 *
 * Nothing here is stubbed. The numbers come from journal lines the real API posted.
 */

test.describe.configure({ mode: 'serial' });

/** Screens for a person to judge, beside M05's set. */
const REVIEW_DIR = path.resolve(import.meta.dirname, '../../../docs/review/M08');

async function shot(name: string): Promise<void> {
  mkdirSync(REVIEW_DIR, { recursive: true });
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(REVIEW_DIR, `${name}.png`) });
}

let page: Page;

test.beforeAll(async ({ browser }) => {
  page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await signIn(page, user('treasurer').email);
  await enrolSecondFactor(page);
  await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible();
});

test.afterAll(async () => {
  await page.context().close();
});

async function noBlockingViolations(label: string): Promise<void> {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const blocking = result.violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .map((violation) => ({ page: label, id: violation.id, help: violation.help }));
  expect(blocking).toEqual([]);
}

/** The value of the statement's closing-balance row, as the page renders it. */
async function closingBalance(): Promise<string> {
  const row = page.getByRole('row', { name: /Closing balance/ });
  await expect(row).toBeVisible();
  return (await row.locator('td').last().innerText()).trim();
}

test('cash in, then a transfer with a bank charge, moves both wallets exactly', async () => {
  await page.goto('/accounts');
  await expect(page.getByRole('heading', { name: 'Accounts', level: 1 })).toBeVisible();

  // ৳5,000 of other income into the head office till, through the existing dialog.
  await page.getByRole('button', { name: 'Record cash' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('combobox', { name: /Wallet/ }).click();
  await page.getByRole('option', { name: /1010-HQ/ }).click();
  await dialog.getByRole('combobox', { name: /Category/ }).click();
  await page.getByRole('option', { name: /4300/ }).click();
  await dialog.getByLabel(/^Amount/).fill('5000');
  await dialog.getByRole('button', { name: 'Record' }).click();
  await expect(dialog).toBeHidden();

  // The transfer screen, from the section's own tabs.
  await page
    .getByRole('navigation', { name: 'Accounts' })
    .getByRole('link', { name: 'Transfers' })
    .click();
  await expect(page.getByRole('heading', { name: 'Transfers', level: 1 })).toBeVisible();
  await noBlockingViolations('transfers');

  const pick = async (label: string, code: string) => {
    const select = page.getByLabel(label);
    const value = await select.locator('option', { hasText: code }).getAttribute('value');
    await select.selectOption(value ?? '');
  };
  await pick('From wallet', '1010-HQ');
  await pick('To wallet', '1100');
  await page.getByLabel(/^Amount/).fill('1000');
  await page.getByLabel(/^Bank charge/).fill('10');
  await page.getByRole('button', { name: 'Transfer', exact: true }).click();

  await expect(page.getByRole('heading', { name: 'Transfer recorded' })).toBeVisible();
  await expect(page.getByText('Posted', { exact: true })).toBeVisible();
  await shot('transfer-recorded');

  // The bank's cash book: up by the amount, and not by the charge.
  await page.getByRole('link', { name: /Open cash book: Bank/ }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('1100');
  expect(await closingBalance()).toBe('৳1,000.00');
  await shot('cash-book-bank');
  await noBlockingViolations('cash book');

  // The till's: 5,000 in, 1,000 out, and the 10 charge out as its own line.
  await page.goto('/accounts');
  await page.getByRole('link', { name: /Open cash book: Hand cash/ }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('1010-HQ');
  expect(await closingBalance()).toBe('৳3,990.00');
});

test('the statements and the trial balance agree with what was posted', async () => {
  await page.goto('/accounts/reports');
  await expect(page.getByRole('heading', { name: 'Statements', level: 1 })).toBeVisible();
  // Income 5,000 less the 10 bank charge; the transfer itself is neither.
  const net = page.getByRole('row', { name: /^Net/ });
  await expect(net).toContainText('৳4,990.00');
  await noBlockingViolations('profit and loss');
  await shot('profit-and-loss');

  await page.getByRole('button', { name: 'Balance sheet' }).click();
  await expect(page.getByText('Balanced', { exact: true })).toBeVisible();
  await shot('balance-sheet');

  await page.goto('/accounts/ledger');
  await expect(page.getByRole('heading', { name: 'Ledger', level: 1 })).toBeVisible();
  await expect(page.getByText('Balanced', { exact: true })).toBeVisible();
  await noBlockingViolations('trial balance');
  await shot('trial-balance');

  await page.getByRole('button', { name: 'Day book' }).click();
  // Two entries today: the cash in and the transfer.
  await expect(page.locator('ol > li')).toHaveCount(2);
  await shot('day-book');
});

test('last month closes, and says so', async () => {
  await page.goto('/accounts/periods');
  await expect(page.getByRole('heading', { name: 'Periods', level: 1 })).toBeVisible();
  await noBlockingViolations('periods');
  await page.getByRole('button', { name: 'Close month' }).click();
  await expect(page.getByRole('status')).toContainText('The month is closed.');
  await expect(page.getByRole('row').filter({ hasText: 'Closed' }).first()).toBeVisible();
  await shot('periods');
});
