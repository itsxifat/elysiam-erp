import { mkdirSync } from 'node:fs';
import path from 'node:path';

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';

import { enrolSecondFactor, signIn, user } from './stack/helpers.js';

/**
 * Catalog and stock made easy (plan `catalog-stock-ux`), against the real stack.
 *
 * One org admin walks the owner's whole day: set up the size and colour lists, a
 * category and a showroom; add a supplier; create a product with sizes, colours, a
 * price for one variant and opening stock; then, from the product page, write off a
 * damaged piece (sent for approval), transfer stock to the showroom and receive it
 * there, receive a second delivery, and read it all back on the Stock page. Screenshots
 * go to `docs/review/catalog-stock/`.
 */

test.describe.configure({ mode: 'serial' });

const REVIEW_DIR = path.resolve(import.meta.dirname, '../../../docs/review/catalog-stock');
const RUN = Date.now().toString(36).slice(-4).toUpperCase();
const PRODUCT = `Linen Panjabi ${RUN}`;
const CATEGORY = `Panjabi ${RUN}`;
const SUPPLIER = 'Demo Stitching House';
const SUPPLIER_CODE = `SUP-${RUN}`;
const SHOWROOM = `Gulshan Showroom ${RUN}`;

let page: Page;

async function shot(name: string): Promise<void> {
  mkdirSync(REVIEW_DIR, { recursive: true });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(REVIEW_DIR, `${name}.png`), fullPage: true });
}

/**
 * Pick an option from one of the kit's selects (D-443): open the list, then click the
 * option by its visible name. The list renders in a portal, so the option is looked up on
 * the page, not inside the control's region or dialog. A screen still on a native
 * `<select>` is answered the native way, so the spec holds while screens move over.
 */
