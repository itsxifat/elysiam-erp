import { mkdirSync } from 'node:fs';
import path from 'node:path';

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
  readonly applied: {
    document: {
      id: string;
      receiptNo: string;
      tenders: { tender: string; amountPoisha: string }[];
    };
    outcome: string;
  }[];
  readonly stock: Record<string, number>;
  readonly wallets: { cash: string; bkash: string; card: string };
  readonly csrfRefusals: number;
  /** Sync bodies the server's own schema refused (`@elysium/contracts`). */
  readonly invalidSyncs: unknown[];
  readonly requests: string[];
}

/** A till database's contents, as the move test reads them out of the browser. */
interface TillSnapshot {
  readonly outbox: { id: string }[];
  readonly kv: [string, unknown][];
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
        const cache = await caches.open('erp-pos-shell-v1');
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
  expect((await stubState(request)).deliveries, 'nothing reached the server while offline').toEqual(
    [],
  );

  // The tablet restarts with no connection: the shell loads from the worker's
  // cache, and the three sales are still in IndexedDB.
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Scan or type a code' })).toBeVisible();
  await expect(page.getByTestId('waiting')).toHaveAttribute('data-count', '3');

  // The browser was closed overnight: the session survives, the CSRF token does not.
  await context.clearCookies({ name: 'erp_csrf' });
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
  expect(after.invalidSyncs, 'every document the till sent is one the server accepts').toEqual([]);
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
  expect(state.invalidSyncs).toEqual([]);
  expect(state.wallets).toEqual({ cash: '0', bkash: '0', card: '0' });
});

test('a receipt prints through the print stylesheet: 80 mm, English, and nothing else on the paper', async ({
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
  expect(await page.evaluate(() => (window as unknown as { printCalls: number }).printCalls)).toBe(
    1,
  );

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

  // The customer's document, in formal English with money as `Tk` (D-750, D-751).
  await expect(receipt).toContainText('Sales receipt');
  await expect(receipt).toContainText('Elysiam Lifestyle BD');
  await expect(receipt.getByTestId('receipt-total')).toHaveText('Tk 1,500.00');
  // Not one character of the Bengali block on the paper, the taka sign included.
  const printed = await receipt.innerText();
  const bengali = new RegExp(`[${String.fromCodePoint(0x0980)}-${String.fromCodePoint(0x09ff)}]`);
  expect(bengali.test(printed), printed).toBe(false);
  // The receipt as the customer gets it, for the owner's review (M43).
  const review = path.resolve(import.meta.dirname, '../../../docs/review/M43');
  mkdirSync(review, { recursive: true });
  await receipt.screenshot({ path: path.join(review, 'till-receipt-80mm.png') });
  await expect(receipt.getByTestId('receipt-no')).toHaveText('GUL1-1-0001');

  // And the browser's own print pipeline lays it out on an 80 mm page.
  const pdf = await page.pdf({ width: '80mm', height: '200mm', printBackground: false });
  expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  // One page: the receipt fits the roll, with no dialog or chrome spilling onto a second.
  expect(pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g)?.length).toBe(1);
});

test('a sale queued under an older build’s database name moves across once, and syncs once (D-472)', async ({
  page,
  context,
  request,
}) => {
  // A sale rung up offline, waiting in the queue.
  await openTill(page);
  await context.setOffline(true);
  await expect(page.getByTestId('connection')).toHaveAttribute('data-online', 'false');
  await scan(page, 'ELY-SHRT-0001');
  await page.keyboard.press('F2');
  await completeSale(page);
  await page.getByRole('button', { name: 'New sale' }).click();
  await expect(page.getByTestId('waiting')).toHaveAttribute('data-count', '1');

  const snapshot: TillSnapshot = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('erp-pos');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('open'));
    });
    const read = <T>(request: IDBRequest<T>) =>
      new Promise<T>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('read'));
      });
    const transaction = db.transaction(['outbox', 'kv']);
    const outbox = await read(transaction.objectStore('outbox').getAll());
    const keys = await read(transaction.objectStore('kv').getAllKeys());
    const values = await read(transaction.objectStore('kv').getAll());
    db.close();
    return {
      outbox: outbox as { id: string }[],
      kv: keys.map((key, index) => [key as string, values[index]] as [string, unknown]),
    };
  });
  expect(snapshot.outbox).toHaveLength(1);
  const saleId = snapshot.outbox[0]?.id ?? '';

  // Turn this browser into one an older build left behind: the same stores, under the
  // older name, and no `erp-pos` at all.
  await page.close();
  await context.setOffline(false);
  const older = await context.newPage();
  await older.goto('/icon.svg');
  // Through JSON: Playwright's argument types recurse without end on IndexedDB's value types.
  await older.evaluate(async (json: string) => {
    const data = JSON.parse(json) as { outbox: unknown[]; kv: [string, unknown][] };
    const settle = (request: IDBRequest | IDBOpenDBRequest) =>
      new Promise<void>((resolve, reject) => {
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error ?? new Error('idb'));
      });
    await settle(indexedDB.deleteDatabase('erp-pos'));
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('elysium-pos', 1);
      request.onupgradeneeded = () => {
        const created = request.result;
        const outbox = created.createObjectStore('outbox', { keyPath: 'id' });
        outbox.createIndex('seq', 'seq', { unique: true });
        outbox.createIndex('status', 'status');
        created.createObjectStore('kv');
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('open'));
    });
    const transaction = db.transaction(['outbox', 'kv'], 'readwrite');
    for (const entry of data.outbox) transaction.objectStore('outbox').put(entry);
    for (const [key, value] of data.kv) transaction.objectStore('kv').put(value, key);
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('write'));
    });
    db.close();
  }, JSON.stringify(snapshot));
  expect(
    await older.evaluate(async () => (await indexedDB.databases()).map((info) => info.name)),
  ).toEqual(['elysium-pos']);

  // The new build starts: the queue moves across, the old database goes, and the sale
  // reaches the server once.
  await older.goto('/');
  await expect(older.getByRole('textbox', { name: 'Scan or type a code' })).toBeVisible();
  await expect
    .poll(async () => (await stubState(request)).applied.map((entry) => entry.document.id), {
      timeout: 30_000,
    })
    .toEqual([saleId]);
  await expect
    .poll(async () =>
      older.evaluate(async () => (await indexedDB.databases()).map((info) => info.name).sort()),
    )
    .toEqual(['erp-pos']);
  await older.getByRole('button', { name: 'Queue' }).click();
  await expect(older.getByTestId('queue').locator('tr[data-status="synced"]')).toHaveCount(1);
});

