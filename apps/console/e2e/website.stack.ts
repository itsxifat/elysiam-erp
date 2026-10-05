import { createHmac } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';

import { signIn, stack, user } from './stack/helpers.js';

/**
 * The brand's website, run from its ERP (M33 acceptance check 4), against the real stack.
 *
 * The marketing manager does what the old admin panel was for: writes the site's details and
 * the announcement, puts two hero slides up and swaps their order, builds a menu with a
 * dropdown, makes a size chart, issues the website's key, and puts a product on the website
 * from its product page. Every step is read back after a reload — and then read again the way
 * the website reads it, with the key just issued, through the signed storefront API. Review
 * screenshots go to `docs/review/M33/`.
 */

test.describe.configure({ mode: 'serial' });

const REVIEW_DIR = path.resolve(import.meta.dirname, '../../../docs/review/M33');
const RUN = Date.now().toString(36).slice(-4).toUpperCase();
const ANNOUNCEMENT = `Free delivery over 2000 taka ${RUN}`;
const CHART = `Panjabi sizes ${RUN}`;

// A one-pixel PNG: the server re-encodes it into its three sizes.
const IMAGE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

let page: Page;
let issued: { keyId: string; secret: string } | null = null;

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

/** A signed read, exactly as the website's server makes one (`docs/storefront-api.md`). */
async function storefront<T>(pathAndQuery: string): Promise<T> {
  if (issued === null) throw new Error('no website key was issued');
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', issued.secret)
    .update(`${timestamp}.GET.${pathAndQuery}`)
    .digest('hex');
  const response = await fetch(`${stack().apiUrl}${pathAndQuery}`, {
    headers: {
      'x-api-key': issued.keyId,
      'x-api-timestamp': timestamp,
      'x-api-signature': `sha256=${signature}`,
    },
  });
  expect(response.status).toBe(200);
  return (await response.json()) as T;
}

test.beforeAll(async ({ browser }) => {
  page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
  await signIn(page, user('marketing').email);
  await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible();
});

test.afterAll(async () => {
  await page.context().close();
});

test('the Website section opens on its settings, from the sidebar', async () => {
  await page
    .getByRole('navigation', { name: 'Primary navigation' })
    .getByRole('link', { name: 'Website' })
    .click();
  await expect(page).toHaveURL(/\/website\/settings$/);
  await expect(page.getByRole('heading', { name: 'Website', level: 1 })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Website' })).toBeVisible();
});

test('settings save by section and come back after a reload', async () => {
  const site = page.getByRole('region', { name: 'Site information' });
  await site.getByLabel('Site name').fill(`Shop ${RUN}`);
  await site.getByLabel('Phone').fill('01700000000');
  await site.getByRole('button', { name: 'Save' }).click();
  await expect(site.getByRole('status')).toHaveText('Saved');

  const bar = page.getByRole('region', { name: 'Announcement bar' });
  await bar.getByRole('checkbox', { name: 'Show the announcement bar' }).check();
  await bar.getByLabel('Text').fill(ANNOUNCEMENT);
  await bar.getByLabel('Link').fill('/shop');
  await bar.getByRole('button', { name: 'Save' }).click();
  await expect(bar.getByRole('status')).toHaveText('Saved');

  const reviews = page.getByRole('region', { name: 'Testimonials' });
  await reviews.getByRole('button', { name: 'Add a testimonial' }).click();
  await reviews.getByLabel('Name').fill('Rumana');
  await reviews.getByLabel('Where they are from').fill('Dhaka');
  await reviews.getByLabel('What they said').fill('Beautiful stitching.');
  await reviews.getByRole('button', { name: 'Save' }).click();
  await expect(reviews.getByRole('status')).toHaveText('Saved');

  await page.reload();
  await expect(
    page.getByRole('region', { name: 'Site information' }).getByLabel('Site name'),
  ).toHaveValue(`Shop ${RUN}`);
  await expect(
    page.getByRole('region', { name: 'Announcement bar' }).getByLabel('Text'),
  ).toHaveValue(ANNOUNCEMENT);
  await expect(page.getByRole('region', { name: 'Testimonials' }).getByLabel('Name')).toHaveValue(
    'Rumana',
  );
  await shot('website-settings');
  await noBlockingViolations('website settings');
});

test('hero slides are added and reordered, and stay in that order', async () => {
  await page
    .getByRole('navigation', { name: 'Website' })
    .getByRole('link', { name: 'Hero slides' })
    .click();
  await expect(page).toHaveURL(/\/website\/hero$/);

  for (const alt of ['Eid collection', 'Summer linen']) {
    await page.getByRole('button', { name: 'Add a slide' }).click();
    const dialog = page.getByRole('dialog');
    await dialog
      .locator('input[type="file"]')
      .first()
      .setInputFiles({ name: `${alt}.png`, mimeType: 'image/png', buffer: IMAGE });
    await expect(dialog.getByRole('button', { name: 'Save' })).toBeEnabled();
    await dialog.getByLabel('Opens').fill('/shop');
    await dialog.getByLabel('Description for screen readers').fill(alt);
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('listitem').filter({ hasText: alt })).toBeVisible();
  }

  const rows = page.getByRole('listitem').filter({ hasText: /Eid collection|Summer linen/ });
  await expect(rows.first()).toContainText('Eid collection');
  await page.getByRole('button', { name: 'Move up: Summer linen' }).click();
  await expect(rows.first()).toContainText('Summer linen');
  await page.reload();
  await expect(
    page
      .getByRole('listitem')
      .filter({ hasText: /Eid collection|Summer linen/ })
      .first(),
  ).toContainText('Summer linen');
  await shot('website-hero');
  await noBlockingViolations('website hero');
});

