import { defineConfig, devices } from '@playwright/test';

/**
 * The owner console against its real stack (M32): `global-setup.ts` provisions two demo
 * brand databases and a mother database, starts the built mother API and worker and the
 * console's Vite preview on this run's own ports, and stops them all afterwards.
 *
 * `pnpm --filter @elysium/mother-console e2e:stack`, after building the mother server
 * (`pnpm --filter @elysium/mother-server build`) and this console (`vite build`).
 */
export const API_PORT = Number(process.env.E2E_MOTHER_API_PORT ?? 3212);
export const CONSOLE_PORT = Number(process.env.E2E_MOTHER_CONSOLE_PORT ?? 5285);

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.stack.ts',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 240_000,
  reporter: [['list']],
  globalSetup: './global-setup.ts',
  use: {
    baseURL: `http://127.0.0.1:${String(CONSOLE_PORT)}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
