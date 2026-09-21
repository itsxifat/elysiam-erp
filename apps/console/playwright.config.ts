import { defineConfig, devices } from '@playwright/test';

const PORT = 5173;

/*
 * `localhost`, not `127.0.0.1`, and this matters.
 *
 * The CSRF double-submit token is a cookie the console reads with script and
 * echoes back as a header. Cookies are scoped by host and ignore the port, so
 * the console and the API can only share one when they share a registrable
 * domain — `.erp.example.com` in production, plain `localhost` in development.
 * Pointing the browser at 127.0.0.1 while VITE_API_URL says localhost makes
 * them two different hosts, and the token becomes unreadable.
 */
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `pnpm run dev --host localhost`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 90_000,
  },
});
