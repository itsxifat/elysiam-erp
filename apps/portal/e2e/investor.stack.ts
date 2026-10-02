import { mkdirSync } from 'node:fs';
import path from 'node:path';

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

import { apiFromPage, enrolSecondFactor, inEnglish, signIn, stack, user } from './stack/helpers.js';

/**
 * M25 acceptance check 1 in a browser: **an investor sees only their own data.**
 *
 * Against the real stack (D-313): a database whose money was posted through the real API,
 * the built API, and the portal. Two investors hold a stake in Elysium Lifestyle BD; one of
 * them, alpha, also holds one in Oura Lifestyle. Each signs in, is walled until they enrol a
 * second factor (§6, §15), and then sees their own position, withdrawals, statement and
 * documents — and, asserted on the page and against the API from inside the same session,
 * none of the other investor's.
 *
 * The other investor's figures are chosen to be unmistakable: beta's ৳5,00,000 of capital,
 * ৳20,000 profit share and ৳7,777 withdrawal never occur among alpha's numbers, and the
 * names, codes and document titles differ, so "not on the page" means "not shown", not
 * "shown in a form the assertion missed".
 *
 * Every screen is checked with axe (no serious or critical violation) in both themes and
 * photographed into `docs/review/M25/`.
 */

test.describe.configure({ mode: 'serial' });

const REVIEW_DIR = path.resolve(import.meta.dirname, '../../../docs/review/M25');

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

async function settled(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle');
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
}

async function bothThemes(page: Page, name: string): Promise<void> {
  await settled(page);
  await noBlockingViolations(page, `${name} (light)`);
  await shot(page, `${name}-light`);
  await page.evaluate(() => localStorage.setItem('elysium-theme', 'dark'));
  await page.reload();
  await settled(page);
  await noBlockingViolations(page, `${name} (dark)`);
  await shot(page, `${name}-dark`);
  await page.evaluate(() => localStorage.setItem('elysium-theme', 'light'));
  await page.reload();
  await settled(page);
}

function tile(page: Page, label: string) {
  return page.locator('dl > div').filter({ has: page.getByText(label, { exact: true }) });
}

function section(page: Page, heading: string) {
  return page.locator('section').filter({ has: page.getByRole('heading', { name: heading }) });
}

async function openBrand(page: Page, name: string): Promise<void> {
  const brands = page.getByRole('navigation', { name: 'Your brands' });
  const button = brands.getByRole('button', { name, exact: true });
  if ((await button.getAttribute('aria-current')) !== 'true') await button.click();
  await expect(brands.getByRole('button', { name, exact: true })).toHaveAttribute(
    'aria-current',
    'true',
  );
  await settled(page);
}

/** Beta's figures and words. None of them may ever be drawn in alpha's session. */
const BETA_ONLY = [
  'Shahidul Islam',
  'INV-B',
  '৳5,00,000.00',
  '৳20,000.00',
  '৳7,777.00',
  'National ID',
];
/** Alpha's. None of them in beta's. */
const ALPHA_ONLY = [
  'Rahima Akhtar',
  'INV-A',
  '৳12,00,000.00',
  '৳12,000.00',
  '৳25,000.00',
  'Investment agreement',
];

async function expectNoneOf(page: Page, words: readonly string[]): Promise<void> {
  const text = await page.locator('body').innerText();
  for (const word of words) expect(text, `"${word}" is on the page`).not.toContain(word);
}

let alpha: Page;

test.afterAll(async () => {
  await alpha?.context().close();
});

test('an investor sees nothing until a second factor is enrolled', async ({ browser }) => {
  alpha = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  await alpha.goto('/');
  // The bare domain is the investor portal, and it opens in Bangla (D-036, D-310).
  await expect(alpha).toHaveURL(/\/investor$/);
  await expect(alpha.locator('html')).toHaveAttribute('lang', 'bn');
  await expect(alpha.getByRole('heading', { name: 'সাইন ইন' })).toBeVisible();
  await settled(alpha);
  await noBlockingViolations(alpha, 'sign-in (bn)');
  await shot(alpha, 'sign-in-bn');

  await inEnglish(alpha);
  expect((await apiFromPage(alpha, '/v1/investors')).status).toBe(401);

  await signIn(alpha, user('alpha').email);
  await expect(alpha.getByRole('heading', { name: 'Set up two-step verification' })).toBeVisible();
  await shot(alpha, 'enrol');

  // Signed in, not enrolled: the session exists, and the API still answers nothing (§6).
  const walled = await apiFromPage(alpha, '/v1/investors');
  expect(walled.status).toBe(403);
  expect(JSON.parse(walled.body)).toMatchObject({ code: 'TWO_FACTOR_ENROLMENT_REQUIRED' });
  await expect(alpha.getByText('Rahima Akhtar')).toHaveCount(0);

  await enrolSecondFactor(alpha);
  await expect(alpha.getByRole('heading', { name: 'Rahima Akhtar' })).toBeVisible();
});

