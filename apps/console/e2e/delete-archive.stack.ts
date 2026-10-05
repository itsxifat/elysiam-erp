import { mkdirSync } from 'node:fs';
import path from 'node:path';

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';

import { enrolSecondFactor, signIn, stack, user } from './stack/helpers.js';

/**
 * Delete and archive everywhere (M39a, D-621 to D-634), against the real stack.
 *
 * One org admin works through the owner's complaint, "we don't have any option to delete
 * categories, size chart and sizes and others": a category made by mistake is deleted; a
 * category with products, a subcategory and a menu entry is emptied into another and deleted;
 * a size with variants is archived with its variants and restored; a list is reordered; a
 * location made by mistake is deleted; a size chart in use offers "Empty and delete"; a used
 * discount is archived and restored paused; a branch shows what still runs there; an expense
 * head is added. Every dialog asks the server what uses the row first. Screenshots go to
 * `docs/review/M39/` as `a-*.png`; axe checks each dialog.
 */

test.describe.configure({ mode: 'serial' });

const REVIEW_DIR = path.resolve(import.meta.dirname, '../../../docs/review/M39');
const RUN = Date.now().toString(36).slice(-4).toUpperCase();
const lower = RUN.toLowerCase();

let page: Page;

async function shot(name: string): Promise<void> {
  mkdirSync(REVIEW_DIR, { recursive: true });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(REVIEW_DIR, `a-${name}.png`), fullPage: true });
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

