import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { STUB_API } from '../playwright.config.js';

/**
 * The till, offline (M23 acceptance checks 1, 2 and 4, the browser's half).
 *
 * The browser is taken **genuinely offline** — `context.setOffline(true)`, the
 * same switch as pulling the cable — so nothing here is a mocked `navigator.onLine`
 * or an intercepted route. Three sales are rung up with no connection, survive a
 * reload with no connection, and reach the server exactly once each after it comes
 * back — including the case the idempotency key exists for, where the first
 * delivery arrives and its reply is lost.
 *
 * The server here is `stub-api.mjs`, which implements the sync *contract*. That
 * stock levels and wallet ledger balances are right on the real server, against a
 * real PostgreSQL, is `apps/server/src/modules/pos/pos.db.test.ts`.
 */

interface StubState {
  readonly deliveries: string[][];
  readonly applied: { document: { id: string; receiptNo: string; tenders: { tender: string; amountPoisha: string }[] }; outcome: string }[];
  readonly stock: Record<string, number>;
  readonly wallets: { cash: string; bkash: string; card: string };
  readonly csrfRefusals: number;
  readonly requests: string[];
}

const SHIRT = 'a1b2c3d4-0000-4000-8000-00000000000a';
const SCARF = 'a1b2c3d4-0000-4000-8000-00000000000b';

async function stubState(request: APIRequestContext): Promise<StubState> {
  return (await (await request.get(`${STUB_API}/__test/state`)).json()) as StubState;
}

/** From a cold start to the sale screen: pick the register, open a shift. */
async function openTill(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: /Gulshan till 1/ }).click();
  await page.getByLabel('Opening cash').fill('5000');
  await page.getByRole('button', { name: 'Open shift' }).click();
  await expect(page.getByRole('textbox', { name: 'Scan or type a code' })).toBeVisible();
  // The price list is on the till before the connection goes.
  await scan(page, 'ELY-SHRT-0001');
  await expect(page.getByTestId('cart')).toContainText('Oxford shirt');
  await page.getByRole('button', { name: 'Clear basket' }).click();
}

async function scan(page: Page, code: string): Promise<void> {
  const field = page.getByRole('textbox', { name: 'Scan or type a code' });
  await field.fill(code);
  await field.press('Enter');
}

async function completeSale(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Complete sale' }).click();
  await expect(page.getByRole('dialog').getByTestId('receipt-no')).toBeVisible();
}

test.beforeEach(async ({ request }) => {
  await request.post(`${STUB_API}/__test/reset`);
});

test('three sales made offline survive a reload and sync exactly once after reconnecting', async ({
  page,
  context,
  request,
}) => {
  await openTill(page);

  // The offline shell: the worker controls the page and holds its files.
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await expect
    .poll(async () => page.evaluate(async () => (await caches.keys()).length))
    .toBeGreaterThan(0);
  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const cache = await caches.open('elysium-pos-shell-v1');
        return (await cache.keys()).some((entry) => entry.url.includes('/assets/'));
      }),
    )
    .toBe(true);

  await context.setOffline(true);
  await expect(page.getByTestId('connection')).toHaveAttribute('data-online', 'false');

  // 1. One shirt, cash: a ৳2,000 note against ৳1,500.
  await scan(page, 'ELY-SHRT-0001');
  await page.keyboard.press('F2');
  await page.getByLabel('Cash handed over').fill('2000');
  await expect(page.getByTestId('pay-change')).toHaveText('৳500.00');
  await completeSale(page);
  await expect(page.getByRole('dialog').getByTestId('receipt-no')).toHaveText('GUL1-1-0001');
  await page.getByRole('button', { name: 'New sale' }).click();

  // 2. A shirt with ৳100 off and a scarf, split across cash and bKash.
  await scan(page, '8941234567890'); // the shirt, by its barcode
  await scan(page, 'ely-scrf-0002');
  await page.getByRole('button', { name: 'Discount this line: Oxford shirt' }).click();
  await page.getByLabel('Amount (taka)').fill('100');
  await page.getByRole('button', { name: 'Apply discount' }).click();
  await expect(page.getByTestId('cart-total')).toHaveText('৳1,850.50');
  await page.keyboard.press('F2');
  await page.getByLabel('Cash', { exact: true }).fill('1000.50');
  await page.getByLabel('bKash', { exact: true }).fill('850');
  await completeSale(page);
  await page.getByRole('button', { name: 'New sale' }).click();

  // 3. Two shirts, by card.
  await scan(page, 'ELY-SHRT-0001');
  await scan(page, 'ELY-SHRT-0001');
  await page.keyboard.press('F2');
  await page.getByRole('button', { name: 'All card' }).click();
  await completeSale(page);
  await page.getByRole('button', { name: 'New sale' }).click();

  await expect(page.getByTestId('waiting')).toHaveAttribute('data-count', '3');
  expect((await stubState(request)).deliveries, 'nothing reached the server while offline').toEqual([]);

  // The tablet restarts with no connection: the shell loads from the worker's
  // cache, and the three sales are still in IndexedDB.
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Scan or type a code' })).toBeVisible();
  await expect(page.getByTestId('waiting')).toHaveAttribute('data-count', '3');

  // The browser was closed overnight: the session survives, the CSRF token does not.
  await context.clearCookies({ name: 'elysium_csrf' });
  // And the first delivery will arrive but lose its reply.
  await request.post(`${STUB_API}/__test/drop-next-sync-reply`);

  await context.setOffline(false);
  await expect
    .poll(async () => (await stubState(request)).deliveries.length, { timeout: 30_000 })
    .toBeGreaterThanOrEqual(1);
  // The reply was lost, so the till still holds all three — and must send them again.
  await page.getByRole('button', { name: 'Sync now' }).click();
  await expect(page.getByTestId('waiting')).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByTestId('failed')).toHaveCount(0);

  const after = await stubState(request);
  // Delivered at least twice (the lost reply forced a re-send)…
  expect(after.deliveries.length).toBeGreaterThanOrEqual(2);
  expect(after.deliveries[0]).toHaveLength(3);
  expect(after.deliveries[1]).toEqual(after.deliveries[0]);
  // …and applied exactly once each, in the order they were rung up.
  expect(after.applied.map((entry) => [entry.document.receiptNo, entry.outcome])).toEqual([
    ['GUL1-1-0001', 'posted'],
    ['GUL1-1-0002', 'posted'],
    ['GUL1-1-0003', 'posted'],
  ]);
  expect(new Set(after.applied.map((entry) => entry.document.id)).size).toBe(3);
  // Stock and wallets, as the three sales — once each — leave them.
  expect(after.stock[SHIRT]).toBe(10 - 4);
  expect(after.stock[SCARF]).toBe(10 - 1);
  expect(after.wallets).toEqual({ cash: '250050', bkash: '85000', card: '300000' });
  // The replay fetched a fresh CSRF token first, and no mutation was refused for want of one.
  expect(after.csrfRefusals).toBe(0);
  const firstSync = after.requests.indexOf('POST /v1/pos/sync');
  expect(after.requests.slice(0, firstSync)).toContain('GET /v1/me');

  await page.getByRole('button', { name: 'Queue' }).click();
  await expect(page.getByTestId('queue').locator('tr[data-status="synced"]')).toHaveCount(3);
  await expect(page.getByTestId('queue')).toContainText('Posted');
});

