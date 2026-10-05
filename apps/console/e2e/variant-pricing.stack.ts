import { mkdirSync } from 'node:fs';
import path from 'node:path';

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';

import { enrolSecondFactor, signIn, stack, user } from './stack/helpers.js';

/**
 * Variant prices and buying prices (M39b, M39 checks 3 to 6), against the real stack.
 *
 * One org admin sets up a 4-size × 3-colour shirt the way the owner asked for it: prices by
 * size in one step, a buying price per variant on the first delivery (XL costs more), then on
 * the product page reads each variant's average cost, last buying price and margin, raises
 * every price by 10 % with a preview and one save, sets a standard buying price, and
 * duplicates the product, deletes the unused copy (M39a’s dialog) and is offered Archive for the
 * shirt itself. A sales user then opens the same page and sees no cost at all.
 * Screenshots go to `docs/review/M39/b-*.png`.
 */

test.describe.configure({ mode: 'serial' });

const REVIEW_DIR = path.resolve(import.meta.dirname, '../../../docs/review/M39');
const RUN = Date.now().toString(36).slice(-4).toUpperCase();
const PRODUCT = `Oxford Shirt ${RUN}`;
const SIZE_LIST = `Shirt size ${RUN}`;
const COLOUR_LIST = `Shirt colour ${RUN}`;
const SUPPLIER = `Variant Mills ${RUN}`;
const SUPPLIER_CODE = `SUP-VP${RUN}`;
const SIZES = ['S', 'M', 'L', 'XL'] as const;
const COLOURS = ['Red', 'Navy', 'White'] as const;

let page: Page;
let context: BrowserContext;
let productUrl = '';

async function shot(name: string): Promise<void> {
  mkdirSync(REVIEW_DIR, { recursive: true });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(REVIEW_DIR, `${name}.png`), fullPage: true });
}

async function choose(control: Locator, option: string | RegExp): Promise<void> {
  await control.click();
  await page
    .getByRole(
      'option',
      typeof option === 'string' ? { name: option, exact: true } : { name: option },
    )
    .click();
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

/** The session's own API calls, for the setup that is not under test here. */
async function api<T>(method: 'POST' | 'GET', url: string, data?: unknown): Promise<T> {
  const csrf = (await context.cookies()).find((cookie) => cookie.name === 'erp_csrf')?.value ?? '';
  const response = await page.request.fetch(`${stack().apiUrl}${url}`, {
    method,
    headers: {
      'x-csrf-token': csrf,
      origin: `http://localhost:${process.env.E2E_CONSOLE_PORT ?? '5183'}`,
    },
    ...(data === undefined ? {} : { data }),
  });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()) as T;
}

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  page = await context.newPage();
  await signIn(page, user('pricer').email);
  await enrolSecondFactor(page);
  await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible();

  // The lists, a supplier: set up through the API, as Catalog setup's own spec covers them.
  const code = `P${RUN}`;
  const size = await api<{ id: string }>('POST', '/v1/catalog/attributes', {
    code: `SZ_${code}`,
    name: SIZE_LIST,
    kind: 'size',
    isVariant: true,
  });
  for (const [index, value] of SIZES.entries()) {
    await api('POST', `/v1/catalog/attributes/${size.id}/values`, {
      code: value,
      label: value,
      position: index,
    });
  }
  const colour = await api<{ id: string }>('POST', '/v1/catalog/attributes', {
    code: `CL_${code}`,
    name: COLOUR_LIST,
    kind: 'colour',
    isVariant: true,
  });
  for (const [index, value] of COLOURS.entries()) {
    await api('POST', `/v1/catalog/attributes/${colour.id}/values`, {
      code: value.toUpperCase(),
      label: value,
      position: index,
    });
  }
  await api('POST', '/v1/supply/suppliers', { code: SUPPLIER_CODE, name: SUPPLIER });
});

test.afterAll(async () => {
  await context.close();
});