/** The till's database, read out of the browser (the page must be on the till's origin). */
async function snapshotTill(page: Page): Promise<TillSnapshot> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('erp-pos');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('open'));
    });
    const read = <T>(request: IDBRequest<T>) =>
      new Promise<T>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('read'));
      });
    const transaction = db.transaction(['outbox', 'kv']);
    const outbox = await read(transaction.objectStore('outbox').getAll());
    const keys = await read(transaction.objectStore('kv').getAllKeys());
    const values = await read(transaction.objectStore('kv').getAll());
    db.close();
    return {
      outbox: outbox as { id: string }[],
      kv: keys.map((key, index) => [key as string, values[index]] as [string, unknown]),
    };
  });
}

/**
 * An older build's database planted from a snapshot, `erp-pos` removed, and — like an older
 * build's tab left open — its connection kept on `window.olderTill`.
 */
async function plantOlderAndKeepOpen(page: Page, snapshot: TillSnapshot): Promise<void> {
  await page.evaluate(async (json: string) => {
    const data = JSON.parse(json) as { outbox: unknown[]; kv: [string, unknown][] };
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase('erp-pos');
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error ?? new Error('delete'));
    });
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('elysium-pos', 1);
      request.onupgradeneeded = () => {
        const created = request.result;
        const outbox = created.createObjectStore('outbox', { keyPath: 'id' });
        outbox.createIndex('seq', 'seq', { unique: true });
        outbox.createIndex('status', 'status');
        created.createObjectStore('kv');
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('open'));
    });
    const transaction = db.transaction(['outbox', 'kv'], 'readwrite');
    for (const entry of data.outbox) transaction.objectStore('outbox').put(entry);
    for (const [key, value] of data.kv) transaction.objectStore('kv').put(value, key);
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('write'));
    });
    // No `onversionchange` handler, as an older build has none: it holds on.
    (window as unknown as { olderTill: IDBDatabase }).olderTill = db;
  }, JSON.stringify(snapshot));
}

test('an older build still open in another tab keeps its database, and its later sales arrive too (D-472)', async ({
  page,
  context,
  request,
}) => {
  await openTill(page);
  await context.setOffline(true);
  await expect(page.getByTestId('connection')).toHaveAttribute('data-online', 'false');
  await scan(page, 'ELY-SHRT-0001');
  await page.keyboard.press('F2');
  await completeSale(page);
  await page.getByRole('button', { name: 'New sale' }).click();
  const snapshot = await snapshotTill(page);
  expect(snapshot.outbox).toHaveLength(1);
  const first = snapshot.outbox[0] as { id: string; seq: number; document: { id: string } };
  await page.close();
  await context.setOffline(false);

  // The older build's tab, still open on its database.
  const olderTab = await context.newPage();
  await olderTab.goto('/icon.svg');
  await plantOlderAndKeepOpen(olderTab, snapshot);

  // The new build starts beside it: the queued sale moves across and syncs, but the old
  // database stays, because a tab still holds it.
  const till = await context.newPage();
  await till.goto('/');
  await expect(till.getByRole('textbox', { name: 'Scan or type a code' })).toBeVisible();
  await expect
    .poll(async () => (await stubState(request)).applied.map((entry) => entry.document.id), {
      timeout: 30_000,
    })
    .toEqual([first.id]);
  expect(
    await till.evaluate(async () => (await indexedDB.databases()).map((info) => info.name).sort()),
  ).toEqual(['elysium-pos', 'erp-pos']);

  // The older tab queues one more sale after the copy, then closes.
  const later = randomId();
  await olderTab.evaluate(
    async ({ json, id }) => {
      const entry = JSON.parse(json) as { id: string; seq: number; document: { id: string } };
      const db = (window as unknown as { olderTill: IDBDatabase }).olderTill;
      const transaction = db.transaction('outbox', 'readwrite');
      transaction
        .objectStore('outbox')
        .put({ ...entry, id, seq: entry.seq + 1, document: { ...entry.document, id } });
      await new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error ?? new Error('write'));
      });
      db.close();
    },
    { json: JSON.stringify(first), id: later },
  );
  await olderTab.close();

  // The next start takes the later sale too, and only then lets the old database go.
  await till.reload();
  await expect(till.getByRole('textbox', { name: 'Scan or type a code' })).toBeVisible();
  await expect
    .poll(async () => (await stubState(request)).applied.map((entry) => entry.document.id).sort(), {
      timeout: 30_000,
    })
    .toEqual([first.id, later].sort());
  await expect
    .poll(async () =>
      till.evaluate(async () => (await indexedDB.databases()).map((info) => info.name).sort()),
    )
    .toEqual(['erp-pos']);
});

/** A document id the stub has not seen. */
function randomId(): string {
  return crypto.randomUUID();
}
