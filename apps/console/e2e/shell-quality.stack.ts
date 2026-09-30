import { createHmac } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

import type { StackInfo } from './stack/global-setup.js';

/**
 * M05's quality checks against the real stack (acceptance checks 1, 2, 6, 7 and 10).
 *
 * The console, the API and the database are all real here, like M11's order desk run:
 * see `stack/global-setup.ts`. These checks were deferred when M05 was built because
 * nothing could sign a browser in; M11's harness made it possible.
 *
 * - **Check 1**: the navigation follows the permission matrix. A sales user sees
 *   Orders and Customers and not Accounts. An accounts user sees Accounts only after
 *   passing the two-factor enrolment wall, which this test clears exactly as a person
 *   would: read the setup key off the screen, compute the code, confirm. Switching
 *   organisation changes the navigation and the Overview's brand and role tiles.
 * - **Check 2**: table filters live in the URL and survive a reload.
 * - **Check 6**: axe finds no serious or critical violation on the login, the shell, a
 *   data table and a form, in both themes.
 * - **Check 7**: every tab stop in the shell shows a visible focus indicator, and the
 *   command palette opens from the keyboard and navigates.
 * - **Check 10**: the review screenshot set, written to `docs/review/M05/`.
 *
 * **One sign-in per person.** The API allows five sign-ins per account per minute
 * (`rate-limit.ts`), and the theme and language passes would spend them in seconds.
 * The sales user signs in once, and every later context starts from that session.
 *
 * Check 5, the bundle budget, is `scripts/check-bundle.mjs` against a production build:
 * the stack serves the development bundle, which is not what a user downloads.
 */

type Theme = 'light' | 'dark';
type Locale = 'en' | 'bn';

function stack(): StackInfo {
  const raw = process.env.E2E_STACK;
  if (raw === undefined) throw new Error('E2E_STACK is missing: run with -c e2e/stack.config.ts');
  return JSON.parse(raw) as StackInfo;
}

function user(role: 'desk' | 'accounts' | 'switcher') {
  const found = stack().users.find((entry) => entry.role === role);
  if (found === undefined) throw new Error(`no ${role} user was provisioned`);
  return found;
}

const REVIEW_DIR = path.resolve(import.meta.dirname, '../../../docs/review/M05');
const DESK_SESSION = path.join(tmpdir(), `elysium-shell-quality-${String(process.pid)}.json`);

/** RFC 4648 base32, as an authenticator app reads a setup key. */
function base32(input: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of input.replace(/[\s=]/g, '').toUpperCase()) {
    const index = alphabet.indexOf(char);
    if (index < 0) throw new Error('the setup key is not base32');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** RFC 6238 TOTP: HMAC-SHA1, 30-second step, 6 digits, which is what an app computes. */
function totp(secret: string, at: number = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const digest = createHmac('sha1', base32(secret)).update(counter).digest();
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

/**
 * Sign in by the form's own input types, so the same helper works in Bangla. The
 * English labels are asserted where the check is about the English screen.
 */
async function signIn(page: Page, email: string): Promise<void> {
  await page.goto('/');
  const form = page.locator('form').filter({ has: page.locator('input[type="password"]') });
  await expect(form).toBeVisible();
  await form.locator('input[type="email"]').fill(email);
  await form.locator('input[type="password"]').fill(stack().password);
  await form.locator('button[type="submit"]').click();
}

/** A browser context with a theme and a language chosen before the first paint. */
async function contextFor(
  browser: Browser,
  options: { readonly theme?: Theme; readonly locale?: Locale; readonly signedIn: boolean },
): Promise<BrowserContext> {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    ...(options.signedIn ? { storageState: DESK_SESSION } : {}),
  });
  await context.addInitScript(
    ([theme, locale]) => {
      localStorage.setItem('elysium-theme', theme);
      localStorage.setItem('elysium-locale', locale);
    },
    [options.theme ?? 'light', options.locale ?? 'en'] as const,
  );
  return context;
}

