import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';

import { enrolSecondFactor, signIn, user } from './stack/helpers.js';

/**
 * M38a against the real stack: an org admin adds a product with three sizes and the stock
 * already in hand at a cost per piece, prints exactly one sticker per piece on a thermal
 * roll (a real PDF from the real Gotenberg, its pages the sticker's size), then a barcode
 * scanner (fast keystrokes and Enter, as a USB scanner sends them) opens that product at the
 * scanned variant, the stock in hand screen shows the entry, and a second entry counted in by
 * mistake is sent to a second admin to reverse. Screenshots go to `docs/review/M38a/`.
 *
 * The opening stock window is left open: closing it is the brand's one-way decision, covered
 * over HTTP in `stock-in-hand.e2e.test.ts`, and the suites after this one still receive
 * stock into new products.
 */

test.describe.configure({ mode: 'serial' });

const REVIEW_DIR = path.resolve(import.meta.dirname, '../../../docs/review/M38a');
const RUN = Date.now().toString(36).slice(-4).toUpperCase();
const PRODUCT = `Cotton Kurti ${RUN}`;
const FIT = `Fit ${RUN}`;
const VALUES = ['S', 'M', 'L'] as const;
const PIECES = { S: '4', M: '3', L: '2' } as const;
const KIND_OTHER = 'Other';

/**
 * A scanner's burst, as the browser receives it: one keydown per character and Enter, a few
 * milliseconds apart. Dispatched inside the page rather than through Playwright's keyboard,
 * whose round trips on a loaded machine can space keys further apart than any scanner does
 * and turn the test into a timing lottery. `gap` is the pause between keys, in ms.
 */
async function typeKeys(code: string, gap: number): Promise<void> {
  // The scanner's listener is its own chunk, loaded after the shell paints.
  await expect(page.getByTestId('scan-listener')).toHaveAttribute('data-listening', 'true');
  await page.evaluate(
    async ({ keys, pause }) => {
      for (const key of keys) {
        document.body.dispatchEvent(
          new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
        );
        if (pause > 0) await new Promise((resolve) => setTimeout(resolve, pause));
      }
    },
    { keys: [...code, 'Enter'], pause: gap },
  );
}

let page: Page;
let productUrl = '';
let scanned = '';

async function shot(name: string): Promise<void> {
  mkdirSync(REVIEW_DIR, { recursive: true });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(REVIEW_DIR, `${name}.png`), fullPage: true });
}

/** Pick an option from one of the kit's selects: open the list, click the option. */
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

/** Every page's MediaBox in the PDF, in points. */
function mediaBoxes(pdf: Buffer): number[][] {
  return [...pdf.toString('latin1').matchAll(/\/MediaBox\s*\[\s*([-\d.\s]+)\]/g)].map((match) =>
    (match[1] ?? '').trim().split(/\s+/).map(Number),
  );
}

test.beforeAll(async ({ browser }) => {
  page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await signIn(page, user('stocker').email);
  await enrolSecondFactor(page);
  await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible();
});

test.afterAll(async () => {
  await page.context().close();
});

test('a list of sizes to choose from', async () => {
  await page.goto('/catalog/structure');
  const lists = page.getByRole('region', { name: 'Sizes, colours and other lists' });
  await lists.getByLabel('List name').fill(FIT);
  // Kind "Other": a size-kind list's card says "Size", and catalog-stock.stack.ts finds its
  // own Size list by that word, so this suite's list must not answer to it.
  await choose(lists.getByLabel('Kind'), KIND_OTHER);
  await lists.getByRole('button', { name: 'Add list' }).click();
  const card = lists.getByRole('listitem').filter({ hasText: FIT }).first();
  await expect(card).toBeVisible();
  for (const value of VALUES) {
    await card.getByLabel('New value').fill(value);
    await card.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(card.getByRole('button', { name: new RegExp(`^Rename ${value}`) })).toBeVisible();
  }
});

