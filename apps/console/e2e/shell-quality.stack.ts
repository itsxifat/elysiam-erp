import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

import { enrolSecondFactor, signIn, stack, user } from './stack/helpers.js';

/**
 * M05's quality checks against the real stack (acceptance checks 1, 2, 6, 7, 9 and 10).
 *
 * The console, the API and the database are all real here, like M11's order desk run:
 * see `stack/global-setup.ts`. These checks were deferred when M05 was built because
 * nothing could sign a browser in; M11's harness made it possible.
 *
 * - **Check 1**: the navigation follows the permission matrix. A sales user sees
 *   Orders and Customers and not Accounts. An accounts user sees Accounts only after
 *   passing the two-factor enrolment wall, which this test clears exactly as a person
 *   would: read the setup key off the screen, compute the code, confirm. Switching
 *   organisation changes the navigation, the Overview's brand and role tiles, and the
 *   data: Elysium's product is in its catalog and absent from Oura's.
 * - **Check 2**: table filters live in the URL and survive a reload.
 * - **Check 6**: axe finds no serious or critical violation on the login, the shell, a
 *   data table and a form, in both themes.
 * - **Check 7**: on the login, the shell and the data table, the keyboard alone reaches
 *   each named primary action, and every stop's look changes when focus arrives
 *   (measured against the same element blurred). The command palette opens from the
 *   keyboard and navigates.
 * - **Check 9**: every Bangla face carries `size-adjust: 108.1%`, the browser applies
 *   it (a Bangla word is 8.1% wider than in the same face unadjusted), and every taka
 *   amount on the table renders in tabular numerals.
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

const REVIEW_DIR = path.resolve(import.meta.dirname, '../../../docs/review/M05');
const DESK_SESSION = path.join(tmpdir(), `elysium-shell-quality-${String(process.pid)}.json`);

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
  await enrolSecondFactor(accounts);
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

  // The data follows the brand too, not only the menu: the product provisioned in
  // Elysium is in Elysium's catalog and nowhere in Oura's, read by the same person
  // with the same `read Catalog` grant in both (RLS, not the client, decides).
  const slug = (stack().skuCodes[0] ?? '').split('-')[1]?.toLowerCase() ?? '';
  const product = `Product ${slug}`;
  expect(slug).not.toBe('');
  await switcher.goto('/catalog');
  await expect(switcher.getByRole('heading', { name: 'Catalog', level: 1 })).toBeVisible();
  await expect(switcher.getByRole('cell', { name: product })).toBeVisible();

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

  await switcher.goto('/catalog');
  await expect(switcher.getByText('No products yet')).toBeVisible();
  await expect(switcher.getByText(product)).toHaveCount(0);
  await switcherContext.close();
});

test('check 2: table filters live in the URL and survive a reload', async ({ browser }) => {
  const context = await contextFor(browser, { signedIn: true });
  const page = await context.newPage();
  await page.goto('/tables');
  await expect(page.getByRole('heading', { name: 'Table demo' })).toBeVisible();

  await page.getByRole('searchbox', { name: 'Search' }).fill('ORD');
  // The status filter is the kit's Select (D-443): a combobox that opens a listbox.
  await page.getByRole('combobox', { name: 'Status' }).click();
  await page.getByRole('option', { name: 'Settled' }).click();
  await expect(page).toHaveURL(/[?&]q=ORD/);
  await expect(page).toHaveURL(/[?&]status=settled/);

  await page.reload();
  await expect(page.getByRole('searchbox', { name: 'Search' })).toHaveValue('ORD');
  await expect(page.getByRole('combobox', { name: 'Status' })).toHaveText('Settled');
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

/**
 * Whether the focused element draws something a sighted keyboard user can see.
 *
 * Measured as a difference: the element's outline and shadow while focused,
 * against the same element blurred. An element that always carries a shadow — a
 * raised card, a dialog — would otherwise pass as "has a focus ring" without
 * changing at all when focus arrives. Focus is put back with `focusVisible`, so
 * the next Tab continues from here exactly as it would have.
 */
