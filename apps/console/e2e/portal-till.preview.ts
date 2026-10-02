import { expect, test, type Page } from '@playwright/test';

import {
  accessible,
  enrolSecondFactor,
  login,
  preview,
  snap,
  spaceEnrolment,
} from './preview/helpers.js';

/**
 * The two apps that are not the console (D-387): the investor portal with its tracking
 * page, and the showroom till.
 */

/** The portal opens in Bangla; the language button switches it. */
async function inEnglish(page: Page): Promise<void> {
  if ((await page.locator('html').getAttribute('lang')) === 'en') return;
  await page.getByRole('button', { name: 'ভাষা বদলান' }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
}

test('investor: signs in to the portal, enrols two-step login, sees their money', async ({
  page,
}) => {
  const investor = login('investor');
  await page.goto(preview().urls.portal);
  await inEnglish(page);
  const form = page.locator('form').filter({ has: page.locator('input[type="password"]') });
  await form.locator('input[type="email"]').fill(investor.email);
  await form.locator('input[type="password"]').fill(investor.password);
  await spaceEnrolment(page);
  await form.locator('button[type="submit"]').click();
  await enrolSecondFactor(page);

  await expect(page.getByRole('heading', { level: 1, name: 'Preview Investor' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Your position' })).toBeVisible();
  await expect(page.getByText('Investment agreement (demo)')).toBeVisible();
  await accessible(page, 'investor-portal');
  await snap(page, 'investor-portal');
});

test('a buyer tracks the parcel on its way', async ({ page }) => {
  const tracking = preview().tracking;
  expect(tracking, 'the credentials file names an order to track').not.toBeNull();
  if (tracking === null) return;
  await page.goto(`${preview().urls.portal}/track/elysium-lifestyle-bd`);
  await inEnglish(page);
  await expect(page.getByRole('heading', { name: 'Track your order' })).toBeVisible();
  await page.getByLabel(/^Order number/).fill(tracking.orderNo);
  await page.getByLabel(/^Last 4 digits of the phone/).fill(tracking.digits);
  await page.getByRole('button', { name: 'Track' }).click();
  await expect(page.getByRole('heading', { name: `Order ${tracking.orderNo}` })).toBeVisible();
  await accessible(page, 'order-tracking');
  await snap(page, 'order-tracking');
});

test('branch manager: signs in to the till, opens a shift, rings up by barcode', async ({
  page,
}) => {
  const branch = login('branch');
  await page.goto(preview().urls.pos);
  await expect(page.getByRole('heading', { name: 'Sign in to the till' })).toBeVisible();
  await page.getByLabel('Email').fill(branch.email);
  await page.getByLabel('Password').fill(branch.password);
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page.getByRole('heading', { name: 'Choose this till’s register' })).toBeVisible();
  await page.getByRole('button', { name: /Dhanmondi till 1/ }).click();
  await expect(page.getByRole('heading', { name: 'Open a shift' })).toBeVisible();
  await page.getByLabel(/^Opening cash/).fill('5000');
  await page.getByRole('button', { name: 'Open shift' }).click();
  // The code the testing guide tells the owner to type (D-389).
  const scan = page.getByLabel(/^Scan or type a code/);
  await scan.fill('2000000000102');
  await scan.press('Enter');
  await expect(page.getByText(/Classic Cotton Tee/).first()).toBeVisible();
  await accessible(page, 'till-sale-screen');
  await snap(page, 'till-sale-screen');
});