test('check 3: a 4 × 3 shirt priced by size in one step, a buying price per variant', async () => {
  await page.goto('/catalog/new');
  await expect(page.getByRole('heading', { name: 'New product', level: 1 })).toBeVisible();
  await page.getByLabel('Name', { exact: true }).fill(PRODUCT);
  await page.getByLabel('Selling price (৳)').fill('1490');

  const sizes = page.getByRole('group', { name: SIZE_LIST });
  for (const value of SIZES) await sizes.getByRole('button', { name: value, exact: true }).click();
  const colours = page.getByRole('group', { name: COLOUR_LIST });
  for (const value of COLOURS) {
    await colours.getByRole('button', { name: value, exact: true }).click();
  }
  const grid = page.getByRole('table', { name: 'Variants this product will have' });
  await expect(grid.getByRole('row')).toHaveCount(13);

  // Prices by size: L and XL above the rest, every colour at once.
  await page.getByTestId('fill-size-L').fill('1590');
  await page.getByTestId('fill-size-XL').fill('1690');
  await expect(page.getByLabel('Price (৳) XL / Navy')).toHaveAttribute('placeholder', '1690.00');
  await expect(page.getByLabel('Price (৳) M / Red')).toHaveAttribute('placeholder', '1490.00');

  // Two pieces of everything at ৳700 a piece, then XL at ৳800: select all, set, then the XL
  // rows on their own.
  await page.getByRole('checkbox', { name: 'Select every variant' }).check();
  await page.getByTestId('bulk-qty').fill('2');
  await page.getByTestId('bulk-cost').fill('700');
  await page.getByTestId('bulk-apply').click();
  await page.getByRole('button', { name: 'Clear selection' }).click();
  for (const colour of COLOURS) {
    await page.getByLabel(`Cost per piece (৳) XL / ${colour}`).fill('800');
  }
  // A regular price on the red ones, struck through on the website.
  for (const size of SIZES) {
    await page.getByLabel(`Regular ${size} / Red`).fill('1990');
  }

  const stock = page.getByRole('region', { name: 'Stock', exact: true });
  const fromSupplier = stock.getByRole('radio', { name: 'Received from a supplier' });
  if (await fromSupplier.isVisible()) await fromSupplier.check();
  await choose(stock.getByLabel('Supplier', { exact: true }), `${SUPPLIER} (${SUPPLIER_CODE})`);
  // 24 pieces: 18 at ৳700 and 6 at ৳800 = ৳17,400.
  await expect(stock).toContainText('24 pieces');
  await expect(stock).toContainText('৳17,400');

  await noBlockingViolations('new product priced by size');
  await shot('b-01-new-product-by-size');

  await page.getByTestId('create-product').click();
  await expect(page.getByRole('heading', { name: 'Product created', level: 1 })).toBeVisible();
  await page.getByRole('link', { name: 'Open the product' }).click();
  await expect(page.getByRole('heading', { name: PRODUCT, level: 1 })).toBeVisible();
  productUrl = page.url();

  const variants = page.getByRole('table', { name: 'Variants and stock' });
  await expect(variants.getByRole('row')).toHaveCount(13);
  await expect(variants.getByRole('row', { name: /^XL \/ White/ })).toContainText('৳1,690');
  await expect(variants.getByRole('row', { name: /^L \/ Navy/ })).toContainText('৳1,590');
  await expect(variants.getByRole('row', { name: /^S \/ Red/ })).toContainText('৳1,990');
});

test('check 4: the product page shows each variant’s average cost, last buying price and margin', async () => {
  const variants = page.getByRole('table', { name: 'Variants and stock' });
  await expect(variants.getByRole('columnheader', { name: 'Avg. cost' })).toBeVisible();
  // XL at ৳800 against ৳1,690: margin (1690 − 800) / 1690 = 52.7 %.
  const xl = variants.getByRole('row', { name: /^XL \/ Navy/ });
  await expect(xl).toContainText('৳800');
  await expect(xl).toContainText('52.7%');
  // M at ৳700 against ৳1,490: 53.0 %.
  const m = variants.getByRole('row', { name: /^M \/ Red/ });
  await expect(m).toContainText('৳700');
  await expect(m).toContainText('53.0%');
  await expect(page.getByRole('region', { name: 'Stock summary' })).toContainText('৳17,400');

  await noBlockingViolations('product page with costs');
  await shot('b-02-product-wac-margin');
});

