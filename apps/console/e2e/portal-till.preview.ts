import { expect, test, type Page } from '@playwright/test';

import {
  accessible,
  enrolSecondFactor,
  login,
  preview,
  previewApiUrl,
  snap,
  spaceEnrolment,
} from './preview/helpers.js';

/**
 * The two apps that are not the console (D-387): the investor portal with its tracking
 * page, and the showroom till.
 */

/** The portal is English only (D-750): no language button, and the page says so. */
async function inEnglish(page: Page): Promise<void> {
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('button', { name: /language/i })).toHaveCount(0);
}

/**
 * A variant's own barcode, read from the catalog in the signed-in person's session, as the
 * owner reads it off the product page or the sticker. Since M38a every SKU is born with an
 * internal EAN-13 (D-603), so the seed's fixed `200000000PPSS` codes (D-389), given only to a
 * SKU with none, are never given: there is no fixed code to type.
 */
async function barcodeOf(page: Page, productName: string, size: string): Promise<string> {
  const api = previewApiUrl();
  const listed = await page.request.get(
    `${api}/v1/catalog/products?q=${encodeURIComponent(productName)}`,
  );
  expect(listed.status(), `the catalog lists ${productName}`).toBe(200);
  const { items } = (await listed.json()) as { items: { id: string; name: string }[] };
  const product = items.find((row) => row.name === productName);
  if (product === undefined) throw new Error(`the catalog has no ${productName}`);

  const read = await page.request.get(`${api}/v1/catalog/products/${product.id}`);
  expect(read.status(), `${productName} opens`).toBe(200);
  const view = (await read.json()) as {
    skus: { barcode: string | null; attributes: { code: string; valueCode: string }[] }[];
  };
  const sku = view.skus.find((row) =>
    row.attributes.some((value) => value.code === 'SIZE' && value.valueCode === size),
  );
  if (sku === undefined) throw new Error(`${productName} has no ${size}`);
  if (sku.barcode === null) throw new Error(`${productName} in ${size} has no barcode`);
  return sku.barcode;
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
  await snap(page, 'investor-portal');
  await accessible(page, 'investor-portal', async () => {
    await expect(page.getByRole('heading', { name: 'Your position' })).toBeVisible();
  });
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
  await snap(page, 'order-tracking');
  // The reload drops the looked-up order; the dark scan covers the tracking form.
  await accessible(page, 'order-tracking', async () => {
    // English, as the page always is (D-750).
    await expect(page.getByRole('heading').first()).toBeVisible();
  });
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
  // The Classic Cotton Tee in M, by the barcode its sticker prints: the brand's own EAN-13,
  // `2` (GS1's in-store prefix) and twelve digits (D-603).
  const barcode = await barcodeOf(page, 'Classic Cotton Tee', 'M');
  expect(barcode).toMatch(/^2\d{12}$/);
  // Scanned once the till holds its price list: the empty basket replaces the skeleton.
  await expect(page.getByText('The basket is empty')).toBeVisible();
  const scan = page.getByLabel(/^Scan or type a code/);
  await scan.fill(barcode);
  await scan.press('Enter');
  await expect(page.getByText(/Classic Cotton Tee/).first()).toBeVisible();
  await snap(page, 'till-sale-screen');
  await accessible(page, 'till-sale-screen', async () => {
    await expect(page.locator('#scan')).toBeVisible();
  });
});
