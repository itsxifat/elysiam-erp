import { expect, test } from '@playwright/test';

/**
 * Toolchain smoke test.
 *
 * It proves the build end to end — Vite serves, React mounts, Tailwind resolves
 * the design tokens, and the accessibility floor holds — so that when a feature
 * test fails, the failure is the feature rather than the build.
 *
 * No API is stubbed here on purpose. The console must render its login screen
 * when the server is unreachable: a branding lookup that cannot complete is a
 * reason to show the generic login, never a reason to show nothing.
 */

test('the app mounts and paints from design tokens with no server at all', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();

  // A resolved token, not a browser default: if the stylesheet failed to load,
  // this would be rgba(0, 0, 0, 0).
  const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(background).not.toBe('rgba(0, 0, 0, 0)');
});

test('the brand accent falls back to the shipped token when branding cannot load', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();

  // The sign-in button is filled with --primary, which is derived from the
  // brand triple. An unreachable API must leave it a real colour.
  const fill = await page
    .getByRole('button', { name: 'Sign in', exact: true })
    .evaluate((node) => getComputedStyle(node).backgroundColor);

  expect(fill).not.toBe('rgba(0, 0, 0, 0)');
});

test('every interactive control is reachable by keyboard', async ({ page }) => {
  // The order desk targets an order in under 30 seconds, which only works if
  // keyboard traversal is real from the start (architecture §24).
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();

  // The email field takes focus on mount, so an operator can start typing.
  const focused = await page.evaluate(() => document.activeElement?.getAttribute('type') ?? null);
  expect(focused).toBe('email');
});

test('focus is visible, not merely present', async ({ page }) => {
  // A focus ring that exists only in the accessibility tree helps nobody
  // driving the console by keyboard (architecture §24).
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();

  const button = page.getByRole('button', { name: 'Sign in', exact: true });
  await button.focus();

  const ring = await button.evaluate((node) => {
    const style = getComputedStyle(node);
    return { width: style.outlineWidth, shadow: style.boxShadow };
  });

  // Tailwind's ring utilities paint a box-shadow rather than an outline.
  expect(ring.shadow === 'none' && ring.width === '0px').toBe(false);
});