test('the menu nests a link inside a dropdown, two levels deep', async () => {
  await page
    .getByRole('navigation', { name: 'Website' })
    .getByRole('link', { name: 'Menu' })
    .click();
  await expect(page).toHaveURL(/\/website\/menu$/);

  const add = async (input: { kind: string; label: string; href?: string; parent?: string }) => {
    await page.getByRole('button', { name: 'Add a menu item' }).click();
    const dialog = page.getByRole('dialog');
    await choose(dialog.getByLabel('Type'), input.kind);
    await dialog.getByLabel('Label').fill(input.label);
    if (input.href !== undefined) await dialog.getByLabel('Link', { exact: true }).fill(input.href);
    if (input.parent !== undefined) await choose(dialog.getByLabel('Inside'), input.parent);
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toBeHidden();
  };
  await add({ kind: 'Link', label: `Sale ${RUN}`, href: '/shop?onSale=true' });
  await add({ kind: 'Dropdown', label: `Help ${RUN}` });
  await add({
    kind: 'Link',
    label: `Size guide ${RUN}`,
    href: '/size-guide',
    parent: `Help ${RUN}`,
  });

  await page.reload();
  const help = page
    .getByRole('listitem')
    .filter({ hasText: `Help ${RUN}` })
    .first();
  await expect(help.getByRole('list').getByText(`Size guide ${RUN}`)).toBeVisible();
  await shot('website-menu');
  await noBlockingViolations('website menu');
});

test('a size chart is written in its grid and read back', async () => {
  await page
    .getByRole('navigation', { name: 'Website' })
    .getByRole('link', { name: 'Size charts' })
    .click();
  await page.getByRole('button', { name: 'New size chart' }).click();
  const editor = page.getByRole('region', { name: 'Size chart' });
  await editor.getByLabel('Name').fill(CHART);
  await editor.getByLabel('Cell 1, Size').fill('M');
  await editor.getByLabel('Cell 1, Chest (cm)').fill('40');
  await editor.getByLabel('Cell 1, Waist (cm)').fill('34');
  await editor.getByLabel('Cell 1, Length (cm)').fill('42');
  await editor.getByRole('button', { name: 'Add a row' }).click();
  await editor.getByLabel('Cell 2, Size').fill('L');
  await editor.getByLabel('Cell 2, Chest (cm)').fill('42');
  await editor.getByLabel('Cell 2, Waist (cm)').fill('36');
  await editor.getByLabel('Cell 2, Length (cm)').fill('43');
  await editor.getByRole('button', { name: 'Save' }).click();
  await expect(editor).toBeHidden();

  await page.reload();
  const chart = page.getByRole('region', { name: CHART });
  await expect(chart.getByRole('cell', { name: '42', exact: true }).first()).toBeVisible();
  await expect(chart.getByRole('row')).toHaveCount(3);
  await shot('website-size-charts');
  await noBlockingViolations('website size charts');
});