test('a new product with three sizes and the stock in hand at a cost per piece', async () => {
  await page.goto('/catalog/new');
  await expect(page.getByRole('heading', { name: 'New product', level: 1 })).toBeVisible();
  await page.getByLabel('Name', { exact: true }).fill(PRODUCT);
  await page.getByLabel('Selling price (৳)').fill('1890');

  const sizes = page.getByRole('group', { name: FIT });
  for (const value of VALUES) await sizes.getByRole('button', { name: value, exact: true }).click();
  const grid = page.getByRole('table', { name: 'Variants this product will have' });
  await expect(grid.getByRole('row')).toHaveCount(4);
  for (const value of VALUES) await page.getByLabel(`Pieces ${value}`).fill(PIECES[value]);

  const stock = page.getByRole('region', { name: 'Stock', exact: true });
  await expect(stock.getByRole('radio', { name: 'Already in hand (opening stock)' })).toBeChecked();
  await stock.getByLabel('Cost per piece (৳)').fill('850');
  // 9 pieces at ৳850.
  await expect(stock).toContainText('9 pieces');
  await expect(stock).toContainText('৳7,650');

  // The website's details are folded away until wanted.
  await page.getByText('Website details').click();
  await page.getByLabel('Material').fill('Cotton');

  await noBlockingViolations('new product');
  await shot('01-new-product-in-hand');

  await page.getByTestId('create-product').click();
  await expect(page.getByRole('heading', { name: 'Product created', level: 1 })).toBeVisible();
  await expect(page.getByText('Pieces entered: 9')).toBeVisible();
  await noBlockingViolations('product created');
  await shot('02-product-created');
});

test('exactly one sticker per piece, printed as a thermal roll PDF at the sticker’s size', async () => {
  await page.getByTestId('print-new-stickers').click();
  const dialog = page.getByRole('dialog', { name: 'Print stickers' });
  await expect(dialog).toBeVisible();
  await choose(dialog.getByLabel('Print on'), 'Thermal roll, 38 × 25 mm');
  await expect(dialog.getByText('Stickers in all: 9')).toBeVisible();
  for (const value of VALUES) {
    await expect(dialog.getByLabel(`Stickers ${PRODUCT} · ${value}`)).toHaveValue(PIECES[value]);
  }
  await expect(
    dialog.getByRole('checkbox', { name: 'Print the price on the sticker' }),
  ).toBeChecked();
  await noBlockingViolations('stickers dialog');
  await shot('03-stickers-dialog');

  const response = page.waitForResponse(
    (candidate) =>
      candidate.url().endsWith('/v1/catalog/labels') && candidate.request().method() === 'POST',
  );
  // The stickers open in a new tab; the spec reads the PDF from the response instead.
  const popup = page.waitForEvent('popup', { timeout: 15_000 }).catch(() => null);
  await dialog.getByTestId('stickers-print').click();
  const answered = await response;
  await (await popup)?.close();
  expect(answered.ok()).toBe(true);
  expect(answered.headers()['content-type']).toContain('application/pdf');
  const sent = answered.request().postDataJSON() as {
    medium: string;
    showPrice: boolean;
    items: { copies: number }[];
  };
  expect(sent.medium).toBe('thermal-38x25');
  expect(sent.showPrice).toBe(true);
  expect(sent.items.reduce((sum, item) => sum + item.copies, 0)).toBe(9);

  // The PDF as the person gets it: the dialog's Download link.
  const download = page.waitForEvent('download');
  await dialog.getByRole('link', { name: 'Download' }).click();
  const saved = await (await download).path();
  const pdf = readFileSync(saved);
  expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  const boxes = mediaBoxes(pdf);
  expect(boxes).toHaveLength(9);
  for (const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] of boxes) {
    // 38 × 25 mm is 107.7 × 70.9 pt; Chromium stores it on a 1/300-inch grid (D-604).
    expect(Math.abs(x1 - x0 - (38 * 72) / 25.4)).toBeLessThan(1);
    expect(Math.abs(y1 - y0 - (25 * 72) / 25.4)).toBeLessThan(1);
  }
  await dialog.getByRole('button', { name: 'Close' }).first().click();

  await page.getByRole('link', { name: 'Open the product' }).click();
  await expect(page.getByRole('heading', { name: PRODUCT, level: 1 })).toBeVisible();
  productUrl = page.url();
});

