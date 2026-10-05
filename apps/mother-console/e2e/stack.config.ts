import { defineConfig, devices } from '@playwright/test';

/**
 * The owner console against its real stack (M32): `global-setup.ts` provisions two brand
 * databases filled by the brand's own `preview:seed --brand` and a mother database, starts
 * each brand's own API, the built mother API and worker and the console's Vite preview on
 * this run's own ports, and stops them all afterwards.
 *
 * `pnpm --filter @elysium/mother-console e2e:stack`, after building the brand server, the
 * mother server (`pnpm --filter @elysium/mother-server build`) and this console
 * (`vite build`).
 */
export const API_PORT = Number(process.env.E2E_MOTHER_API_PORT ?? 3212);
export const CONSOLE_PORT = Number(process.env.E2E_MOTHER_CONSOLE_PORT ?? 5285);
/** Each brand's own API, one port per brand (check 1 and the owner link's real verifier). */
export const BRAND_API_PORTS = (process.env.E2E_BRAND_API_PORTS ?? '3231,3232')
  .split(',')
  .map((port) => Number(port.trim()));

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.stack.ts',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 300_000,
  // Two brands seeded by their own preview:seed before the first test.
  globalTimeout: 3_600_000,
  reporter: [['list']],
  globalSetup: './global-setup.ts',
  use: {
    baseURL: `http://127.0.0.1:${String(CONSOLE_PORT)}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // The theme switch is a colour transition: axe must measure the colours it ends on,
    // not a frame halfway between light and dark.
    contextOptions: { reducedMotion: 'reduce' },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
