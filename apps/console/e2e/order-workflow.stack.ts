import { mkdirSync } from 'node:fs';
import path from 'node:path';

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

import { enrolSecondFactor, signIn, stack, user } from './stack/helpers.js';

/**
 * M41's order workflow against the real stack (acceptance checks 1 to 5, in a browser).
 *
 * Two sales agents race to take a new order and the loser is told who won; an org admin acts
 * on an agent's order only after "go ahead", and the agent's own dock hears it; auto-assign
 * offers a new order to the one active agent taking orders, who accepts it from the dock's
 * card; the agent logs verification calls; at the hub (Packaging since M46, D-800) the order
 * moves to To pack, is packed, the parcel is scanned onto the courier hand-over, and the desk
 * sees each stage; the supervisors' team board shows who is active and who is not taking
 * orders. Every screen is checked with axe (no serious or critical violation) and photographed
 * in both themes into `docs/review/M41/`.
 *
 * Printing is not driven here. A label prints from Labels on a terminal's printer once a
 * courier has booked the parcel (D-817, D-818); this stack has no booking and no printer on a
 * LAN address the worker may send to (D-812). `labels.e2e.test.ts` covers that path: the
 * printed label marks the order's slip printed and moves it to To pack (D-819). Here the order
 * is moved through `POST /v1/orders/mark-printed`, which no console screen calls.
 */

test.describe.configure({ mode: 'serial' });

const REVIEW_DIR = path.resolve(import.meta.dirname, '../../../docs/review/M41');

async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(REVIEW_DIR, { recursive: true });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(REVIEW_DIR, `${name}.png`), fullPage: true });
}

async function noBlockingViolations(page: Page, label: string): Promise<void> {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const blocking = result.violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .map((violation) => ({ page: label, id: violation.id, help: violation.help }));
  expect(blocking).toEqual([]);
}

/** Axe and a screenshot in light, then the same in dark (the theme is applied on load). */
async function bothThemes(page: Page, name: string): Promise<void> {
  await noBlockingViolations(page, `${name} (light)`);
  await shot(page, `a-${name}-light`);
  await page.evaluate(() => localStorage.setItem('erp-theme', 'dark'));
  await page.reload();
  await page.waitForLoadState('networkidle');
  await noBlockingViolations(page, `${name} (dark)`);
  await shot(page, `b-${name}-dark`);
  await page.evaluate(() => localStorage.setItem('erp-theme', 'light'));
  await page.reload();
  await page.waitForLoadState('networkidle');
}

/** The order the desk agent accepted from the offer card, for the checks that follow. */
let offered: { id: string; orderNo: string } | undefined;

let desk: Page;
let queue: Page;
let admin: Page;
let packer: Page;

/** The API, as the signed-in console calls it: the session cookie and the CSRF echo. */
async function api<T>(
  page: Page,
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  body?: unknown,
): Promise<T> {
  const cookies = await page.context().cookies();
  const csrf = cookies.find((cookie) => cookie.name === 'erp_csrf')?.value ?? '';
  const origin = new URL(page.url()).origin;
  const response = await page.request.fetch(`${stack().apiUrl}${url}`, {
    method,
    headers: {
      'x-csrf-token': csrf,
      origin,
      // A bodyless POST (a take) sends no content type: Fastify refuses an empty JSON body.
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { data: JSON.stringify(body) }),
  });
  expect(response.status(), `${method} ${url}: ${await response.text()}`).toBeLessThan(300);
  return (await response.json()) as T;
}

let skuId = '';
function phone(): string {
  return `017${String(Math.floor(10_000_000 + Math.random() * 89_999_999))}`;
}

/** A new order through the real API: nobody's unless `assignedTo` says whose. */
async function newOrder(page: Page, assignedTo?: string): Promise<{ id: string; orderNo: string }> {
  if (skuId === '') {
    const hits = await api<{ items: { skuId: string }[] }>(
      page,
      'GET',
      `/v1/catalog/skus?q=${encodeURIComponent(stack().skuCodes[1] ?? '')}`,
    );
    skuId = hits.items[0]?.skuId ?? '';
  }
  return api(page, 'POST', '/v1/orders', {
    channel: 'facebook',
    customer: {
      phone: phone(),
      name: 'Workflow E2E Buyer',
      address: { districtId: 47, thanaId: 365, addressLine: 'House 12, Road 6' },
    },
    lines: [{ skuId, qty: 2 }],
    ...(assignedTo === undefined ? {} : { assignedTo }),
  });
}

async function open(page: Page, role: Parameters<typeof user>[0]): Promise<void> {
  await signIn(page, user(role).email);
  if (role === 'supervisor') await enrolSecondFactor(page);
  await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible();
}

