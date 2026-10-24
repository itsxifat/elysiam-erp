import { defineConfig, devices } from '@playwright/test';

/*
 * The stubbed run's own port, never the dev server's 5173.
 *
 * 5173 is every Vite app's default, so on a machine with any other project running it is
 * usually taken, and this config used to reuse whatever answered there: the whole stubbed
 * run once drove a different project's app and failed every test. `E2E_STUB_PORT` moves it
 * when another worktree's run already holds 5163.
 */
const PORT = Number(process.env.E2E_STUB_PORT ?? 5163);
if (!Number.isInteger(PORT) || PORT <= 0 || PORT > 65_535) {
  throw new Error(`E2E_STUB_PORT must be a port number, not ${String(process.env.E2E_STUB_PORT)}`);
}

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
const BASE_URL = `http://localhost:${String(PORT)}`;

/*
 * Where the console believes the API is. The specs stub exactly this origin with
 * `page.route` (`login.spec.ts`'s `API`), so it is set here rather than read from
 * `apps/console/.env`: a different value there would send every call past the stub. Vite
 * never overwrites a variable that is already set.
 */
const STUB_API_URL = 'http://localhost:3000';

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
    // Vite itself rather than `pnpm run dev`, whose script pins `--port 5173`. `--strictPort`
    // makes a taken port an error rather than a quiet move to the next one.
    command: `pnpm exec vite --port ${String(PORT)} --strictPort --host localhost`,
    url: BASE_URL,
    env: { VITE_API_URL: STUB_API_URL },
    /*
     * Never reuse a server already answering on the port. Nothing tells this run whether it
     * is the console or some other app, and reusing a stranger is the failure above; with
     * reuse off Playwright stops with "is already used" instead, and the fix is
     * `E2E_STUB_PORT`.
     */
    reuseExistingServer: false,
    timeout: 90_000,
  },
});