test('every variant shows its own EAN-13, and the stock came in as opening stock', async () => {
  const variants = page.getByRole('table', { name: 'Variants and stock' });
  for (const value of VALUES) {
    const row = variants.getByRole('row', { name: new RegExp(`^${value}\\b`) });
    await expect(row).toContainText(/2\d{12}/);
  }
  await expect(page.getByRole('region', { name: 'Stock summary' })).toContainText('9');
  await expect(page.getByRole('region', { name: 'Stock history' })).toContainText('Opening stock');
  await noBlockingViolations('product page');
  await shot('04-product-barcodes');
});

test('a scanner anywhere opens the product at the scanned variant', async () => {
  const variants = page.getByRole('table', { name: 'Variants and stock' });
  const mRow = variants.getByRole('row', { name: /^M\b/ });
  const code = /2\d{12}/.exec((await mRow.textContent()) ?? '')?.[0] ?? '';
  expect(code).toMatch(/^2\d{12}$/);
  scanned = code;

  await page.goto('/stock');
  await expect(page.getByRole('heading', { name: 'Stock', level: 1 })).toBeVisible();
  // Focus on the page itself, not a text box: a scanner types into whatever has focus.
  await page.getByRole('heading', { name: 'Stock', level: 1 }).click();
  await typeKeys(code, 0);

  await expect(page).toHaveURL(new RegExp(`/catalog/[0-9a-f-]+\\?variant=`));
  expect(page.url().split('?')[0]).toBe(productUrl.split('?')[0]);
  const marked = page.locator('tr[data-scanned="true"]');
  await expect(marked).toBeVisible();
  await expect(marked).toContainText(code);
  await shot('05-scan-opened-variant');

  // Typing the same digits slowly is a person, and opens nothing.
  await page.goto('/stock');
  await page.getByRole('heading', { name: 'Stock', level: 1 }).click();
  await typeKeys(code, 120);
  await page.waitForTimeout(500);
  await expect(page).toHaveURL(/\/stock/);
});

test('stock in hand: the window, the entry, and a scan adding a piece', async () => {
  await page.goto('/stock/in-hand');
  await expect(page.getByRole('heading', { name: 'Stock in hand', level: 1 })).toBeVisible();
  await expect(page.getByTestId('window-status')).toContainText('Open');
  const entries = page.getByRole('table', { name: 'Entries' });
  await expect(entries.getByRole('row').filter({ hasText: 'Posted' }).first()).toContainText('9');

  // A scan on the entry form adds the piece as a line; a second scan of it adds one more.
  const scanField = page.getByTestId('scan-field');
  await expect(scanField).toBeFocused();
  await scanField.fill(scanned);
  await scanField.press('Enter');
  const lines = page.getByRole('table', { name: 'Pieces in this entry' });
  await expect(lines.getByRole('row')).toHaveCount(2);
  await expect(lines.getByLabel(new RegExp(`^Pieces ${PRODUCT}`))).toHaveValue('1');
  await scanField.fill(scanned);
  await scanField.press('Enter');
  await expect(lines.getByLabel(new RegExp(`^Pieces ${PRODUCT}`))).toHaveValue('2');
  await noBlockingViolations('stock in hand');
  await shot('06-stock-in-hand');
});

test('a shelf counted in by mistake is sent to a second admin to reverse', async () => {
  // Post the two scanned pieces, at the cost the product came in at.
  await page.locator('#in-hand-cost').fill('850');
  await page.getByTestId('save-in-hand').click();
  const stickers = page.getByRole('dialog', { name: 'Print stickers' });
  await expect(stickers).toBeVisible();
  await stickers.getByRole('button', { name: 'Close' }).first().click();

  const entries = page.getByRole('table', { name: 'Entries' });
  const newest = entries.getByRole('row').nth(1);
  await expect(newest).toContainText('Posted');
  await expect(newest).toContainText('2');
  await newest.getByRole('button', { name: 'Reverse this entry' }).click();

  const dialog = page.getByRole('dialog', { name: 'Reverse this entry?' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Why it is being reversed').fill('These two were counted on shelf A too');
  await noBlockingViolations('reverse entry');
  await shot('07-reverse-entry');
  await dialog.getByRole('button', { name: 'Ask to reverse' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('status').filter({ hasText: 'Sent for approval' })).toBeVisible();
  // Nothing moves until the second admin approves: the entry still reads Posted.
  await expect(newest).toContainText('Posted');
});
