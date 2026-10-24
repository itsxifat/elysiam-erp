import { defineConfig, devices } from '@playwright/test';

/**
 * The real-stack Playwright run (M11 acceptance checks 1 and 4).
 *
 * Separate from `playwright.config.ts`, whose specs stub the API at the network boundary:
 * these two checks are about the real API, the real worker and the real realtime path, so
 * `stack/global-setup.ts` starts all of them against a throwaway database and stops them
 * again. The specs are `*.stack.ts`, which the default config's `*.spec.ts` match does not
 * pick up — `pnpm e2e` stays the fast, self-contained run it was.
 *
 * Run with `pnpm --filter @elysium/console exec playwright test -c e2e/stack.config.ts`
 * after building the server.
 */
export default defineConfig({
  testDir: '.',
  testMatch: '**/*.stack.ts',
  // One worker, in order: both checks share one stack and one database.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 120_000,
  reporter: [['list']],
  globalSetup: './stack/global-setup.ts',
  use: {
    baseURL: `http://localhost:${process.env.E2E_CONSOLE_PORT ?? '5183'}`,
    // Every context, the specs' own `browser.newContext()` ones included, asks for reduced
    // motion. The kit honours it (`motion-safe:` on every transition and enter animation, and
    // the reduced-motion guard in `packages/ui/src/styles/tailwind.css`), so a dialog or a
    // button is at its settled colours the moment it shows: axe's contrast check then judges
    // what a person reads, not a frame of a 160 ms fade (barcodes.stack.ts's reverse dialog
    // read 3.62:1 mid-fade, about 5.5:1 settled).
    reducedMotion: 'reduce',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