async function focusIndicator(page: Page) {
  return page.evaluate(() => {
    const element = document.activeElement as HTMLElement | null;
    if (element === null || element === document.body) return null;
    const look = () => {
      const style = getComputedStyle(element);
      return `${style.outlineStyle} ${style.outlineWidth} ${style.outlineColor} | ${style.boxShadow}`;
    };
    // A width string, compared as one: this is CSS, not money, but the lint rule
    // that bans float parsing does not know that, and it has no reason to.
    const style = getComputedStyle(element);
    const outline = style.outlineStyle !== 'none' && !/^0(\.0+)?px$/.test(style.outlineWidth);
    const ring = style.boxShadow !== 'none' && style.boxShadow !== '';
    const focusVisible = element.matches(':focus-visible');
    const focusedLook = look();
    element.blur();
    const restingLook = look();
    element.focus({ preventScroll: true, focusVisible: true });

    const labelled =
      element.getAttribute('aria-label') ??
      (element as HTMLInputElement).labels?.[0]?.textContent?.trim() ??
      element.getAttribute('placeholder') ??
      element.textContent?.trim();
    const rect = element.getBoundingClientRect();
    return {
      name: (labelled === undefined || labelled === '' ? element.tagName : labelled).slice(0, 40),
      tag: element.tagName.toLowerCase(),
      visible: rect.width > 0 && rect.height > 0,
      focusVisible,
      indicator: outline || ring,
      changes: focusedLook !== restingLook,
    };
  });
}

type TabStop = NonNullable<Awaited<ReturnType<typeof focusIndicator>>>;

/** Tab from the top of the page until focus leaves the document or `limit` stops. */
async function tabThrough(page: Page, limit: number, label: string): Promise<TabStop[]> {
  // Where focus starts counts too: the login puts it in the email field.
  const start = await focusIndicator(page);
  const stops: TabStop[] = start === null ? [] : [start];
  for (let index = 0; index < limit; index += 1) {
    await page.keyboard.press('Tab');
    const stop = await focusIndicator(page);
    if (stop === null) break;
    stops.push(stop);
  }
  test.info().annotations.push({
    type: `tab-stops: ${label}`,
    description: stops.map((stop) => `${stop.tag}:${stop.name}`).join(' | '),
  });
  return stops;
}

/** Each named action is a stop the keyboard reaches, in this order. */
function expectReached(stops: readonly TabStop[], actions: readonly RegExp[], page: string): void {
  let from = 0;
  for (const action of actions) {
    const at = stops.findIndex((stop, index) => index >= from && action.test(stop.name));
    expect(at, `${page}: the keyboard never reached ${String(action)}`).toBeGreaterThanOrEqual(0);
    from = at + 1;
  }
}

/** Stops that a keyboard user could not see arrive. */
function unseen(stops: readonly TabStop[]): TabStop[] {
  return stops.filter(
    (stop) => !(stop.visible && stop.focusVisible && stop.indicator && stop.changes),
  );
}