async function navLabels(page: Page): Promise<string[]> {
  const nav = page.getByRole('navigation', { name: 'Primary navigation' });
  await expect(nav.getByRole('link', { name: 'Overview' })).toBeVisible();
  return (await nav.getByRole('link').allInnerTexts()).map((label) => label.trim()).sort();
}

/** The Overview's three tiles, read the way a person reads them. */
async function tile(page: Page, label: string): Promise<string> {
  const term = page.locator('dt', { hasText: label });
  return (await term.locator('xpath=following-sibling::dd[1]').innerText()).trim();
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, user('desk').email);
  await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible();
  await context.storageState({ path: DESK_SESSION });
  await context.close();
});

test('check 1: the navigation follows the matrix, per role and per organisation', async ({
  browser,
}) => {
  // A sales agent: Orders and Customers, never Accounts.
  const salesContext = await contextFor(browser, { signedIn: true });
  const sales = await salesContext.newPage();
  await sales.goto('/');
  const salesNav = await navLabels(sales);
  expect(salesNav).toEqual(expect.arrayContaining(['Orders', 'Customers']));
  expect(salesNav).not.toContain('Accounts');
  await salesContext.close();

  // Accounts: §6 requires a second factor, so the enrolment wall comes first.
  const accountsContext = await browser.newContext();
  const accounts = await accountsContext.newPage();
  await signIn(accounts, user('accounts').email);
  await expect(
    accounts.getByRole('heading', { name: 'Set up two-step verification' }),
  ).toBeVisible();
  const secret = (await accounts.locator('code').first().innerText()).trim();
  expect(secret.length).toBeGreaterThan(15);
  await accounts.getByRole('checkbox', { name: 'I have saved my recovery codes' }).check();
  await accounts.getByLabel(/^Verification code/).fill(totp(secret));
  await accounts.getByRole('button', { name: 'Confirm and continue' }).click();
  const accountsNav = await navLabels(accounts);
  expect(accountsNav).toContain('Accounts');

  // The link opens the accounts screen itself, not a "coming soon" placeholder: the
  // route was missing until 2026-09-30 and nothing noticed.
  await accounts
    .getByRole('navigation', { name: 'Primary navigation' })
    .getByRole('link', { name: 'Accounts' })
    .click();
  await expect(accounts).toHaveURL(/\/accounts$/);
  await expect(accounts.getByRole('heading', { name: 'Accounts', level: 1 })).toBeVisible();
  await expect(accounts.getByRole('heading', { name: 'Wallets' })).toBeVisible();
  await accountsContext.close();

  // One person, sales in one brand and warehouse in another.
  const switcherContext = await browser.newContext();
  const switcher = await switcherContext.newPage();
  await signIn(switcher, user('switcher').email);
  const orgButton = switcher.getByRole('button', { name: 'Switch organisation' });
  await expect(orgButton).toBeVisible();

  async function switchTo(name: string): Promise<void> {
    if ((await orgButton.innerText()).includes(name)) return;
    await orgButton.click();
    await switcher.getByRole('option', { name: new RegExp(name) }).click();
    await expect(orgButton).toContainText(name);
  }

  await switchTo('Elysium Lifestyle BD');
  await switcher.goto('/');
  expect(await tile(switcher, 'Active brand')).toBe('Elysium Lifestyle BD');
  expect(await tile(switcher, 'Your roles')).toContain('sales');
  const elysiumNav = await navLabels(switcher);
  expect(elysiumNav).toContain('Customers');

  await switchTo('Oura');
  await switcher.goto('/');
  expect(await tile(switcher, 'Active brand')).toBe('Oura');
  const ouraRoles = await tile(switcher, 'Your roles');
  expect(ouraRoles).toContain('warehouse');
  expect(ouraRoles).not.toContain('sales');
  const ouraNav = await navLabels(switcher);
  // Warehouse holds no Customer grant, so the entry leaves with the brand switch.
  expect(ouraNav).not.toContain('Customers');
  expect(ouraNav).not.toEqual(elysiumNav);
  await switcherContext.close();
});

