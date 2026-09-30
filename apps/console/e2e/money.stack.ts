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
 * to the bank with a ৳10 bank charge, pays a ৳250 fare in cash with the receipt
 * photo attached, and then checks both cash books, the day book, the P&L, the
 * trial balance, and closing last month. Every figure asserted is what the ledger
 * must say if the entries posted as §7 describes: the till down by the transfer,
 * the charge and the fare, the bank up by the amount, and the charge and the fare
 * expenses.
 *
 * The receipt goes through the real upload — ticket, signed PUT, finalize — which
 * is how this spec found the API refusing every cross-origin PUT at the preflight.
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

/**
 * A valid one-pixel PNG. The files module sniffs the bytes at finalize and
 * refuses anything that is not what the ticket declared, so a text file named
 * `.png` would be rejected — correctly — before the entry ever saw it.
 */
const RECEIPT_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

const CASH_OUT_MEMO = 'Rickshaw fare to the courier hub';

test('petty cash without a receipt is stopped before it is sent (M08 check 2)', async () => {
  await page.goto('/accounts');
  await page.getByRole('button', { name: 'Record cash' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();

  await dialog.getByRole('combobox', { name: /Movement/ }).click();
  await page.getByRole('option', { name: 'Petty cash' }).click();
  await dialog.getByRole('combobox', { name: /Wallet/ }).click();
  await page.getByRole('option', { name: /1010-HQ/ }).click();
  await dialog.getByRole('combobox', { name: /Category/ }).click();
  await page.getByRole('option', { name: /5830/ }).click();
  await dialog.getByLabel(/^Amount/).fill('90');

  let sent = false;
  const watch = (request: { url: () => string; method: () => string }) => {
    if (request.method() === 'POST' && request.url().endsWith('/v1/accounts/cash-entries')) {
      sent = true;
    }
  };
  page.on('request', watch);
  await dialog.getByRole('button', { name: 'Record' }).click();
  await expect(dialog.getByRole('alert')).toHaveText(
    'Attach the receipt before recording petty cash.',
  );
  page.off('request', watch);
  expect(sent).toBe(false);

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

test('a cash out with a receipt appears in the day book and the P&L (M08 check 6)', async () => {
  await page.goto('/accounts');
  await page.getByRole('button', { name: 'Record cash' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();

  await dialog.getByRole('combobox', { name: /Movement/ }).click();
  await page.getByRole('option', { name: 'Cash out' }).click();
  await dialog.getByRole('combobox', { name: /Wallet/ }).click();
  await page.getByRole('option', { name: /1010-HQ/ }).click();
  await dialog.getByRole('combobox', { name: /Category/ }).click();
  await page.getByRole('option', { name: /5830/ }).click();
  await dialog.getByLabel(/^Amount/).fill('250');
  await dialog.getByLabel(/^Note/).fill(CASH_OUT_MEMO);

  // Through the real ticket, the signed PUT and finalize. The name alone is not
  // proof — it is also the "uploading" status line — so the wait is for the
  // Remove button, which exists only once the server has sniffed the bytes and
  // stored the file.
  await dialog
    .locator('input[type="file"]')
    .setInputFiles({ name: 'fare-receipt.png', mimeType: 'image/png', buffer: RECEIPT_PNG });
  await expect(dialog.getByRole('button', { name: 'Remove the attachment' })).toBeVisible();
  await expect(dialog.getByText('fare-receipt.png')).toBeVisible();
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  await shot('cash-out-with-receipt');

  // The entry the server accepted carries the receipt, not just the dialog.
  const recorded = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      response.url().endsWith('/v1/accounts/cash-entries'),
  );
  await dialog.getByRole('button', { name: 'Record' }).click();
  const response = await recorded;
  expect(response.ok()).toBe(true);
  expect((response.request().postDataJSON() as { receiptFileId?: string }).receiptFileId).toMatch(
    /^[0-9a-f-]{36}$/,
  );
  await expect(dialog).toBeHidden();

  // Posted, not held: only petty cash goes through maker-checker.
  const entry = page.getByRole('row').filter({ hasText: 'Transport' });
  await expect(entry).toContainText('Cash out');
  await expect(entry).toContainText('Posted');

  // The day book: the entry, the expense debited and the till credited.
  await page.goto('/accounts/ledger');
  await page.getByRole('button', { name: 'Day book' }).click();
  const journal = page.locator('ol > li').filter({ hasText: CASH_OUT_MEMO });
  await expect(journal).toHaveCount(1);
  await expect(journal.getByRole('row').filter({ hasText: '5830' })).toContainText('৳250.00');
  await expect(journal.getByRole('row').filter({ hasText: '1010-HQ' })).toContainText('৳250.00');

  // The P&L: Transport carries it as an expense.
  await page.goto('/accounts/reports');
  await expect(page.getByRole('row').filter({ hasText: '5830' })).toContainText('৳250.00');
});

test('the statements and the trial balance agree with what was posted', async () => {
  await page.goto('/accounts/reports');
  await expect(page.getByRole('heading', { name: 'Statements', level: 1 })).toBeVisible();
  // Income 5,000 less the 10 bank charge and the 250 fare; the transfer itself is
  // neither.
  const net = page.getByRole('row', { name: /^Net/ });
  await expect(net).toContainText('৳4,740.00');
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
  // Three entries today: the cash in, the transfer and the cash out.
  await expect(page.locator('ol > li')).toHaveCount(3);
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

test('a bank wallet is added, then edited, and never asks for the full number', async () => {
  await page.goto('/accounts/wallets');
  await expect(page.getByRole('heading', { name: 'Wallets', level: 1 })).toBeVisible();
  await noBlockingViolations('wallet setup');

  await page.getByRole('button', { name: 'Add wallet' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  // Bank is the default kind, so the provider and last-digit fields are showing.
  await dialog.getByLabel(/^Account code/).fill('1120-DBBL');
  await dialog.getByLabel(/^Name/).fill('Dutch-Bangla current account');
  await dialog.getByLabel(/^Bank or provider/).fill('Dutch-Bangla Bank');

  // A full account number is refused before it leaves the page.
  await dialog.getByLabel(/^Last digits/).fill('1234567890');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog.getByText('Give only the last two to four digits.')).toBeVisible();

  await dialog.getByLabel(/^Last digits/).fill('4821');
  await noBlockingViolations('add wallet');
  await shot('wallet-add');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('status')).toHaveText('Wallet added.');

  const row = page.getByRole('row').filter({ hasText: '1120-DBBL' });
  await expect(row).toContainText('Dutch-Bangla Bank');
  await expect(row).toContainText('4821');
  await expect(row).not.toContainText('1234567890');
  await expect(row).toContainText('In use');

  // Edit: no daily count, and closed. The code and name are not offered.
  await row.getByRole('button', { name: 'Edit: 1120-DBBL' }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel(/^Account code/)).toHaveCount(0);
  await dialog.getByLabel("Count it at every day's close").uncheck();
  await dialog.getByLabel('In use').uncheck();
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('status')).toHaveText('Wallet saved.');
  await expect(row).toContainText('Closed');
  await shot('wallets');
});