test('check 3: everything +10 % previewed, then saved in one request with a history row each', async () => {
  await page.getByTestId('edit-prices').click();
  const bulk = page.getByRole('group', { name: 'Change many prices' });
  await bulk.getByRole('button', { name: 'All', exact: true }).click();
  await choose(bulk.getByLabel('Change'), 'Raise by (%)');
  await page.getByTestId('bulk-amount').fill('10');
  await page.getByTestId('bulk-preview').click();
  await expect(page.getByTestId('bulk-plan')).toContainText('12 prices will change');
  await expect(page.getByLabel('Price (৳) XL / White', { exact: true })).toHaveValue('1859.00');
  await bulk.getByLabel(/Why/).fill('Eid +10%');

  await noBlockingViolations('bulk price preview');
  await shot('b-03-bulk-preview');

  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith('/v1/catalog/prices') && response.request().method() === 'PUT',
  );
  await page.getByTestId('save-prices').click();
  expect((await saved).status()).toBe(200);

  const variants = page.getByRole('table', { name: 'Variants and stock' });
  await expect(variants.getByRole('row', { name: /^XL \/ White/ })).toContainText('৳1,859');
  await expect(variants.getByRole('row', { name: /^S \/ Navy/ })).toContainText('৳1,639');
  const history = page.getByRole('region', { name: 'Price history' });
  await expect(history.getByRole('row').filter({ hasText: 'Eid +10%' })).toHaveCount(12);
  await shot('b-04-after-bulk-history');
});

test('check 5: a standard buying price, kept in supply, fills the next receipt', async () => {
  const buying = page.getByRole('region', { name: 'Buying prices' });
  await buying.getByTestId('standard-M / Navy').fill('720');
  await buying.getByTestId('save-buying-prices').click();
  await expect(buying.getByRole('status')).toContainText('saved');

  await page.getByRole('button', { name: 'Receive stock' }).click();
  const dialog = page.getByRole('dialog', { name: 'Receive stock from a supplier' });
  await choose(dialog.getByLabel('Supplier', { exact: true }), `${SUPPLIER} (${SUPPLIER_CODE})`);
  await expect(dialog.getByLabel('Cost M / Navy')).toHaveValue('720.00');
  // Never bought on its own standard: the last price, ৳800, for XL.
  await expect(dialog.getByLabel('Cost XL / Navy')).toHaveValue('800.00');
  await dialog.getByLabel('Quantity M / Navy').fill('3');
  await expect(dialog.getByTestId('receive-total')).toContainText('৳2,160');
  await shot('b-05-receive-prefilled');
  await dialog.getByRole('button', { name: 'Receive stock' }).click();
  await expect(dialog).toBeHidden();
  const stickers = page.getByRole('dialog', { name: 'Print stickers' });
  await stickers.getByRole('button', { name: 'Close' }).first().click();
});

test('check 6: duplicate makes the same variants and prices, with no stock', async () => {
  await page.goto(productUrl);
  await page.getByTestId('duplicate-product').click();
  const dialog = page.getByRole('dialog', { name: 'Duplicate this product' });
  await dialog.getByLabel('Name of the copy').fill(`${PRODUCT} sand`);
  await dialog.getByTestId('duplicate-submit').click();
  await expect(page.getByRole('heading', { name: `${PRODUCT} sand`, level: 1 })).toBeVisible();

  const variants = page.getByRole('table', { name: 'Variants and stock' });
  await expect(variants.getByRole('row')).toHaveCount(13);
  await expect(variants.getByRole('row', { name: /^XL \/ White/ })).toContainText('৳1,859');
  // No stock came with the copy: each summary tile's figure, read beside its own label.
  const summary = page.getByRole('region', { name: 'Stock summary' });
  const tile = (label: string) =>
    summary.getByText(label, { exact: true }).locator('xpath=following-sibling::p[1]');
  await expect(tile('Available to sell')).toHaveText('0');
  await expect(tile('On hand')).toHaveText('0');
  await expect(tile('Variants')).toHaveText('12');
  await noBlockingViolations('duplicate');
  await shot('b-06-duplicate');
});