test('check 2: table filters live in the URL and survive a reload', async ({ browser }) => {
  const context = await contextFor(browser, { signedIn: true });
  const page = await context.newPage();
  await page.goto('/tables');
  await expect(page.getByRole('heading', { name: 'Table demo' })).toBeVisible();

  await page.getByRole('searchbox', { name: 'Search' }).fill('ORD');
  await page.getByRole('combobox', { name: 'Status' }).selectOption('settled');
  await expect(page).toHaveURL(/[?&]q=ORD/);
  await expect(page).toHaveURL(/[?&]status=settled/);

  await page.reload();
  await expect(page.getByRole('searchbox', { name: 'Search' })).toHaveValue('ORD');
  await expect(page.getByRole('combobox', { name: 'Status' })).toHaveValue('settled');
  await context.close();
});

/** Serious and critical only: the check's threshold, and the ones a user is blocked by. */
async function blockingViolations(page: Page, label: string) {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const blocking = result.violations.filter(
    (violation) => violation.impact === 'serious' || violation.impact === 'critical',
  );
  test.info().annotations.push({
    type: 'axe',
    description: `${label}: ${String(result.violations.length)} violation(s), ${String(blocking.length)} serious or critical`,
  });
  return blocking.map((violation) => ({
    page: label,
    id: violation.id,
    impact: violation.impact,
    help: violation.help,
    targets: violation.nodes.slice(0, 5).map((node) => node.target.join(' ')),
  }));
}

