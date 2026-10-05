import { mkdirSync } from 'node:fs';
import path from 'node:path';

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

import { enrolSecondFactor, signIn, user } from './stack/helpers.js';

/**
 * Website → Payments, Email and Customers (M34, D-528, D-529), against the real stack.
 *
 * The org admin sets up SSLCommerz (sandbox) and the email server, saves them, sees them come
 * back after a reload with the passwords shown only as fingerprints, and sends a test email
 * (the stack's mailer is a recorder). The marketing manager opens the same screens and can read
 * them but not change them: the credentials are the org admin's. Review screenshots go to
 * `docs/review/M34/`.
 */

test.describe.configure({ mode: 'serial' });

const REVIEW_DIR = path.resolve(import.meta.dirname, '../../../docs/review/M34');
const RUN = Date.now().toString(36).slice(-4).toUpperCase();

let page: Page;

async function shot(name: string): Promise<void> {
  mkdirSync(REVIEW_DIR, { recursive: true });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(REVIEW_DIR, `${name}.png`), fullPage: true });
}

async function noBlockingViolations(target: Page, label: string): Promise<void> {
  const result = await new AxeBuilder({ page: target })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const blocking = result.violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .map((violation) => ({ page: label, id: violation.id, help: violation.help }));
  expect(blocking).toEqual([]);
}

test.beforeAll(async ({ browser }) => {
  page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
  await signIn(page, user('webadmin').email);
  await enrolSecondFactor(page);
  await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible();
});

test.afterAll(async () => {
  await page.context().close();
});

test('the org admin sets up SSLCommerz, and the password comes back only as a fingerprint', async () => {
  await page.goto('/website/payments');
  const gateway = page.getByRole('region', { name: 'SSLCommerz' });
  await expect(gateway).toBeVisible();
  await gateway.getByRole('checkbox', { name: 'Take online payments' }).check();
  await gateway.getByLabel('Store ID').fill(`store${RUN}`.toLowerCase());
  await gateway.getByLabel('Store password').fill(`secret-${RUN}`);
  await gateway.getByRole('button', { name: 'Save' }).click();
  await expect(gateway.getByRole('status')).toHaveText('Saved');

  await page.reload();
  const again = page.getByRole('region', { name: 'SSLCommerz' });
  await expect(again.getByLabel('Store ID')).toHaveValue(`store${RUN}`.toLowerCase());
  await expect(again.getByLabel('Store password')).toHaveValue('');
  await expect(again.getByText(/Set\. Fingerprint: [0-9a-f]{12}/)).toBeVisible();
  await expect(again.getByText(/storefront\/ipn\/sslcommerz\//)).toBeVisible();
  await expect(page.getByRole('region', { name: 'Online payments' })).toBeVisible();
  await shot('website-payments');
  await noBlockingViolations(page, 'website payments');
});

test('the org admin sets up the email server and sends a test', async () => {
  await page
    .getByRole('navigation', { name: 'Website' })
    .getByRole('link', { name: 'Email' })
    .click();
  await expect(page).toHaveURL(/\/website\/email$/);
  const server = page.getByRole('region', { name: 'Email server' });
  await server.getByRole('checkbox', { name: 'Send emails' }).check();
  await server.getByLabel('SMTP host').fill('smtp.example.com');
  await server.getByLabel('Port', { exact: true }).fill('587');
  await server.getByLabel('Username').fill(`mailer-${RUN}`);
  await server.getByLabel('Password').fill(`mail-${RUN}`);
  await server.getByLabel('From name').fill(`Shop ${RUN}`);
  await server.getByLabel('From address').fill('shop@example.com');
  await server.getByRole('button', { name: 'Save' }).click();
  await expect(server.getByRole('status').first()).toHaveText('Saved');

  await page.reload();
  const again = page.getByRole('region', { name: 'Email server' });
  await expect(again.getByLabel('SMTP host')).toHaveValue('smtp.example.com');
  await expect(again.getByLabel('Password')).toHaveValue('');
  await again.getByLabel('Send a test to').fill('owner@example.com');
  await again.getByRole('button', { name: 'Send test' }).click();
  await expect(again.getByText('Sent. Check the inbox.')).toBeVisible();
  await shot('website-email');
  await noBlockingViolations(page, 'website email');
});

test('the website’s accounts are listed', async () => {
  await page
    .getByRole('navigation', { name: 'Website' })
    .getByRole('link', { name: 'Customers' })
    .click();
  await expect(page).toHaveURL(/\/website\/customers$/);
  await expect(page.getByRole('region', { name: 'Website accounts' })).toBeVisible();
  await shot('website-customers');
  await noBlockingViolations(page, 'website customers');
});

test('marketing reads the payment and email screens but cannot change them', async ({
  browser,
}) => {
  const marketing = await (
    await browser.newContext({ viewport: { width: 1280, height: 900 } })
  ).newPage();
  try {
    await signIn(marketing, user('marketing').email);
    await expect(marketing.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible();
    await marketing.goto('/website/payments');
    const gateway = marketing.getByRole('region', { name: 'SSLCommerz' });
    await expect(gateway.getByLabel('Store ID')).toBeDisabled();
    await expect(gateway.getByRole('button', { name: 'Save' })).toHaveCount(0);
    await marketing.goto('/website/email');
    const server = marketing.getByRole('region', { name: 'Email server' });
    await expect(server.getByLabel('SMTP host')).toBeDisabled();
    await expect(server.getByRole('button', { name: 'Send test' })).toHaveCount(0);
  } finally {
    await marketing.context().close();
  }
});