test.beforeAll(async ({ browser }) => {
  const viewport = { width: 1440, height: 900 };
  desk = await (await browser.newContext({ viewport })).newPage();
  queue = await (await browser.newContext({ viewport })).newPage();
  admin = await (await browser.newContext({ viewport })).newPage();
  packer = await (await browser.newContext({ viewport })).newPage();
  await open(desk, 'desk');
  await open(queue, 'queue');
  await open(admin, 'supervisor');
  await open(packer, 'packer');
});

test.afterAll(async () => {
  // Leave the stack as other specs expect it: auto-assign off, everybody taking orders.
  await api(admin, 'PUT', '/v1/orders/workflow-settings', {
    autoAssign: false,
    offerSeconds: 45,
    maxOpen: 25,
  }).catch(() => undefined);
  await api(queue, 'POST', '/v1/team/presence/pause', { paused: false }).catch(() => undefined);
  for (const page of [desk, queue, admin, packer]) await page.context().close();
});

test('check 1: two agents take the same new order at once; the loser is told who has it', async () => {
  const order = await newOrder(admin);
  await desk.goto(`/orders/${order.id}`);
  await queue.goto(`/orders/${order.id}`);
  for (const page of [desk, queue]) {
    await expect(page.getByTestId('ownership-banner')).toHaveAttribute('data-owner', 'nobody');
  }
  await bothThemes(desk, 'order-take-prompt');

  await Promise.all([
    desk.getByRole('button', { name: 'Take this order' }).click(),
    queue.getByRole('button', { name: 'Take this order' }).click(),
  ]);

  // Exactly one is handling it; the other reads who took it first.
  const winners: Page[] = [];
  for (const page of [desk, queue]) {
    const mine = page.locator('[data-testid="ownership-banner"][data-owner="me"]');
    const lost = page.getByRole('alert').filter({ hasText: `took order ${order.orderNo} first` });
    await expect(mine.or(lost)).toBeVisible({ timeout: 15_000 });
    if (await mine.isVisible()) winners.push(page);
  }
  expect(winners).toHaveLength(1);
  const loser = winners[0] === desk ? queue : desk;
  await expect(loser.getByRole('alert')).toContainText(/E2E (desk|queue) agent took order/);
  await noBlockingViolations(loser, 'order-take-lost');
  await shot(loser, 'a-order-take-lost');
  await bothThemes(winners[0] ?? desk, 'order-taken-mine');
});

test('check 2: a non-owner is asked before acting, and the owner hears it live', async () => {
  const order = await newOrder(desk, user('desk').userId);
  // The desk agent watches their own sales desk; the dock is listening.
  await desk.goto('/orders/queue?tab=mine');
  await expect(desk.getByTestId('work-dock')).toBeAttached();

  await admin.goto(`/orders/${order.id}`);
  const banner = admin.getByTestId('ownership-banner');
  await expect(banner).toHaveAttribute('data-owner', 'other');
  await expect(banner).toContainText('Handled by E2E desk agent');
  await bothThemes(admin, 'order-handled-by-other');

  await admin.getByRole('button', { name: 'Confirm', exact: true }).click();
  const ask = admin.getByRole('dialog', { name: /Someone else is handling this order/ });
  await expect(ask).toBeVisible();
  await expect(ask).toContainText('E2E desk agent');
  await noBlockingViolations(admin, 'order-ack-dialog');
  await shot(admin, 'a-order-ack-dialog');
  await ask.getByRole('button', { name: 'Go ahead' }).click();
  await expect(admin.getByRole('heading', { level: 1 })).toContainText('Confirmed');

  const notice = desk.getByTestId('owner-notice').filter({ hasText: order.orderNo });
  await expect(notice).toBeVisible({ timeout: 20_000 });
  await expect(notice).toContainText('confirmed');
  await noBlockingViolations(desk, 'owner-told-live');
  await shot(desk, 'a-owner-told-live');
});