test('check 6: no serious or critical axe violation on login, shell, table and form', async ({
  browser,
}) => {
  const found: Awaited<ReturnType<typeof blockingViolations>> = [];

  for (const theme of ['light', 'dark'] as const) {
    const anonymous = await contextFor(browser, { theme, signedIn: false });
    const login = await anonymous.newPage();
    await login.goto('/');
    await expect(login.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await expect(login.getByRole('textbox', { name: /email/i })).toBeFocused();
    found.push(...(await blockingViolations(login, `login (${theme})`)));
    await anonymous.close();

    const context = await contextFor(browser, { theme, signedIn: true });
    const page = await context.newPage();
    await page.goto('/');
    await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible();
    found.push(...(await blockingViolations(page, `shell (${theme})`)));

    await page.goto('/tables');
    await expect(page.getByRole('heading', { name: 'Table demo' })).toBeVisible();
    found.push(...(await blockingViolations(page, `data table (${theme})`)));

    await page.goto('/orders/new');
    await expect(page.getByRole('heading', { name: 'New order' })).toBeVisible();
    found.push(...(await blockingViolations(page, `order desk form (${theme})`)));
    await context.close();
  }

  // Every page is scanned before anything is asserted, so one run reports them all.
  expect(found).toEqual([]);
});

/** Whether the focused element draws something a sighted keyboard user can see. */
async function focusIndicator(page: Page) {
  return page.evaluate(() => {
    const element = document.activeElement as HTMLElement | null;
    if (element === null || element === document.body) return null;
    const focused = getComputedStyle(element);
    // A width string, compared as one: this is CSS, not money, but the lint rule
    // that bans float parsing does not know that, and it has no reason to.
    const outline = focused.outlineStyle !== 'none' && !/^0(\.0+)?px$/.test(focused.outlineWidth);
    const ring = focused.boxShadow !== 'none' && focused.boxShadow !== '';
    const name =
      element.getAttribute('aria-label') ??
      element.textContent?.trim().slice(0, 40) ??
      element.tagName;
    const rect = element.getBoundingClientRect();
    return {
      name,
      tag: element.tagName.toLowerCase(),
      visible: rect.width > 0 && rect.height > 0,
      focusVisible: element.matches(':focus-visible'),
      indicator: outline || ring,
    };
  });
}

test('check 7: keyboard only — every tab stop shows focus, and the palette navigates', async ({
  browser,
}) => {
  const context = await contextFor(browser, { signedIn: true });
  const page = await context.newPage();
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Overview', level: 1 })).toBeVisible();

  // From the top of a freshly loaded document: the skip link first, then the shell.
  const stops: NonNullable<Awaited<ReturnType<typeof focusIndicator>>>[] = [];
  for (let index = 0; index < 30; index += 1) {
    await page.keyboard.press('Tab');
    const stop = await focusIndicator(page);
    if (stop === null) break;
    stops.push(stop);
  }
  test.info().annotations.push({
    type: 'tab-stops',
    description: stops.map((stop) => `${stop.tag}:${stop.name}`).join(' | '),
  });

  expect(stops.length).toBeGreaterThan(8);
  expect(stops[0]?.name).toBe('Skip to content');
  const missing = stops.filter((stop) => !(stop.visible && stop.focusVisible && stop.indicator));
  expect(missing, 'tab stops without a visible focus indicator').toEqual([]);

  // The palette, from the keyboard alone.
  await page.keyboard.press('Control+k');
  const search = page.getByPlaceholder('Search screens and commands');
  await expect(search).toBeFocused();
  await page.keyboard.type('Orders');
  await page.keyboard.press('Enter');
  // The list writes its default paging into the URL, so the path is what matters.
  await expect(page).toHaveURL(/\/orders(\?|$)/);
  await expect(search).toBeHidden();
  await context.close();
});

test('check 10: the review screenshot set, both themes, both languages', async ({ browser }) => {
  mkdirSync(REVIEW_DIR, { recursive: true });

  const shot = async (page: Page, name: string) => {
    // Let transitions settle: the set is judged by a person, frame by frame.
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(REVIEW_DIR, `${name}.png`) });
  };

  for (const locale of ['en', 'bn'] as const) {
    for (const theme of ['light', 'dark'] as const) {
      const suffix = `${theme}-${locale}`;

      const anonymous = await contextFor(browser, { theme, locale, signedIn: false });
      const login = await anonymous.newPage();
      await login.goto('/');
      await expect(login.locator('input[type="password"]')).toBeVisible();
      await shot(login, `login-${suffix}`);
      await anonymous.close();

      const context = await contextFor(browser, { theme, locale, signedIn: true });
      const page = await context.newPage();
      await page.goto('/');
      await expect(page.locator('main h1')).toBeVisible();
      await shot(page, `shell-${suffix}`);

      await page.goto('/tables');
      await expect(page.locator('table')).toBeVisible();
      await shot(page, `data-table-${suffix}`);

      await page.goto('/orders/new');
      await expect(page.locator('main input').first()).toBeVisible();
      await shot(page, `form-${suffix}`);

      if (locale === 'en') {
        await page.goto('/tables?q=nothing-matches-this');
        await expect(page.getByText('Nothing to show')).toBeVisible();
        await shot(page, `empty-${suffix}`);

        // An error state, produced the honest way: the API refuses the order list.
        // Orders rather than approvals, because a sales user may not read approvals
        // at all and would be shown the permission screen instead.
        const orderList = /\/v1\/orders(\?|$)/;
        await page.route(orderList, (route) =>
          route.fulfill({
            status: 500,
            contentType: 'application/problem+json',
            body: JSON.stringify({ status: 500, code: 'INTERNAL', title: 'Internal error' }),
          }),
        );
        await page.goto('/orders');
        await expect(page.getByRole('alert').first()).toBeVisible();
        await shot(page, `error-${suffix}`);
        await page.unroute(orderList);

        await page.goto('/');
        await expect(page.locator('main h1')).toBeVisible();
        await page.keyboard.press('Control+k');
        await expect(page.getByPlaceholder('Search screens and commands')).toBeVisible();
        await shot(page, `command-palette-${suffix}`);
      }
      await context.close();
    }
  }
});