test('alpha sees their own Elysium position and none of beta’s', async () => {
  await openBrand(alpha, 'Elysium Lifestyle BD');
  const { elysium } = stack().brands;

  await expect(alpha.getByText('INV-A', { exact: true })).toBeVisible();
  await expect(tile(alpha, 'Capital held')).toContainText('৳12,00,000.00');
  await expect(tile(alpha, 'Under lock-in')).toContainText('৳2,00,000.00');
  await expect(tile(alpha, 'Withdrawable capital')).toContainText('৳10,00,000.00');
  await expect(tile(alpha, 'Profit declared')).toContainText('৳30,000.00');
  await expect(tile(alpha, 'Profit paid')).toContainText('৳12,000.00');
  await expect(tile(alpha, 'Profit owed')).toContainText('৳18,000.00');

  const distributions = section(alpha, 'Profit distributions');
  await expect(distributions.getByRole('row')).toHaveCount(2);
  await expect(distributions).toContainText('৳30,000.00');

  const withdrawals = section(alpha, 'Withdrawals');
  await expect(withdrawals.getByRole('row')).toHaveCount(3);
  await expect(withdrawals.getByRole('row').filter({ hasText: '৳12,000.00' })).toContainText(
    'Paid',
  );
  await expect(withdrawals.getByRole('row').filter({ hasText: '৳25,000.00' })).toContainText(
    'Requested',
  );
  // No form: the investor role reads and never writes (D-312).
  await expect(withdrawals.getByRole('button')).toHaveCount(0);
  await expect(withdrawals).toContainText('ask the brand’s accounts team');

  await expect(section(alpha, 'Capital contributions').getByRole('row')).toHaveCount(3);
  const statement = section(alpha, 'Statement');
  await expect(statement.getByRole('row')).toHaveCount(5);
  await expect(statement).toContainText('Profit paid');

  const documents = section(alpha, 'Documents');
  await expect(documents.getByRole('row')).toHaveCount(2);
  await expect(documents).toContainText('Investment agreement INV-A');

  await expectNoneOf(alpha, BETA_ONLY);

  // The same session, asking the API directly for beta's rows: answered as though they do
  // not exist, or with nothing — never with beta's data.
  const list = await apiFromPage(alpha, '/v1/investors');
  expect(list.status).toBe(200);
  expect((JSON.parse(list.body) as { items: { id: string }[] }).items.map((row) => row.id)).toEqual(
    [elysium.alpha],
  );
  expect((await apiFromPage(alpha, `/v1/investors/${elysium.beta}`)).status).toBe(404);
  expect(
    (
      await apiFromPage(
        alpha,
        `/v1/investors/${elysium.beta}/statement?from=2000-01-01&to=2099-12-31`,
      )
    ).status,
  ).toBe(404);
  const betaWithdrawals = await apiFromPage(
    alpha,
    `/v1/investors/withdrawals?investorId=${elysium.beta}`,
  );
  expect(betaWithdrawals.status).toBe(200);
  expect(JSON.parse(betaWithdrawals.body)).toEqual({ items: [] });
  const betaDocuments = await apiFromPage(
    alpha,
    `/v1/investors/documents?investorId=${elysium.beta}`,
  );
  expect(JSON.parse(betaDocuments.body)).toEqual({ items: [] });
  expect(
    (await apiFromPage(alpha, `/v1/investors/documents/${stack().documents.beta}/download`)).status,
  ).toBe(404);
  // The org's distribution record lists every investor's line, so an investor cannot read it.
  expect((await apiFromPage(alpha, '/v1/investors/distributions')).status).toBe(403);
  const unfiltered = await apiFromPage(alpha, '/v1/investors/withdrawals');
  expect(unfiltered.body).not.toContain(stack().betaWithdrawal);

  await bothThemes(alpha, 'dashboard-elysium');
});

