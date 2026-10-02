import { defineConfig, devices } from '@playwright/test';

import { PREVIEW_PORTS } from './preview/global-setup.js';

/**
 * The preview smoke run (D-387): `pnpm --filter @elysium/console e2e:preview`.
 *
 * It builds a throwaway preview the way `pnpm preview:local` builds the owner's — the
 * same `scripts/preview-stack.mjs`, the same `preview:seed`, the same API, worker and
 * three apps — then signs in as every role the credentials file lists (enrolling two-step
 * login where §6 requires it) and opens each area's main screen. A screenshot of every
 * screen goes to `docs/review/preview/`. So the run that says the preview works is the
 * preview.
 *
 * Build the server first; needs Postgres and Valkey from `infra/docker-compose.dev.yml`.
 */
export default defineConfig({
  testDir: '.',
  testMatch: '**/*.preview.ts',
  // One stack, one database, and sign-ins that share the per-IP limit: in order.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 120_000,
  reporter: [['list']],
  globalSetup: './preview/global-setup.ts',
  use: {
    baseURL: `http://localhost:${String(PREVIEW_PORTS.console)}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    viewport: { width: 1440, height: 900 },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
  ],
});