test('check 3: auto-assign offers to the active agent taking orders, who accepts it', async () => {
  // The queue agent stops taking orders, so the desk agent is the one available.
  await queue.goto('/orders/queue');
  const queuePill = queue.getByTestId('taking-orders');
  await expect(queuePill).toBeVisible({ timeout: 20_000 });
  if ((await queuePill.innerText()).includes('Taking orders')) {
    await queue.getByRole('button', { name: 'Stop taking orders' }).click();
  }
  await expect(queuePill).toHaveText('Not taking orders');

  // New holds earlier specs' orders; the supervisor takes them, so the one this check creates
  // is the only order waiting when auto-assign comes on.
  const waiting = await api<{ items: { id: string }[] }>(
    admin,
    'GET',
    '/v1/orders?queue=new&limit=100',
  );
  for (const row of waiting.items) await api(admin, 'POST', `/v1/orders/${row.id}/claim`);

  await admin.goto('/settings/order-workflow');
  const form = admin.getByTestId('workflow-settings');
  await expect(form).toBeVisible();
  const auto = form.getByRole('checkbox', {
    name: 'Offer new orders and conversations automatically',
  });
  if (!(await auto.isChecked())) await auto.check();
  await form.getByLabel('Seconds to accept an offer').fill('60');
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(form.getByRole('status')).toHaveText('Saved.');
  await bothThemes(admin, 'settings-order-workflow');
  await expect(admin.getByTestId('workflow-settings').getByRole('checkbox')).toBeChecked();

  await desk.goto('/orders/queue');
  await expect(desk.getByTestId('taking-orders')).toHaveText('Taking orders', { timeout: 20_000 });
  // A fresh beat so the desk agent reads as active when the order arrives.
  await desk.mouse.move(400, 300);
  await desk.reload();
  await expect(desk.getByTestId('work-dock')).toBeAttached();

  const order = await newOrder(admin);
  const card = desk.getByTestId('offer-card').filter({ hasText: order.orderNo });
  await expect(card).toBeVisible({ timeout: 45_000 });
  await expect(card).toContainText('New order for you');
  await expect(card.getByRole('progressbar')).toBeVisible();
  await bothThemes(desk, 'offer-card');
  // Nobody else is offered it.
  await expect(queue.getByTestId('offer-card')).toHaveCount(0);

  await card.getByRole('button', { name: 'Accept' }).click();
  await expect(desk).toHaveURL(new RegExp(`/orders/${order.id}$`));
  await expect(desk.getByTestId('ownership-banner')).toHaveAttribute('data-owner', 'me');
  offered = order;
});

test('check 4: verification calls are logged and order the desk', async () => {
  const order = offered ?? (await newOrder(desk, user('desk').userId));
  await desk.goto(`/orders/${order.id}`);
  const calls = desk.getByTestId('calls-panel');
  await expect(calls).toBeVisible();

  await calls.getByRole('combobox', { name: 'What happened' }).click();
  await desk.getByRole('option', { name: 'No answer', exact: true }).click();
  await calls.getByRole('button', { name: 'Log call' }).click();
  await expect(calls.getByTestId('calls-list')).toContainText('No answer');

  await calls.getByRole('combobox', { name: 'What happened' }).click();
  await desk.getByRole('option', { name: 'Call back later', exact: true }).click();
  const later = new Date(Date.now() + 2 * 3_600_000);
  const local = new Date(later.getTime() - later.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);
  await calls.getByLabel('Call back at').fill(local);
  await calls.getByLabel('Note').fill('Asked to call after work');
  await calls.getByRole('button', { name: 'Log call' }).click();
  await expect(calls.getByTestId('calls-list').getByRole('listitem')).toHaveCount(2);
  await expect(calls).toContainText('2 attempts');
  await bothThemes(desk, 'order-calls');

  await desk.goto('/orders/queue?tab=verifying');
  const row = desk.locator(`[data-order-id="${order.id}"]`);
  await expect(row).toBeVisible();
  await expect(row.getByTestId('call-count')).toHaveText('2');
  await bothThemes(desk, 'desk-verifying');
});