test('check 7: keyboard only — every tab stop shows focus, and the palette navigates', async ({
  browser,
}) => {
  // The login, signed out: every field and the submit, each visibly focused.
  const outContext = await contextFor(browser, { signedIn: false });
  const login = await outContext.newPage();
  await login.goto('/');
  await expect(login.getByRole('button', { name: 'Sign in' })).toBeVisible();
  const loginStops = await tabThrough(login, 15, 'login');
  expectReached(loginStops, [/Email/, /Password/, /^Sign in$/], 'login');
  expect(unseen(loginStops), 'login stops without a visible focus change').toEqual([]);
  await outContext.close();

  const context = await contextFor(browser, { signedIn: true });
  const page = await context.newPage();

  // The data table demo: its search, filter, columns menu, each sortable header by
  // name, and the pager.
  await page.goto('/tables');
  await expect(page.getByRole('table')).toBeVisible();
  const tableStops = await tabThrough(page, 60, 'data table');
  expectReached(
    tableStops,
    [/^Search$/, /^Status/, /^Columns$/, /\(Sort ascending\)$/, /^Next$/],
    'data table',
  );
  const sortNames = tableStops
    .filter((stop) => stop.name.includes('(Sort'))
    .map((stop) => stop.name);
  expect(new Set(sortNames).size, 'each sort button is named by its column').toBe(sortNames.length);
  expect(unseen(tableStops), 'table stops without a visible focus change').toEqual([]);

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Overview', level: 1 })).toBeVisible();

  // From the top of a freshly loaded document: the skip link first, then the shell's
  // navigation and every header action.
  const stops = await tabThrough(page, 30, 'shell');
  expect(stops[0]?.name).toBe('Skip to content');
  expectReached(
    stops,
    [
      /^Skip to content$/,
      /^Overview$/,
      /^Orders$/,
      /^Customers$/,
      // The palette's way in reads as a search field since the design refresh (D-449),
      // and Sign out lives in the account menu.
      /^Search or jump to/,
      /^Switch to dark theme$/,
      /^Switch to Bangla$/,
      /^Account$/,
    ],
    'shell',
  );
  expect(unseen(stops), 'shell stops without a visible focus change').toEqual([]);

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

test('the notifications inbox opens from the keyboard, says when it is empty, and gives focus back', async ({
  browser,
}) => {
  const found: Awaited<ReturnType<typeof blockingViolations>> = [];
  for (const theme of ['light', 'dark'] as const) {
    const context = await contextFor(browser, { signedIn: true, theme });
    const page = await context.newPage();
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Overview', level: 1 })).toBeVisible();

    const bell = page.getByRole('button', { name: /^Notifications/ });
    // The inbox is its own chunk; until it lands the header shows an inert bell.
    await expect(bell).toBeEnabled();
    await bell.focus();
    await page.keyboard.press('Enter');
    const panel = page.getByRole('dialog', { name: 'Notifications' });
    await expect(panel).toBeVisible();
    await expect(panel.getByText('You are up to date')).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Mark all as read' })).toBeDisabled();
    found.push(...(await blockingViolations(page, `notifications inbox (${theme})`)));
    mkdirSync(REVIEW_DIR, { recursive: true });
    await page.screenshot({ path: path.join(REVIEW_DIR, `notifications-${theme}-en.png`) });

    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await expect(bell).toBeFocused();
    await context.close();
  }
  expect(found).toEqual([]);
});

test('check 9: Bangla is scaled to Inter, and every amount is in tabular numerals', async ({
  browser,
}) => {
  const context = await contextFor(browser, { signedIn: true, locale: 'bn' });
  const page = await context.newPage();
  await page.goto('/tables');
  await expect(page.getByRole('table')).toBeVisible();

  const typography = await page.evaluate(async () => {
    await document.fonts.ready;
    const family = getComputedStyle(document.body).fontFamily;

    // The faces the stylesheet declares for Bangla, and what each scales by.
    // `sizeAdjust` is in Chromium's FontFace but not yet in TypeScript's DOM types.
    const sizeOf = (face: FontFace): string =>
      (face as FontFace & { readonly sizeAdjust: string }).sizeAdjust;
    const bangla = [...document.fonts]
      .filter((face) => face.family.replace(/["']/g, '') === 'Hind Siliguri')
      .map(sizeOf);

    // The proof that the scaling is applied, not just declared: the same Bangla
    // string set in the console's face, and in a copy of the same file loaded with
    // no adjustment. The ratio of their widths is the size-adjust the browser used.
    let src: string | null = null;
    for (const sheet of [...document.styleSheets]) {
      let rules: CSSRuleList;
      try {
        rules = sheet.cssRules;
      } catch {
        continue;
      }
      for (const rule of [...rules]) {
        if (
          rule instanceof CSSFontFaceRule &&
          rule.style.getPropertyValue('font-family').includes('Hind Siliguri') &&
          rule.style.getPropertyValue('src').includes('bengali') &&
          // The regular face, the one the span below renders in.
          rule.style.getPropertyValue('font-weight') === '400'
        ) {
          src = rule.style.getPropertyValue('src');
        }
      }
    }
    if (src === null) return { family, sizes: bangla, ratio: null };

    const raw = new FontFace('Hind Siliguri Unadjusted', src);
    document.fonts.add(await raw.load());
    await document.fonts.load('64px "Hind Siliguri"', 'অর্ডারনিশ্চিত');
    const width = (fontFamily: string) => {
      const span = document.createElement('span');
      span.textContent = 'অর্ডারনিশ্চিতহয়েছে';
      span.style.fontFamily = fontFamily;
      span.style.fontSize = '64px';
      span.style.position = 'absolute';
      span.style.whiteSpace = 'nowrap';
      document.body.append(span);
      const measured = span.getBoundingClientRect().width;
      span.remove();
      return measured;
    };
    const adjusted = width('"Hind Siliguri"');
    const unadjusted = width('"Hind Siliguri Unadjusted"');
    return {
      family,
      sizes: bangla,
      ratio: Math.round((adjusted / unadjusted) * 1000) / 1000,
    };
  });

  expect(typography.family).toMatch(/^"?Inter"?,\s*"?Hind Siliguri"?/);
  expect(typography.sizes.length).toBeGreaterThan(0);
  expect(new Set(typography.sizes)).toEqual(new Set(['108.1%']));
  // 108.1% within rounding: the text is 8.1% larger than the same face unadjusted.
  expect(typography.ratio).not.toBeNull();
  expect(Math.abs((typography.ratio ?? 0) - 1.081)).toBeLessThan(0.01);

  // Every amount on the page, found by its taka sign, in tabular numerals.
  const amounts = await page.evaluate(() =>
    [...document.querySelectorAll('td, span, p, dd')]
      .filter((element) =>
        [...element.childNodes].some(
          (node) => node.nodeType === Node.TEXT_NODE && node.textContent?.includes('৳'),
        ),
      )
      .map((element) => ({
        text: element.textContent?.trim() ?? '',
        numeric: getComputedStyle(element).fontVariantNumeric,
      })),
  );
  expect(amounts.length).toBeGreaterThan(0);
  expect(amounts.filter((amount) => !amount.numeric.includes('tabular-nums'))).toEqual([]);
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