test('a sale the shelf cannot give is held for review, not lost and not retried forever', async ({
  page,
  request,
}) => {
  await openTill(page);
  await scan(page, 'ELY-BELT-0003'); // the server has none
  await page.keyboard.press('F2');
  await completeSale(page);
  await page.getByRole('button', { name: 'New sale' }).click();

  await expect(page.getByTestId('waiting')).toHaveCount(0, { timeout: 30_000 });
  await page.getByRole('button', { name: 'Queue' }).click();
  await expect(page.getByTestId('queue')).toContainText('Held for review');

  const state = await stubState(request);
  expect(state.applied.map((entry) => entry.outcome)).toEqual(['held']);
  expect(state.wallets).toEqual({ cash: '0', bkash: '0', card: '0' });
});

test('a receipt prints through the print stylesheet: 80 mm, Bangla, and nothing else on the paper', async ({
  page,
}) => {
  await page.addInitScript(() => {
    (window as unknown as { printCalls: number }).printCalls = 0;
    window.print = () => {
      (window as unknown as { printCalls: number }).printCalls += 1;
    };
  });
  await openTill(page);
  await scan(page, 'ELY-SHRT-0001');
  await page.keyboard.press('F2');
  await completeSale(page);

  await page.getByRole('button', { name: 'Print receipt' }).click();
  expect(await page.evaluate(() => (window as unknown as { printCalls: number }).printCalls)).toBe(1);

  const printRoot = page.getByTestId('print-root');
  // On screen the print region is not shown at all.
  await expect(printRoot).toBeHidden();

  await page.emulateMedia({ media: 'print' });
  await expect(printRoot).toBeVisible();
  // Nothing but the receipt: the till's chrome and the preview dialog are gone.
  await expect(page.getByRole('banner')).toBeHidden();
  await expect(page.getByRole('dialog')).toBeHidden();

  const receipt = printRoot.locator('[data-receipt]');
  const box = await receipt.boundingBox();
  // 80 mm at 96 dpi is 302.36 px.
  expect(box?.width).toBeGreaterThan(301);
  expect(box?.width).toBeLessThan(304);
  expect(await page.evaluate(() => document.body.getBoundingClientRect().width)).toBeLessThan(304);

  // Customer-facing, so Bangla by default (D-036), digits included.
  await expect(receipt).toContainText('ক্যাশ মেমো');
  await expect(receipt).toContainText('Elysium Lifestyle BD');
  await expect(receipt.getByTestId('receipt-total')).toHaveText('৳১,৫০০.০০');
  await expect(receipt.getByTestId('receipt-no')).toHaveText('GUL1-1-0001');

  // And the browser's own print pipeline lays it out on an 80 mm page.
  const pdf = await page.pdf({ width: '80mm', height: '200mm', printBackground: false });
  expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  // One page: the receipt fits the roll, with no dialog or chrome spilling onto a second.
  expect(pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g)?.length).toBe(1);
});
