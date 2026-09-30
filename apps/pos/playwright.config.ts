import { defineConfig, devices } from '@playwright/test';

/*
 * The till's browser tests (M23 checks 1 and 4).
 *
 * Two servers, both started here:
 *
 * - **The built app under `vite preview`**, not the dev server. The offline shell
 *   is a service worker, and it is registered only in a production build: under
 *   the dev server the modules are unbundled and a worker caching them would serve
 *   stale code. Testing the offline start against anything but the real bundle
 *   would test a different program.
 * - **A stub API** (`e2e/stub-api.mjs`), a real HTTP server rather than
 *   `page.route`, because the spec takes the browser genuinely offline and the
 *   page runs behind that worker.
 *
 * Their own ports, so a developer's running `pnpm dev` (5175, 3000) is not in the
 * way and is not what gets tested by accident. `localhost` throughout, never
 * 127.0.0.1: the CSRF cookie is read by script and scoped by host (D-053).
 */
const APP_PORT = 5176;
const API_PORT = 3975;
const BASE_URL = `http://localhost:${String(APP_PORT)}`;
export const STUB_API = `http://localhost:${String(API_PORT)}`;

export default defineConfig({
  testDir: './e2e',
  // One worker: the stub API holds one till's state, and the tests reset it.
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    serviceWorkers: 'allow',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'node e2e/stub-api.mjs',
      url: `${STUB_API}/__test/state`,
      env: { STUB_API_PORT: String(API_PORT), POS_ORIGIN: BASE_URL },
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      command: `pnpm exec vite build && pnpm exec vite preview --port ${String(APP_PORT)} --strictPort --host localhost`,
      url: BASE_URL,
      env: { VITE_API_URL: STUB_API },
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
    },
  ],
});
