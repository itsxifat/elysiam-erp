import { expect, test } from '@playwright/test';

/**
 * M00 smoke test.
 *
 * It proves the toolchain end to end — Vite serves, React mounts, Tailwind
 * resolves the design tokens, and both themes paint from the same markup — so
 * that when M05 builds the real shell, a failure here means the shell rather
 * than the build.
 */

test('the app mounts and paints from design tokens', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Design tokens are wired' })).toBeVisible();

  // A resolved token, not a browser default: if the stylesheet failed to load,
  // this would be rgba(0, 0, 0, 0).
  const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(background).not.toBe('rgba(0, 0, 0, 0)');

  // Money and quantity columns are tabular so figures line up column to column
  // (architecture §24).
  const numeric = page.locator('td[data-numeric]').first();
  await expect(numeric).toHaveCSS('font-variant-numeric', 'tabular-nums');
});

test('the theme toggle repaints without a reload', async ({ page }) => {
  await page.goto('/');

  const before = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const toggle = page.getByRole('button', { name: /switch to (light|dark) theme/i });

  await toggle.click();
  await expect(page.locator('html')).toHaveClass(/dark|^$/);

  const after = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(after).not.toBe(before);
});

test('every interactive control is reachable by keyboard', async ({ page }) => {
  // The order desk targets an order in under 30 seconds, which only works if
  // keyboard traversal is real from the start (architecture §24).
  await page.goto('/');
  await page.keyboard.press('Tab');

  const focused = await page.evaluate(() => document.activeElement?.tagName ?? null);
  expect(focused).toBe('BUTTON');
});
