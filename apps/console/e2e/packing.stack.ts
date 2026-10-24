import { mkdirSync } from 'node:fs';
import path from 'node:path';

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

import { signIn, stack, user } from './stack/helpers.js';

/**
 * M38b against the real stack: a warehouse packer opens an order at the packing station by
 * scanning its slip, scans the pieces (a scanner's burst of keystrokes), and the station refuses
 * the wrong size, the wrong product and one piece too many out loud; scanning the slip again
 * finishes the box and the order is packed. Meanwhile the camera (Chromium's fake camera)
 * records the table with the caption drawn on, the recording uploads as a private packing
 * video, and the order page plays it beside the scan log. Screenshots go to
 * `docs/review/M38b/`.
 */

test.describe.configure({ mode: 'serial' });

// A camera without a person to allow it: Chromium's own test pattern, allowed for this origin.
test.use({
  launchOptions: {
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  },
  permissions: ['camera'],
});

const REVIEW_DIR = path.resolve(import.meta.dirname, '../../../docs/review/M38b');

let page: Page;

async function shot(name: string, fullPage = true): Promise<void> {
  mkdirSync(REVIEW_DIR, { recursive: true });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(REVIEW_DIR, `${name}.png`), fullPage });
}

async function noBlockingViolations(label: string): Promise<void> {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const blocking = result.violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .map((violation) => ({
      page: label,
      id: violation.id,
      help: violation.help,
      targets: violation.nodes.map(
        (node) => `${node.target.join(' ')}: ${node.failureSummary ?? ''}`,
      ),
    }));
  expect(blocking).toEqual([]);
}

/** A USB scanner's burst: one keydown per character and Enter, a few ms apart (D-605). */
async function scan(code: string): Promise<void> {
  await expect(page.getByTestId('scan-listener')).toHaveAttribute('data-listening', 'true');
  await page.evaluate(
    async (keys) => {
      for (const key of keys) {
        document.body.dispatchEvent(
          new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
        );
        await new Promise((resolve) => setTimeout(resolve, 3));
      }
    },
    [...code, 'Enter'],
  );
}

async function answerIs(tone: 'success' | 'danger', text: RegExp): Promise<void> {
  const answer = page.getByTestId('pack-answer');
  await expect(answer).toHaveAttribute('data-tone', tone);
  await expect(answer).toContainText(text);
}

test.beforeAll(async ({ browser }) => {
  page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await signIn(page, user('packer').email);
  await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible();
});

test.afterAll(async () => {
  await page.context().close();
});

test('the station opens the order from its slip and the camera starts recording', async () => {
  // M46 (D-800): the station is Packaging's Packing tab; Orders' Pack tab is gone, and its old
  // address only lands here.
  await page.goto('/packaging?tab=packing');
  await expect(page.getByRole('heading', { name: 'Packaging', level: 1 })).toBeVisible();
  await expect(page.getByTestId('packaging-tab-packing')).toHaveAttribute('aria-current', 'page');
  await noBlockingViolations('packing station');
  await shot('01-station');

  const { packOrder } = stack();
  // The packer types the number on the slip, as when the slip's barcode is torn.
  const find = page.getByRole('textbox', { name: 'Order slip or number' });
  await find.fill(packOrder.orderNo);
  await find.press('Enter');

  await expect(page.getByRole('link', { name: packOrder.orderNo })).toBeVisible();
  await expect(page.getByTestId('pack-lines').getByRole('listitem')).toHaveCount(1);
  await expect(page.getByTestId('pack-progress')).toHaveText('0 of 2 pieces');
  await expect(page).toHaveURL(new RegExp(`order=${packOrder.id}`));
  // Chromium's fake camera, recorded with the caption drawn on.
  await expect(page.getByTestId('pack-recording')).toBeVisible({ timeout: 20_000 });
});

test('a right piece is taken; the wrong size, the wrong product and one too many are refused', async () => {
  const { packSkus } = stack();
  await scan(packSkus.right.barcode);
  await answerIs('success', /Added/);
  await expect(page.getByTestId('pack-progress')).toHaveText('1 of 2 pieces');

  await scan(packSkus.wrongSize.barcode);
  await answerIs('danger', /Wrong size or colour/);
  await shot('02-wrong-size-refused');

  await scan(packSkus.wrongItem.barcode);
  await answerIs('danger', /Not in this order/);

  // The second piece by its SKU code rather than its barcode.
  await scan(packSkus.right.code);
  await answerIs('success', /Every piece is in the box/);
  await expect(page.getByTestId('pack-progress')).toHaveText('2 of 2 pieces');
  await expect(page.getByTestId('pack-lines').getByRole('listitem')).toHaveAttribute(
    'data-state',
    'done',
  );

  await scan(packSkus.right.barcode);
  await answerIs('danger', /One too many/);
  await expect(page.getByTestId('pack-progress')).toHaveText('2 of 2 pieces');
  // Every scan is on the record, refusals included.
  await expect(page.getByTestId('pack-log').getByRole('listitem')).toHaveCount(5);
  await noBlockingViolations('packing an order');
  await shot('03-one-too-many-refused');
});

test('scanning the slip again finishes the box: the order is packed', async () => {
  const { packOrder } = stack();
  await scan(packOrder.orderNo);
  await expect(page.getByTestId('pack-finished')).toBeVisible();
  await expect(page.getByTestId('pack-finished')).toContainText('Packed');
  await expect(page.getByRole('link', { name: 'Print courier label' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Print invoice' })).toBeVisible();
  await shot('04-packed');

  // The recent list: who packed it, the three pieces caught at the table.
  const recent = page.getByTestId('pack-recent');
  const row = recent.getByRole('row').filter({ hasText: packOrder.orderNo });
  await expect(row).toBeVisible();
  await expect(row).toContainText('Packed');
  await expect(row.getByRole('cell').nth(5)).toHaveText('3');
});

test('the video uploads and plays on the order page beside the scan log', async () => {
  const { packOrder } = stack();
  await page.goto(`/orders/${packOrder.id}`);
  const panel = page.getByTestId('packing-panel');
  await expect(panel).toBeVisible();
  // The order went to packed through the state machine.
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Packed');
  await expect
    .poll(
      async () => {
        await page.reload();
        return (await panel.innerText()).includes('Saved');
      },
      { timeout: 60_000, intervals: [1_000, 2_000, 3_000] },
    )
    .toBe(true);
  await expect(page.getByTestId('packing-panel-log').getByRole('listitem')).toHaveCount(5);
  await panel.getByRole('button', { name: 'Play' }).click();
  const video = page.getByTestId('packing-video');
  await expect(video).toBeVisible();
  await expect
    .poll(async () => video.evaluate((element: HTMLVideoElement) => element.readyState), {
      timeout: 20_000,
    })
    .toBeGreaterThan(0);
  expect(await video.getAttribute('src')).toContain('/v1/files/content');
  await noBlockingViolations('order page with the packing video');
  await shot('05-order-page-video');
});

test('the station in the dark theme (WCAG AA in both)', async () => {
  await page.evaluate(() => localStorage.setItem('erp-theme', 'dark'));
  try {
    const { packOrder } = stack();
    await page.goto(`/packaging?tab=packing&order=${packOrder.id}`);
    await expect(page.locator('html')).toHaveClass(/\bdark\b/);
    await expect(page.getByTestId('pack-finished')).toBeVisible();
    await noBlockingViolations('packing station (dark)');
    await shot('06-dark-station');
  } finally {
    await page.evaluate(() => localStorage.removeItem('erp-theme'));
  }
});