/** The API, as the signed-in console calls it: the session cookie and the CSRF echo. */
async function api<T>(method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, body?: unknown) {
  const cookies = await page.context().cookies();
  const csrf = cookies.find((cookie) => cookie.name === 'erp_csrf')?.value ?? '';
  const origin = new URL(page.url()).origin;
  const response = await page.request.fetch(`${stack().apiUrl}${url}`, {
    method,
    headers: { 'x-csrf-token': csrf, origin, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { data: JSON.stringify(body) }),
  });
  expect(response.status(), `${method} ${url}: ${await response.text()}`).toBeLessThan(300);
  return (await response.json()) as T;
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

test.beforeAll(async ({ browser }) => {
  page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await signIn(page, user('remover').email);
  await enrolSecondFactor(page);
  await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible();
});

test.afterAll(async () => {
  await page.context().close();
});

test('a category nobody used is deleted for good', async () => {
  await page.goto('/catalog/structure');
  await expect(page.getByRole('heading', { name: 'Catalog setup', level: 1 })).toBeVisible();
  const categories = page.getByRole('region', { name: 'Categories' });
  await categories.getByLabel('Category name').fill(`Mistake ${RUN}`);
  await categories.getByRole('button', { name: 'Add category' }).click();
  const row = categories.getByRole('listitem').filter({ hasText: `Mistake ${RUN}` });
  await expect(row).toBeVisible();

  await row.getByRole('button', { name: `Delete or archive Mistake ${RUN}` }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText(`Nothing uses Mistake ${RUN}`);
  await shot('01-category-unused');
  await noBlockingViolations('delete an unused category');
  await dialog.getByRole('button', { name: 'Delete for good' }).click();
  await expect(dialog).toBeHidden();
  await expect(row).toHaveCount(0);
});

test('a category with products, a subcategory and a menu entry is emptied into another and deleted', async () => {
  const shirts = await api<{ id: string }>('POST', '/v1/catalog/categories', {
    name: `Shirts ${RUN}`,
    slug: `shirts-${lower}`,
    code: `S${RUN}`,
  });
  await api('POST', '/v1/catalog/categories', {
    name: `Formal ${RUN}`,
    slug: `formal-${lower}`,
    code: `F${RUN}`,
    parentId: shirts.id,
  });
  const tops = await api<{ id: string }>('POST', '/v1/catalog/categories', {
    name: `Tops ${RUN}`,
    slug: `tops-${lower}`,
    code: `T${RUN}`,
  });
  const products: string[] = [];
  for (const name of ['Oxford shirt', 'Linen shirt']) {
    const product = await api<{ id: string }>('POST', '/v1/catalog/products', {
      name: `${name} ${RUN}`,
      slug: `${name.toLowerCase().replace(/ /g, '-')}-${lower}`,
      pricePoisha: '150000',
      categoryId: shirts.id,
      status: 'active',
    });
    products.push(product.id);
  }
  await api('POST', '/v1/storefront/nav-items', {
    parentId: null,
    kind: 'category',
    label: null,
    href: null,
    categoryId: shirts.id,
    highlighted: false,
    isActive: true,
  });

  await page.goto('/catalog/structure');
  const categories = page.getByRole('region', { name: 'Categories' });
  await categories.getByRole('button', { name: `Delete or archive Shirts ${RUN}` }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Products');
  await expect(dialog).toContainText('Subcategories');
  await expect(dialog).toContainText('Website menu entries');
  await expect(dialog.getByRole('link', { name: `Oxford shirt ${RUN}` })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Delete for good' })).toHaveCount(0);
  await choose(dialog.getByRole('combobox'), `Tops ${RUN}`);
  await shot('02-category-empty-and-delete');
  await noBlockingViolations('empty and delete a category');
  await dialog.getByRole('button', { name: 'Move and delete' }).click();
  await expect(dialog).toBeHidden();
  await expect(categories.getByRole('listitem').filter({ hasText: `Shirts ${RUN}` })).toHaveCount(
    0,
  );
  // The subcategory moved up; the products are in Tops.
  await expect(categories.getByRole('listitem').filter({ hasText: `Formal ${RUN}` })).toBeVisible();
  for (const id of products) {
    const product = await api<{ categoryId: string }>('GET', `/v1/catalog/products/${id}`);
    expect(product.categoryId).toBe(tops.id);
  }
  await shot('03-category-emptied');
});

test('a size with variants is archived with them, and restored', async () => {
  const size = await api<{ id: string }>('POST', '/v1/catalog/attributes', {
    code: `SZ_${RUN}`,
    name: `Size ${RUN}`,
    kind: 'size',
    isVariant: true,
  });
  const values: Record<string, string> = {};
  for (const [index, label] of ['S', 'M', 'XXL'].entries()) {
    values[label] = (
      await api<{ id: string }>('POST', `/v1/catalog/attributes/${size.id}/values`, {
        code: label,
        label,
        position: index,
      })
    ).id;
  }
  await api('POST', '/v1/catalog/products', {
    name: `Kurta ${RUN}`,
    slug: `kurta-${lower}`,
    pricePoisha: '180000',
    status: 'active',
    axes: [{ attributeId: size.id, valueIds: [values.S, values.XXL] }],
  });

  await page.goto('/catalog/structure');
  const lists = page.getByRole('region', { name: 'Sizes, colours and other lists' });
  const card = lists
    .getByRole('listitem')
    .filter({ hasText: `Size ${RUN}` })
    .first();
  await card.getByRole('button', { name: 'Delete or archive XXL' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Variants');
  await dialog.getByLabel('Also archive its variants (1)').check();
  await shot('04-value-archive');
  await noBlockingViolations('archive a size');
  await dialog.getByRole('button', { name: 'Archive' }).click();
  await expect(dialog).toBeHidden();

  // An unused value is simply deleted.
  await card.getByRole('button', { name: 'Delete or archive M' }).click();
  await expect(dialog).toContainText('Nothing uses M');
  await dialog.getByRole('button', { name: 'Delete for good' }).click();
  await expect(dialog).toBeHidden();
  await expect(card.getByRole('button', { name: /^Rename M/ })).toHaveCount(0);

  await card.getByRole('button', { name: 'Delete or archive XXL' }).click();
  await expect(dialog).toContainText('XXL is archived');
  await shot('05-value-archived');
  await dialog.getByRole('button', { name: 'Restore' }).click();
  await expect(dialog).toBeHidden();
});

test('a list is put in order', async () => {
  const list = await api<{ id: string }>('POST', '/v1/catalog/attributes', {
    code: `ORD_${RUN}`,
    name: `Waist ${RUN}`,
    kind: 'size',
    isVariant: true,
  });
  for (const [index, label] of ['34', '30', '32'].entries()) {
    await api('POST', `/v1/catalog/attributes/${list.id}/values`, {
      code: `W${label}`,
      label,
      position: index,
    });
  }
  await page.goto('/catalog/structure');
  const lists = page.getByRole('region', { name: 'Sizes, colours and other lists' });
  const card = lists
    .getByRole('listitem')
    .filter({ hasText: `Waist ${RUN}` })
    .first();
  await card.getByRole('button', { name: 'Change order' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Move 34 down' }).click();
  await dialog.getByRole('button', { name: 'Move 34 down' }).click();
  await shot('06-value-order');
  await noBlockingViolations('order a list');
  await dialog.getByRole('button', { name: 'Save order' }).click();
  await expect(dialog).toBeHidden();
  const labels = await card.getByRole('button', { name: /^Rename / }).allTextContents();
  expect(labels.map((label) => label.replace(/W\d+$/, '').trim())).toEqual(['30', '32', '34']);
});

test('a stock location made by mistake is deleted; the edit dialog no longer says its code is in product codes', async () => {
  await page.goto('/catalog/structure');
  const locations = page.getByRole('region', { name: 'Stock locations' });
  await locations.getByLabel('Location name').fill(`Typo warehouse ${RUN}`);
  await choose(locations.getByLabel('Kind'), 'Warehouse');
  // The suggested code takes the field's whole 16 characters.
  await expect(locations.getByLabel('Code')).toHaveValue(`TYPOWAREHOUSE${RUN}`.slice(0, 16));
  await locations.getByRole('button', { name: 'Add location' }).click();
  const row = locations.getByRole('listitem').filter({ hasText: `Typo warehouse ${RUN}` });
  await expect(row).toBeVisible();

  await row.getByRole('button', { name: 'Edit' }).click();
  const edit = page.getByRole('dialog');
  await expect(edit).not.toContainText('product codes');
  await expect(edit.getByRole('checkbox')).toHaveCount(0);
  await edit.getByRole('button', { name: 'Cancel' }).click();

  await row.getByRole('button', { name: `Delete or archive Typo warehouse ${RUN}` }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText(`Nothing uses Typo warehouse ${RUN}`);
  await shot('07-location-delete');
  await dialog.getByRole('button', { name: 'Delete for good' }).click();
  await expect(row).toHaveCount(0);
});

test('a size chart in use names its products and offers Empty and delete', async () => {
  const chart = await api<{ id: string }>('POST', '/v1/storefront/size-charts', {
    name: `Panjabi chart ${RUN}`,
    columns: ['Size', 'Chest'],
    rows: [['M', '40']],
  });
  await api('POST', '/v1/storefront/size-charts', {
    name: `New chart ${RUN}`,
    columns: ['Size', 'Chest'],
    rows: [['M', '41']],
  });
  const product = await api<{ id: string }>('POST', '/v1/catalog/products', {
    name: `Charted panjabi ${RUN}`,
    slug: `charted-panjabi-${lower}`,
    pricePoisha: '200000',
  });
  await api('PUT', `/v1/storefront/products/${product.id}`, { sizeChartId: chart.id });

  await page.goto('/website/size-charts');
  const section = page.getByRole('listitem').filter({ hasText: `Panjabi chart ${RUN}` });
  await section.getByRole('button', { name: `Delete: Panjabi chart ${RUN}` }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('link', { name: `Charted panjabi ${RUN}` })).toBeVisible();
  await choose(dialog.getByRole('combobox'), `New chart ${RUN}`);
  await shot('08-size-chart-empty-and-delete');
  await noBlockingViolations('empty and delete a size chart');
  await dialog.getByRole('button', { name: 'Move and delete' }).click();
  await expect(dialog).toBeHidden();
  await expect(section).toHaveCount(0);
});

test('an unused discount offers Delete; an archived one comes back paused', async () => {
  // A discount of this spec's own: the stack's seeded code belongs to the order desk's spec.
  const code = `DEL${RUN}`;
  const created = await api<{ id: string }>('POST', '/v1/promo/codes', {
    code,
    kind: 'percent',
    valueBps: 1000,
  });
  await page.goto('/campaigns');
  const row = page.getByRole('row').filter({ hasText: code });
  await row.getByRole('button', { name: `Archive: ${code}` }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText(`Nothing uses ${code}`);
  await expect(dialog.getByRole('button', { name: 'Delete for good' })).toBeVisible();
  await shot('09-discount-unused');
  await noBlockingViolations('an unused discount');
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  await api('PATCH', `/v1/promo/codes/${created.id}`, { status: 'archived' });
  await page.reload();
  await row.getByRole('button', { name: 'Restore' }).click();
  await expect(dialog).toContainText(`${code} is archived`);
  await shot('10-discount-archived');
  await dialog.getByRole('button', { name: 'Restore' }).click();
  await expect(dialog).toBeHidden();
  await expect(row).toContainText('Paused');
});

test('a branch shows what still runs there before it can be switched off', async () => {
  await page.goto('/branches');
  const row = page.getByRole('row').nth(1);
  await row.getByRole('button', { name: /^Manage / }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('A branch is never deleted');
  await shot('11-branch');
  await noBlockingViolations('manage a branch');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
});

test('an expense head is added on the wallets page', async () => {
  await page.goto('/accounts/wallets');
  const heads = page.getByRole('region', { name: 'Expense and income heads' });
  await heads.getByLabel('Head name').fill(`Electricity ${RUN}`);
  await heads.getByRole('button', { name: 'Add head' }).click();
  const row = heads.getByRole('listitem').filter({ hasText: `Electricity ${RUN}` });
  await expect(row).toBeVisible();
  await expect(heads.getByRole('listitem').filter({ hasText: 'Rent' })).toContainText('Standard');
  await shot('12-heads');
  await noBlockingViolations('expense heads');
  await row.getByRole('button', { name: 'Archive' }).click();
  await expect(row).toContainText('Archived');
});
