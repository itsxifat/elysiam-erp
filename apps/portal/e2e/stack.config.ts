import { defineConfig, devices } from '@playwright/test';

/**
 * The investor portal against the real stack (M25 acceptance check 1, the browser half).
 *
 * Real rather than stubbed, deliberately (D-313): check 1 is "an investor sees only their
 * own data", and that is the server's property — `own` scope on every investor read plus
 * RLS. A stub API would return whatever the stub was written to return, so a spec against
 * one could only prove the page draws what it is handed. `stack/global-setup.ts` starts a
 * throwaway database seeded through the real API, the built API and worker, and the portal, and stops
 * them again.
 *
 * Run with `pnpm --filter @elysium/portal e2e:stack` after building the server
 * (`pnpm --filter @elysium/server build`). Needs Postgres and Valkey from
 * `infra/docker-compose.dev.yml` and `apps/server/.env`.
 */
export default defineConfig({
  testDir: '.',
  testMatch: '**/*.stack.ts',
  // One worker, in order: the specs share one stack and one database.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 120_000,
  reporter: [['list']],
  globalSetup: './stack/global-setup.ts',
  use: {
    baseURL: 'http://localhost:5185',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