async function choose(control: Locator, option: string | RegExp): Promise<void> {
  if ((await control.evaluate((element) => element.tagName)) === 'SELECT') {
    if (typeof option === 'string') {
      await control.selectOption({ label: option });
      return;
    }
    const value = await control
      .locator('option', { hasText: option })
      .first()
      .getAttribute('value');
    await control.selectOption(value ?? '');
    return;
  }
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

test.beforeAll(async ({ browser }) => {
  page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await signIn(page, user('merchandiser').email);
  await enrolSecondFactor(page);
  await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible();
});

test.afterAll(async () => {
  await page.context().close();
});

test('catalog setup: sizes, colours, a category and a showroom, linked from Catalog', async () => {
  await page.goto('/catalog');
  await page.getByRole('link', { name: 'Categories, sizes and colours' }).click();
  await expect(page.getByRole('heading', { name: 'Catalog setup', level: 1 })).toBeVisible();

  const lists = page.getByRole('region', { name: 'Sizes, colours and other lists' });
  const addList = async (name: string, kind: 'size' | 'colour', values: readonly string[]) => {
    await lists.getByLabel('List name').fill(name);
    await choose(lists.getByLabel('Kind'), kind === 'size' ? 'Size' : 'Colour');
    await lists.getByRole('button', { name: 'Add list' }).click();
    const card = lists.getByRole('listitem').filter({ hasText: name }).first();
    await expect(card).toBeVisible();
    for (const value of values) {
      await card.getByLabel('New value').fill(value);
      await card.getByRole('button', { name: 'Add', exact: true }).click();
      await expect(
        card.getByRole('button', { name: new RegExp(`^Rename ${value}`) }),
      ).toBeVisible();
    }
  };
  await addList('Size', 'size', ['M', 'L']);
  await addList('Colour', 'colour', ['Red', 'Blue']);

  // A typo fixed in place: the label changes, the code stays.
  const colours = lists.getByRole('listitem').filter({ hasText: 'Colour' }).first();
  await colours.getByRole('button', { name: /^Rename Blue/ }).click();
  const rename = page.getByRole('dialog');
  await rename.getByLabel('Name').fill('Navy Blue');
  await rename.getByRole('button', { name: 'Save' }).click();
  await expect(rename).toBeHidden();
  await expect(colours.getByRole('button', { name: /^Rename Navy Blue/ })).toBeVisible();

  const categories = page.getByRole('region', { name: 'Categories' });
  await categories.getByLabel('Category name').fill(CATEGORY);
  await categories.getByRole('button', { name: 'Add category' }).click();
  await expect(categories.getByRole('listitem').filter({ hasText: CATEGORY })).toBeVisible();

  const locations = page.getByRole('region', { name: 'Stock locations' });
  await locations.getByLabel('Location name').fill(SHOWROOM);
  await choose(locations.getByLabel('Kind'), 'Showroom');
  await locations.getByRole('button', { name: 'Add location' }).click();
  await expect(locations.getByRole('listitem').filter({ hasText: SHOWROOM })).toBeVisible();

  await noBlockingViolations('catalog setup');
  await shot('01-catalog-setup');
});

test('a supplier to receive from', async () => {
  await page.goto('/supply');
  await page.getByLabel('Code', { exact: true }).fill(SUPPLIER_CODE);
  await page.getByLabel('Name', { exact: true }).fill(SUPPLIER);
  await page.getByRole('button', { name: 'New supplier' }).click();
  await expect(page.getByRole('cell', { name: SUPPLIER_CODE })).toBeVisible();
});

test('new product: sizes and colours as chips, a variant price and opening stock, one button', async () => {
  await page.goto('/catalog');
  await page.getByRole('link', { name: 'New product' }).click();
  await expect(page.getByRole('heading', { name: 'New product', level: 1 })).toBeVisible();

  await page.getByLabel('Name', { exact: true }).fill(PRODUCT);
  await choose(page.getByLabel('Category', { exact: true }), CATEGORY);
  await page.getByLabel('Selling price (৳)').fill('2450');

  const size = page.getByRole('group', { name: 'Size' });
  await size.getByRole('button', { name: 'M', exact: true }).click();
  await size.getByRole('button', { name: 'L', exact: true }).click();
  const colour = page.getByRole('group', { name: 'Colour' });
  await colour.getByRole('button', { name: 'Red', exact: true }).click();
  await colour.getByRole('button', { name: 'Navy Blue', exact: true }).click();

  const grid = page.getByRole('table', { name: 'Variants this product will have' });
  await expect(grid.getByRole('row')).toHaveCount(5);
  await page.getByLabel('Price (৳) L / Navy Blue').fill('2550');
  await page.getByLabel('Opening stock M / Red').fill('10');
  await page.getByLabel('Opening stock L / Navy Blue').fill('5');

  const opening = page.getByRole('region', { name: 'Opening stock' });
  await choose(opening.getByLabel('Supplier'), `${SUPPLIER} (${SUPPLIER_CODE})`);
  await opening.getByLabel('Cost per piece (৳)').fill('1200');
  await expect(opening).toContainText('15 pieces');

  await noBlockingViolations('new product');
  await shot('02-new-product');

  await page.getByRole('button', { name: 'Create product' }).click();
  await expect(page.getByRole('heading', { name: PRODUCT, level: 1 })).toBeVisible();

  const variants = page.getByRole('table', { name: 'Variants and stock' });
  await expect(variants.getByRole('row')).toHaveCount(5);
  await expect(variants.getByRole('row', { name: /M \/ Red/ })).toContainText('10');
  await expect(variants.getByRole('row', { name: /L \/ Navy Blue/ })).toContainText('৳2,550');
  await expect(variants.getByRole('row', { name: /L \/ Navy Blue/ })).toContainText('5');
  await expect(page.getByRole('region', { name: 'Stock summary' })).toContainText('15');
  await expect(page.getByRole('region', { name: 'Stock history' })).toContainText(
    'Received from supplier',
  );

  await noBlockingViolations('product page');
  await shot('03-product-hub');
});

test('adjust from the product page: a damaged piece goes for approval', async () => {
  await page.getByRole('button', { name: 'Adjust', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Adjust stock' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Damaged' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await dialog.getByLabel('Quantity M / Red').fill('1');
  await dialog.getByLabel('Add a note (optional)').fill('Torn seam');
  await shot('04-adjust');
  await dialog.getByRole('button', { name: 'Send for approval' }).click();
  await expect(dialog.getByRole('status')).toContainText('Sent for approval');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();

  // Nothing moved yet: the stock changes only once someone else approves it.
  const variants = page.getByRole('table', { name: 'Variants and stock' });
  await expect(variants.getByRole('row', { name: /M \/ Red/ })).toContainText('10');
});

test('transfer to the showroom, then receive it there', async () => {
  await page.getByRole('button', { name: 'Transfer', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Transfer stock' });
  await expect(dialog).toBeVisible();
  await choose(dialog.getByLabel('To', { exact: true }), SHOWROOM);
  await dialog.getByLabel('Quantity M / Red').fill('3');
  await shot('05-transfer');
  await dialog.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('Sent');
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  await page.goto('/stock/transfers');
  await expect(page.getByRole('heading', { name: 'Transfers', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Receive' }).first().click();
  await expect(page.getByRole('button', { name: 'Receive' })).toHaveCount(0);
  await shot('06-transfer-received');
});

test('receive a second delivery from the product page', async () => {
  await page.goto('/catalog');
  await page.getByLabel('Search products or SKU codes').fill(PRODUCT.slice(0, 12));
  await page.getByRole('link', { name: PRODUCT }).click();
  await expect(page.getByRole('heading', { name: PRODUCT, level: 1 })).toBeVisible();

  await page.getByRole('button', { name: 'Receive stock' }).click();
  const dialog = page.getByRole('dialog', { name: 'Receive stock from a supplier' });
  await choose(dialog.getByLabel('Supplier'), `${SUPPLIER} (${SUPPLIER_CODE})`);
  await dialog.getByLabel('Cost per piece (৳)').fill('1180.50');
  await dialog.getByLabel('Quantity M / Navy Blue').fill('4');
  await expect(dialog).toContainText('৳4,722');
  await shot('07-receive');
  await dialog.getByRole('button', { name: 'Receive stock' }).click();
  await expect(dialog.getByRole('status')).toContainText('Received');
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  const variants = page.getByRole('table', { name: 'Variants and stock' });
  const mRed = variants.getByRole('row', { name: /M \/ Red/ });
  // 10 received, 3 sent to the showroom: 7 in the warehouse, 3 in the showroom.
  await expect(mRed).toContainText('7');
  await expect(mRed).toContainText('3');
  await expect(variants.getByRole('row', { name: /M \/ Navy Blue/ })).toContainText('4');
  await expect(page.getByRole('region', { name: 'Stock history' })).toContainText('Transferred in');

  // A low-stock alert at the warehouse: 7 available against an alert at 8 shows Low.
  await page.getByRole('button', { name: 'Low-stock alerts' }).click();
  const alerts = page.getByRole('dialog', { name: 'Low-stock alerts' });
  await choose(alerts.getByLabel('Location'), /Main Warehouse/);
  await alerts.getByLabel('Alert at M / Red').fill('8');
  await alerts.getByRole('button', { name: 'Save' }).click();
  await expect(alerts.getByRole('status')).toContainText('Saved');
  await alerts.getByRole('button', { name: 'Cancel' }).click();
  await expect(mRed).toContainText('Low');
  await shot('08-product-hub-after');
});

test('the Stock page: by category, linked to the product, with quick actions', async () => {
  await page.goto('/stock');
  await expect(page.getByRole('link', { name: 'Receive stock' })).toBeVisible();
  await choose(page.getByLabel('All categories'), CATEGORY);
  const table = page.getByRole('table');
  await expect(table.getByRole('link', { name: PRODUCT }).first()).toBeVisible();
  await expect(table.getByRole('row', { name: new RegExp(SHOWROOM) })).toContainText('M / Red');
  await noBlockingViolations('stock');
  await shot('09-stock');

  await page.goto('/catalog/import');
  await expect(page.getByRole('tab', { name: 'New products' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByRole('link', { name: 'Download the template' })).toBeVisible();
  await noBlockingViolations('import');
  await shot('10-import');
});