test('check 5: the hub packs and hands over at its location; the desk sees each stage', async () => {
  const order = offered ?? (await newOrder(desk, user('desk').userId));
  await api(desk, 'POST', `/v1/orders/${order.id}/confirm`, {});

  // The hub's location on the packer's desk profile, from the Staff screen.
  await admin.goto('/users');
  // The order's own stock location is the packer's hub.
  const placed = await api<{ locationId: string | null }>(admin, 'GET', `/v1/orders/${order.id}`);
  const fallback = await api<{ locationId: string }>(
    admin,
    'GET',
    `/v1/orders/availability?skuIds=${skuId}`,
  );
  const hubId = placed.locationId ?? fallback.locationId;
  const places = await api<{ items: { id: string; name: string }[] }>(
    admin,
    'GET',
    '/v1/inventory/locations',
  );
  const hubName = places.items.find((place) => place.id === hubId)?.name ?? '';
  expect(hubName).not.toBe('');
  await admin.getByRole('button', { name: 'Manage: E2E packer agent' }).click();
  const section = admin.getByTestId('desk-profile');
  await expect(section).toBeVisible();
  await section.getByRole('combobox', { name: 'Hub location' }).click();
  await admin.getByRole('option', { name: hubName, exact: true }).click();
  await section.getByRole('button', { name: 'Save' }).click();
  await expect(section.getByRole('status')).toHaveText('Saved.');
  await noBlockingViolations(admin, 'staff-desk-profile');
  await shot(admin, 'a-staff-desk-profile');
  await admin.keyboard.press('Escape');

  // M46 (D-800, D-819): the hub's stages are Packaging's tabs now, at the person's hub
  // location. Before its label prints, the confirmed order is not on To pack.
  expect(await api<{ hubStage: string }>(desk, 'GET', `/v1/orders/${order.id}`)).toMatchObject({
    hubStage: 'to_print',
  });
  await packer.goto('/packaging');
  await expect(packer.getByRole('heading', { name: 'Packaging', level: 1 })).toBeVisible();
  await expect(packer.getByTestId('packaging-tab-topack')).toHaveAttribute('aria-current', 'page');
  await expect(packer.getByRole('combobox', { name: 'Location' })).toContainText(hubName);
  await expect(
    packer.getByTestId('stage-hub_packing').or(packer.getByText('Nothing to pack')),
  ).toBeVisible();
  await expect(packer.getByRole('link', { name: order.orderNo, exact: true })).toHaveCount(0);

  // Not a print: the API's own route marks the slip printed, as the first printed label does
  // (D-819). This spec does not cover printing; `labels.e2e.test.ts` does (see the header).
  expect(
    await api<{ marked: string[] }>(packer, 'POST', '/v1/orders/mark-printed', { ids: [order.id] }),
  ).toMatchObject({ marked: [order.id] });
  await packer.reload();
  const toPack = packer
    .getByTestId('stage-hub_packing')
    .getByRole('row')
    .filter({ hasText: order.orderNo });
  await expect(toPack).toBeVisible();
  await expect(toPack.getByRole('button', { name: 'Pack' })).toBeVisible();
  expect(await api<{ hubStage: string }>(desk, 'GET', `/v1/orders/${order.id}`)).toMatchObject({
    hubStage: 'packing',
  });
  await bothThemes(packer, 'hub-packing');

  // Packed at the station (its own spec drives the scans); here through the same transition.
  await api(packer, 'POST', `/v1/orders/${order.id}/pack`, {});
  await packer.getByTestId('packaging-tab-packed').click();
  await expect(
    packer.getByTestId('stage-hub_packed').getByRole('row').filter({ hasText: order.orderNo }),
  ).toBeVisible();

  // The handover (D-808): the order's one lot is its label, scanned as it goes to the rider.
  await packer.getByTestId('packaging-tab-handover').click();
  const handover = packer.getByTestId('handover');
  const scan = handover.getByLabel('Scan each lot’s label');
  await scan.fill(order.orderNo);
  await scan.press('Enter');
  const scanned = handover.getByTestId('handover-list').getByRole('listitem');
  await expect(scanned.filter({ hasText: order.orderNo })).toContainText('All lots scanned');
  await noBlockingViolations(packer, 'hub-handover');
  await shot(packer, 'a-hub-handover');
  await handover.getByTestId('hand-over').click();
  await expect(handover).toContainText('1 orders handed to the courier');

  // "Handed over today", at the hub's location: the heading's own section.
  const handedToday = packer
    .getByRole('heading', { name: 'Handed over today' })
    .locator('xpath=..');
  await expect(handedToday.getByRole('listitem').filter({ hasText: order.orderNo })).toBeVisible();
  expect(await api<{ hubStage: string }>(desk, 'GET', `/v1/orders/${order.id}`)).toMatchObject({
    hubStage: 'handed_over',
  });
  await bothThemes(packer, 'hub-handed');

  await desk.goto('/orders/queue?tab=confirmed_today');
  const today = desk.locator(`[data-order-id="${order.id}"]`);
  await expect(today).toContainText('Handed to courier');
  await bothThemes(desk, 'desk-confirmed-today');
});

test('the team board shows who is active, who is not taking orders, and their load', async () => {
  await admin.goto('/orders/team');
  const board = admin.getByTestId('team-board');
  await expect(board).toBeVisible();
  const deskRow = board.locator(`[data-user-id="${user('desk').userId}"]`);
  const queueRow = board.locator(`[data-user-id="${user('queue').userId}"]`);
  await expect(deskRow).toContainText('Active');
  await expect(queueRow).toContainText('Not taking orders');
  await bothThemes(admin, 'team-board');
  await admin
    .getByTestId('team-board')
    .locator(`[data-user-id="${user('desk').userId}"]`)
    .getByRole('button', { name: /E2E desk agent/ })
    .click();
  await shot(admin, 'a-team-board-orders');
});