test('the website key is issued once, and the website reads what was saved', async () => {
  await page
    .getByRole('navigation', { name: 'Website' })
    .getByRole('link', { name: 'Connection' })
    .click();
  await page.getByRole('button', { name: 'Issue a key' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Label').fill(`Website ${RUN}`);
  await dialog.getByRole('button', { name: 'Issue a key' }).click();
  await expect(dialog.getByRole('heading', { name: 'Copy the secret now' })).toBeVisible();
  const keyId = (await dialog.locator('dd').first().textContent())?.trim() ?? '';
  const secret = (await dialog.locator('code').textContent())?.trim() ?? '';
  expect(keyId).toMatch(/^pk_/);
  expect(secret).toMatch(/^sk_/);
  issued = { keyId, secret };
  await shot('website-connection-secret');
  await dialog.getByRole('button', { name: 'Close' }).first().click();
  await expect(page.getByRole('cell', { name: keyId })).toBeVisible();
  // Listed without its secret: the page holds no copy of it any more.
  await expect(page.getByText(secret)).toHaveCount(0);
  await shot('website-connection');

  const site = await storefront<{
    site: { name: string };
    announcement: { enabled: boolean; text: string };
    hero: { alt: string | null }[];
    menu: { label: string; children: { label: string }[] }[];
    testimonials: { name: string }[];
  }>('/storefront/v1/site');
  expect(site.site.name).toBe(`Shop ${RUN}`);
  expect(site.announcement).toMatchObject({ enabled: true, text: ANNOUNCEMENT });
  expect(site.hero.map((slide) => slide.alt).slice(0, 2)).toEqual([
    'Summer linen',
    'Eid collection',
  ]);
  const help = site.menu.find((entry) => entry.label === `Help ${RUN}`);
  expect(help?.children.map((child) => child.label)).toEqual([`Size guide ${RUN}`]);
  expect(site.testimonials.map((entry) => entry.name)).toContain('Rumana');
});

test('a product goes on the website from its Website card', async () => {
  await page.goto('/catalog');
  await page.getByRole('row').nth(1).getByRole('link').first().click();
  const card = page.getByRole('region', { name: 'Website' });
  await expect(card).toBeVisible();
  await card.getByRole('checkbox', { name: 'Show on the website' }).check();
  await card.getByRole('checkbox', { name: 'Featured' }).check();
  await card.getByLabel('Tags').fill('eid, cotton');
  await choose(card.getByLabel('Size chart'), CHART);
  await card.getByLabel('Material').fill('Cotton');
  await card.getByRole('button', { name: 'Save' }).click();
  await expect(card.getByRole('status')).toHaveText('Saved');

  await page.reload();
  const again = page.getByRole('region', { name: 'Website' });
  await expect(again.getByRole('checkbox', { name: 'Show on the website' })).toBeChecked();
  await expect(again.getByLabel('Tags')).toHaveValue('eid, cotton');
  await expect(again.getByLabel('Material')).toHaveValue('Cotton');
  await shot('product-website-card');

  const productId = page.url().split('/').at(-1) ?? '';
  const list = await storefront<{ items: { id: string; tags: string[] }[] }>(
    '/storefront/v1/catalog/products?featured=true&limit=60',
  );
  expect(list.items.find((item) => item.id === productId)?.tags).toEqual(['eid', 'cotton']);
});
