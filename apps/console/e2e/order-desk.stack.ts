import { expect, test, type BrowserContext, type Page } from '@playwright/test';

import type { StackInfo } from './stack/global-setup.js';

/**
 * The order desk against the real stack (M11 acceptance checks 1 and 4).
 *
 * Nothing here is stubbed: the console talks to the real API, the API to a real database,
 * the worker dispatches the real outbox, and the realtime gateway delivers over Valkey. See
 * `stack/global-setup.ts` for how that stack is started and stopped.
 *
 * **Check 1 is keyboard only.** No `click`, no `fill`, no `check` — the agent's hands never
 * leave the keyboard, from signing in to the confirmed order, and the one navigation is a
 * URL. The number it reports is the app's own latency with an instant typist: every
 * keystroke is typed without delay, so what is measured is the server and the render. A
 * trained agent's human time is measured at the pilot and recorded in the progress log.
 *
 * **Check 4 uses two browser contexts** — two separate sessions, two agents. One creates an
 * order the other has never heard of; the other's queue shows it without a reload, and the
 * test proves "without a reload" by leaving a marker on the page's `window` that a reload
 * would erase.
 */

function stack(): StackInfo {
  const raw = process.env.E2E_STACK;
  if (raw === undefined) throw new Error('E2E_STACK is missing: run with -c e2e/stack.config.ts');
  return JSON.parse(raw) as StackInfo;
}

function user(role: 'desk' | 'queue') {
  const found = stack().users.find((entry) => entry.role === role);
  if (found === undefined) throw new Error(`no ${role} user was provisioned`);
  return found;
}

/** A random, valid, throwaway Bangladeshi mobile number. */
function throwawayPhone(): string {
  return `017${String(Math.floor(10_000_000 + Math.random() * 89_999_999))}`;
}

/** Sign in with the keyboard alone: the email field has focus when the screen opens. */
async function signIn(page: Page, email: string, landing: string): Promise<void> {
  await page.goto(landing);
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: /email/i })).toBeFocused();
  await page.keyboard.type(email);
  await page.keyboard.press('Tab');
  await page.keyboard.type(stack().password);
  await page.keyboard.press('Enter');
}

test('check 1: phone to confirmed order, keyboard only, inside the 30-second budget', async ({
  page,
}) => {
  const desk = user('desk');
  await signIn(page, desk.email, '/orders/new');

  await expect(page.getByRole('heading', { name: 'New order' })).toBeVisible();
  const phoneField = page.getByRole('textbox', { name: /^Phone/ });
  await expect(phoneField).toBeFocused();

  const skuCode = stack().skuCodes[0] ?? '';
  // A fragment unique to this run's product: the catalog's search needs three characters.
  const skuFragment = skuCode.split('-')[1] ?? skuCode;

  const started = Date.now();

  await page.keyboard.type(throwawayPhone());
  await page.keyboard.press('Tab');
  await page.keyboard.type('E2E Buyer');
  await page.keyboard.press('Tab');
  await page.keyboard.type('savar');
  await expect(page.getByRole('option', { name: /Savar, Dhaka/ })).toBeVisible();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await page.keyboard.type('House 7, Road 3');
  await page.keyboard.press('Alt+K');
  await expect(page.getByRole('combobox', { name: /Find a SKU/ })).toBeFocused();
  await page.keyboard.type(skuFragment);
  await expect(page.getByRole('option', { name: new RegExp(skuCode) })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('row', { name: new RegExp(skuCode) })).toBeVisible();
  await page.keyboard.press('Control+Enter');

  const outcome = page.getByTestId('desk-outcome');
  await expect(outcome).toContainText('Order confirmed', { timeout: 20_000 });

  const elapsedMs = Date.now() - started;
  test.info().annotations.push({
    type: 'latency',
    description: `phone to confirmed order: ${String(elapsedMs)} ms (server + render, instant typist)`,
  });
  process.stdout.write(`M11 check 1: phone to confirmed order in ${String(elapsedMs)} ms\n`);
  expect(elapsedMs).toBeLessThan(30_000);

  // The server agrees: the order it just rendered as confirmed is confirmed there too.
  const orderNo = (await page.getByTestId('desk-order-no').textContent())?.trim() ?? '';
  expect(orderNo).toMatch(/^[A-Z][A-Z0-9]{1,5}-\d{4}-\d{5,}$/);
  const listed = await page.request.get(
    `${stack().apiUrl}/v1/orders?q=${encodeURIComponent(orderNo)}`,
  );
  expect(listed.ok()).toBe(true);
  const { items } = (await listed.json()) as {
    items: { orderNo: string; status: string; assignedTo: string | null }[];
  };
  expect(items.find((item) => item.orderNo === orderNo)).toMatchObject({
    status: 'confirmed',
    assignedTo: desk.userId,
  });

  // And Enter takes the next order: focus is on "Take another order".
  await page.keyboard.press('Enter');
  await expect(phoneField).toBeFocused();
  await expect(phoneField).toHaveValue('');
});

async function csrfToken(context: BrowserContext): Promise<string> {
  const cookie = (await context.cookies()).find((entry) => entry.name === 'elysium_csrf');
  if (cookie === undefined) throw new Error('no CSRF cookie in this session');
  return cookie.value;
}

test('check 4: a new order appears in a second agent’s queue without a refresh', async ({
  browser,
}) => {
  const first = await browser.newContext();
  const second = await browser.newContext();
  try {
    const creator = await first.newPage();
    const watcher = await second.newPage();

    await signIn(creator, user('desk').email, '/orders/queue');
    await signIn(watcher, user('queue').email, '/orders/queue');
    await expect(watcher.getByRole('heading', { name: 'Unassigned queue' })).toBeVisible();
    // The socket is up before the order is taken, or this would be testing the initial load.
    await expect(watcher.locator('[data-live="connected"]')).toBeVisible({ timeout: 20_000 });
    await watcher.evaluate(() => {
      (window as unknown as { __noReload?: boolean }).__noReload = true;
    });

    // The first agent takes an order and leaves it in the queue, from their own session:
    // the SKU resolved through the catalog as the desk resolves it, and no assignee, so
    // it lands in §6's unassigned queue.
    const hits = await creator.request.get(
      `${stack().apiUrl}/v1/catalog/skus?q=${encodeURIComponent(stack().skuCodes[1] ?? '')}`,
    );
    const skuId = ((await hits.json()) as { items: { skuId: string }[] }).items[0]?.skuId;
    expect(skuId).toBeDefined();

    const taken = await creator.request.post(`${stack().apiUrl}/v1/orders`, {
      headers: { 'x-elysium-csrf': await csrfToken(first), origin: 'http://localhost:5183' },
      data: {
        channel: 'whatsapp',
        customer: {
          phone: throwawayPhone(),
          name: 'Queue E2E Buyer',
          address: { districtId: 47, thanaId: 365, addressLine: 'House 9, Road 1' },
        },
        lines: [{ skuId, qty: 1 }],
      },
    });
    expect(taken.status()).toBe(201);
    const { orderNo } = (await taken.json()) as { orderNo: string };

    const started = Date.now();
    await expect(watcher.getByTestId('order-queue').getByText(orderNo)).toBeVisible({
      timeout: 20_000,
    });
    process.stdout.write(
      `M11 check 4: order visible in the second session after ${String(Date.now() - started)} ms\n`,
    );

    // No reload happened: the marker a reload would have erased is still there.
    expect(
      await watcher.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload),
    ).toBe(true);
  } finally {
    await first.close();
    await second.close();
  }
});
