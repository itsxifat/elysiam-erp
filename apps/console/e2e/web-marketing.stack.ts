import { mkdirSync } from 'node:fs';
import path from 'node:path';

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type Page } from '@playwright/test';

import { enrolSecondFactor, signIn, stack, user } from './stack/helpers.js';

/**
 * Website → Campaign links, Tracking and Marketplace, Orders → Scan and the label sheet
 * (M35b, D-551 to D-555), against the real stack.
 *
 * Marketing makes a campaign link with a banner, changes where it opens, and routes the
 * tracking events; it can read the marketplace screen but change neither its secrets nor the
 * pixel's. The org admin sets the pixel and its token up and connects ncom, and sees each secret
 * come back only as a fingerprint. A sales agent scans an order's number
 * and gets its packing list, pairs a phone for the scanner app and signs it out, and prints the
 * label sheet for an order ticked on the list. Review screenshots go to `docs/review/M35b/`.
 */

test.describe.configure({ mode: 'serial' });

const REVIEW_DIR = path.resolve(import.meta.dirname, '../../../docs/review/M35b');
const RUN = Date.now().toString(36).slice(-4).toUpperCase();

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

async function open(browser: Browser, role: 'marketing' | 'marketadmin' | 'desk'): Promise<Page> {
  const page = await (
    await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  ).newPage();
  await signIn(page, user(role).email);
  // Its own org admin, not website-buying.stack.ts's `webadmin`: both enrol a second factor.
  if (role === 'marketadmin') await enrolSecondFactor(page);
  await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible();
  return page;
}

test.describe('marketing', () => {
  let page: Page;
  test.beforeAll(async ({ browser }) => {
    page = await open(browser, 'marketing');
  });
  test.afterAll(async () => {
    await page.context().close();
  });

  test('a campaign link is made with a banner, gets its five-digit code, and is changed', async () => {
    await page.goto('/website/campaign-links');
    const links = page.getByRole('region', { name: 'Campaign links' });
    await expect(links).toBeVisible();
    await links.getByRole('button', { name: 'New link' }).click();

    const dialog = page.getByRole('dialog', { name: 'New campaign link' });
    await dialog.getByLabel('Name').fill(`Eid post ${RUN}`);
    await dialog.getByRole('checkbox', { name: 'Show a banner above the products' }).check();
    await dialog.getByLabel('Text', { exact: true }).fill(`Eid offer ${RUN}`);
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toBeHidden();

    const row = links.getByRole('row', { name: new RegExp(`Eid post ${RUN}`) });
    await expect(row).toBeVisible();
    await expect(row.getByText(/^\/shop\?cu=\d{5}$/)).toBeVisible();
    await shot(page, 'campaign-links');
    await noBlockingViolations(page, 'campaign links');

    await row.getByRole('button', { name: `Edit: Eid post ${RUN}` }).click();
    const edit = page.getByRole('dialog', { name: /^Campaign link \d{5}$/ });
    await expect(edit.getByLabel('Text', { exact: true })).toHaveValue(`Eid offer ${RUN}`);
    await edit.getByLabel('Opens on').click();
    await page.getByRole('option', { name: 'Another page', exact: true }).click();
    await edit.getByLabel('Page', { exact: true }).fill('/new-arrivals');
    await shot(page, 'campaign-link-dialog');
    await edit.getByRole('button', { name: 'Save' }).click();
    await expect(edit).toBeHidden();

    await page.reload();
    await expect(
      page
        .getByRole('region', { name: 'Campaign links' })
        .getByRole('row', { name: new RegExp(`Eid post ${RUN}`) })
        .getByText(/^\/new-arrivals\?cu=\d{5}$/),
    ).toBeVisible();
  });

  test('marketing routes the events; the pixel and its secrets are the org admin’s', async () => {
    await page
      .getByRole('navigation', { name: 'Website' })
      .getByRole('link', { name: 'Tracking' })
      .click();
    await expect(page).toHaveURL(/\/website\/tracking$/);
    const tracking = page.getByRole('region', { name: 'Tracking' });
    await expect(tracking.getByText(/events are logged here but not sent/)).toBeVisible();
    await expect(tracking.getByLabel('Pixel ID')).toBeDisabled();
    await expect(tracking.getByLabel('Conversions API access token')).toBeDisabled();
    await tracking.getByRole('checkbox', { name: 'Pixel in the browser' }).check();
    await tracking.getByRole('checkbox', { name: 'PageView: Server' }).uncheck();
    await tracking.getByRole('button', { name: 'Save' }).click();
    await expect(tracking.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();

    await page.reload();
    const again = page.getByRole('region', { name: 'Tracking' });
    await expect(again.getByRole('checkbox', { name: 'Pixel in the browser' })).toBeChecked();
    await expect(again.getByRole('checkbox', { name: 'PageView: Server' })).not.toBeChecked();
    await expect(page.getByRole('region', { name: 'Event log' })).toBeVisible();
  });

  test('marketing reads the marketplace screen but cannot change its secrets', async () => {
    await page
      .getByRole('navigation', { name: 'Website' })
      .getByRole('link', { name: 'Marketplace' })
      .click();
    await expect(page).toHaveURL(/\/website\/marketplace$/);
    const settings = page.getByRole('region', { name: 'ncom.bd' });
    await expect(settings.getByLabel('Connector secret')).toBeDisabled();
    await expect(settings.getByRole('button', { name: 'Save' })).toHaveCount(0);
    const addresses = page.getByRole('region', { name: 'Addresses to give ncom' });
    await expect(addresses.getByText(`/ncom/${stack().orgId}/v1`, { exact: false })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Stock held by ncom' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Orders from ncom' })).toBeVisible();
  });
});