test('Delete, through M39a’s dialog: a used product is offered Archive; the unused copy is deleted', async () => {
  // The copy is open: nothing uses it, so it can be deleted for good, and the page leaves.
  const copyUrl = page.url();
  await page.getByTestId('delete-product').click();
  const unused = page.getByRole('dialog', { name: `Delete or archive ${PRODUCT} sand` });
  await expect(unused.getByText(`Nothing uses ${PRODUCT} sand.`)).toBeVisible();
  await noBlockingViolations('delete-unused');
  await shot('b-08-delete-unused');
  await unused.getByRole('button', { name: 'Delete for good' }).click();
  await expect(page).toHaveURL(/\/catalog(\?|$)/);
  await page.goto(copyUrl);
  await expect(page.getByRole('heading', { name: `${PRODUCT} sand`, level: 1 })).toHaveCount(0);

  // The shirt has stock, receipts and price history: no delete, Archive offered instead.
  await page.goto(productUrl);
  await page.getByTestId('delete-product').click();
  const used = page.getByRole('dialog', { name: `Delete or archive ${PRODUCT}` });
  await expect(used.getByRole('region', { name: `${PRODUCT} is used by` })).toBeVisible();
  await expect(used.getByRole('button', { name: 'Delete for good' })).toHaveCount(0);
  await expect(used.getByRole('button', { name: 'Archive' })).toBeVisible();
  await shot('b-09-delete-used');
  await used.getByRole('button', { name: 'Cancel' }).click();
  await expect(used).toBeHidden();

  // The list's "Delete unused" on two ticked rows: the spare goes, the shirt stays.
  const spare = `Spare Tee ${RUN}`;
  await api('POST', '/v1/catalog/products', {
    name: spare,
    slug: `spare-tee-${RUN.toLowerCase()}`,
    pricePoisha: '50000',
  });
  await page.goto(`/catalog?q=${RUN}`);
  await page.getByRole('checkbox', { name: `Select ${spare}` }).click();
  await page.getByRole('checkbox', { name: `Select ${PRODUCT}`, exact: true }).click();
  await page.getByRole('button', { name: 'Delete unused' }).click();
  const confirm = page.getByRole('dialog', { name: 'Delete the unused ones of 2 products?' });
  await confirm.getByRole('button', { name: 'Delete unused' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Deleted 1.' })).toContainText(
    'Kept 1 that are in use',
  );
  await expect(page.getByRole('link', { name: spare })).toHaveCount(0);
  await expect(page.getByRole('link', { name: PRODUCT, exact: true })).toBeVisible();
  await shot('b-10-delete-unused-bulk');
});

test('a role without read:cost sees prices and no cost on the same page', async ({ browser }) => {
  const salesContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const sales = await salesContext.newPage();
  try {
    await signIn(sales, user('desk').email);
    await expect(sales.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible();
    await sales.goto(productUrl);
    await expect(sales.getByRole('heading', { name: PRODUCT, level: 1 })).toBeVisible();
    const variants = sales.getByRole('table', { name: 'Variants and stock' });
    await expect(variants.getByRole('row', { name: /^XL \/ White/ })).toContainText('৳1,859');
    await expect(variants.getByRole('columnheader', { name: 'Avg. cost' })).toHaveCount(0);
    await expect(sales.getByRole('region', { name: 'Buying prices' })).toHaveCount(0);
    await expect(sales.getByText('৳800')).toHaveCount(0);
    await sales.screenshot({
      path: path.join(REVIEW_DIR, 'b-07-no-cost-role.png'),
      fullPage: true,
    });
  } finally {
    await salesContext.close();
  }
});