test('a document opens only through a URL minted for that click', async () => {
  const listed = await apiFromPage(alpha, '/v1/investors/documents');
  // The list carries ids and titles, never a link (§22).
  expect(listed.body).not.toContain('?t=');
  expect(listed.body).not.toContain('"url"');

  const documents = section(alpha, 'Documents');
  const minted = alpha.waitForResponse(
    (response) =>
      response.url().endsWith(`/v1/investors/documents/${stack().documents.alpha}/download`) &&
      response.request().method() === 'GET',
  );
  const opened = alpha.context().waitForEvent('page');
  await documents.getByRole('button', { name: 'Open: Investment agreement INV-A' }).click();
  const response = await minted;
  expect(response.status()).toBe(200);
  const signed = (await response.json()) as { url: string; expiresAt: string };
  expect(signed.url).toContain('?t=');
  expect(new Date(signed.expiresAt).getTime()).toBeGreaterThan(Date.now());
  const tab = await opened;
  await tab.waitForLoadState('domcontentloaded').catch(() => undefined);
  expect(tab.url()).toBe(signed.url);
  await tab.close();
});

test('alpha’s other brand shows only that brand’s stake', async () => {
  await openBrand(alpha, 'Oura');
  await expect(alpha.getByText('INV-O1', { exact: true })).toBeVisible();
  await expect(tile(alpha, 'Capital held')).toContainText('৳3,00,000.00');
  await expect(section(alpha, 'Documents')).toContainText('Investment agreement INV-O1');
  await expect(section(alpha, 'Withdrawals')).toContainText('No withdrawal requests');
  // Elysium's figures belong to Elysium (D-311).
  await expectNoneOf(alpha, ['INV-A', '৳12,00,000.00', '৳25,000.00', ...BETA_ONLY]);
  await shot(alpha, 'dashboard-oura-light');

  // Bangla, as an investor first sees it.
  await alpha.getByRole('button', { name: 'Change language' }).click();
  await expect(alpha.locator('html')).toHaveAttribute('lang', 'bn');
  await settled(alpha);
  await noBlockingViolations(alpha, 'dashboard (bn)');
  await shot(alpha, 'dashboard-oura-bn');
  await inEnglish(alpha);
  await openBrand(alpha, 'Elysium Lifestyle BD');
});

test('beta sees their own figures and none of alpha’s', async ({ browser }) => {
  const beta = await (
    await browser.newContext({ viewport: { width: 390, height: 844 } })
  ).newPage();
  try {
    await beta.goto('/investor');
    await inEnglish(beta);
    await signIn(beta, user('beta').email);
    await enrolSecondFactor(beta);
    await expect(beta.getByRole('heading', { name: 'Shahidul Islam' })).toBeVisible();
    await settled(beta);

    // One brand, so no switcher to offer.
    await expect(beta.getByRole('navigation', { name: 'Your brands' })).toHaveCount(0);
    await expect(tile(beta, 'Capital held')).toContainText('৳5,00,000.00');
    await expect(section(beta, 'Profit distributions')).toContainText('৳20,000.00');
    await expect(section(beta, 'Withdrawals')).toContainText('৳7,777.00');
    await expect(section(beta, 'Documents')).toContainText('National ID INV-B');

    await expectNoneOf(beta, ALPHA_ONLY);
    const { elysium, oura } = stack().brands;
    expect((await apiFromPage(beta, `/v1/investors/${elysium.alpha}`)).status).toBe(404);
    expect((await apiFromPage(beta, `/v1/investors/${oura.alpha}`)).status).toBe(404);
    expect(
      (await apiFromPage(beta, `/v1/investors/documents/${stack().documents.alpha}/download`))
        .status,
    ).toBe(404);

    // A phone, which is where a partner opens it.
    await noBlockingViolations(beta, 'dashboard (phone)');
    await shot(beta, 'dashboard-phone');
  } finally {
    await beta.context().close();
  }
});