test.describe('org admin', () => {
  let page: Page;
  test.beforeAll(async ({ browser }) => {
    page = await open(browser, 'marketadmin');
  });
  test.afterAll(async () => {
    await page.context().close();
  });

  test('sets the pixel up, and the screen says this server only logs events', async () => {
    await page.goto('/website/tracking');
    const tracking = page.getByRole('region', { name: 'Tracking' });
    await tracking.getByLabel('Pixel ID').fill('123456789012345');
    await tracking.getByLabel('Conversions API access token').fill(`EAAB${RUN}token-value-0001`);
    await tracking.getByRole('button', { name: 'Save' }).click();
    await expect(tracking.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();

    await page.reload();
    const again = page.getByRole('region', { name: 'Tracking' });
    await expect(again.getByLabel('Pixel ID')).toHaveValue('123456789012345');
    await expect(again.getByLabel('Conversions API access token')).toHaveValue('');
    await expect(again.getByText(/Set\. Fingerprint: [0-9a-f]{12}/)).toBeVisible();
    await expect(again.getByRole('checkbox', { name: 'PageView: Server' })).not.toBeChecked();
    await shot(page, 'tracking');
    await noBlockingViolations(page, 'tracking');
  });

  test('connects ncom; the secret comes back only as a fingerprint', async () => {
    await page.goto('/website/marketplace');
    const settings = page.getByRole('region', { name: 'ncom.bd' });
    await settings.getByRole('checkbox', { name: 'Connected' }).check();
    await settings.getByLabel('Connector key ID').fill(`ncomcat_${RUN.toLowerCase()}`);
    await settings.getByLabel('Connector secret').fill(`ncomsec_${RUN}_secret_value`);
    await settings.getByRole('button', { name: 'Save' }).click();
    await expect(settings.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();

    await page.reload();
    const again = page.getByRole('region', { name: 'ncom.bd' });
    await expect(again.getByLabel('Connector key ID')).toHaveValue(`ncomcat_${RUN.toLowerCase()}`);
    await expect(again.getByLabel('Connector secret')).toHaveValue('');
    await expect(again.getByText(/Set\. Fingerprint: [0-9a-f]{12}/)).toBeVisible();
    await shot(page, 'marketplace');
    await noBlockingViolations(page, 'marketplace');
  });
});

test.describe('sales agent', () => {
  let page: Page;
  test.beforeAll(async ({ browser }) => {
    page = await open(browser, 'desk');
  });
  test.afterAll(async () => {
    await page.context().close();
  });

  test('scans an order number and gets its packing list', async () => {
    await page.goto('/orders/scan');
    await expect(page.getByRole('heading', { name: 'Scan a parcel', level: 1 })).toBeVisible();
    const field = page.getByLabel('Parcel code or order number');
    await field.fill('NO-SUCH-PARCEL');
    await field.press('Enter');
    await expect(page.getByText(/No order you can see has this code/)).toBeVisible();

    const { orderNo } = stack().advanceOrder;
    await field.fill(orderNo);
    await field.press('Enter');
    const list = page.getByTestId('packing-list');
    await expect(list).toBeVisible();
    await expect(list.getByRole('link', { name: orderNo })).toBeVisible();
    await expect(list.getByText('E2E Product')).toBeVisible();
    // What to collect, or that it is paid (another spec may have taken an advance on it).
    await expect(list.getByText(/^(Collect|Paid)$/)).toBeVisible();
    await shot(page, 'scan');
    await noBlockingViolations(page, 'scan');
  });

  test('pairs a phone for the scanner app and signs it out', async () => {
    const devices = page.getByRole('region', { name: 'Scanner app' });
    await devices.getByRole('button', { name: 'Pair a phone' }).click();
    const dialog = page.getByRole('dialog', { name: 'Pair a phone' });
    await dialog.getByLabel('Phone').fill(`Desk phone ${RUN}`);
    await dialog.getByRole('button', { name: 'Make the code' }).click();
    await expect(dialog.getByTestId('pair-code')).toHaveText(
      /^sdt_[0-9a-f]{32}_[A-Za-z0-9_-]{43}$/,
    );
    await shot(page, 'scan-pair-code');
    await dialog.getByRole('button', { name: 'Done' }).click();

    const row = devices.getByRole('row', { name: new RegExp(`Desk phone ${RUN}`) });
    await expect(row.getByText('Signed in')).toBeVisible();
    await row.getByRole('button', { name: 'Sign out' }).click();
    await page
      .getByRole('dialog', { name: 'Sign this phone out?' })
      .getByRole('button', { name: 'Sign out' })
      .click();
    await expect(row.getByText('Signed out')).toBeVisible();
  });

  test('prints the label sheet for an order ticked on the list', async () => {
    const { orderNo } = stack().advanceOrder;
    await page.goto(`/orders?q=${encodeURIComponent(orderNo)}`);
    await page.getByRole('checkbox', { name: `Select this order ${orderNo}` }).check();
    await page.getByRole('button', { name: 'Label sheet' }).click();
    const dialog = page.getByRole('dialog', { name: 'Print order labels' });
    await dialog.getByLabel('Paper').click();
    await page.getByRole('option', { name: '4 × 6 in (thermal)', exact: true }).click();
    await shot(page, 'label-sheet');
    const [response] = await Promise.all([
      page.waitForResponse((answer) => answer.url().endsWith('/v1/packing/labels')),
      dialog.getByTestId('label-sheet-print').click(),
    ]);
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toContain('application/pdf');
    await expect(dialog.getByRole('link', { name: 'Open the labels' })).toBeVisible();
  });
});
