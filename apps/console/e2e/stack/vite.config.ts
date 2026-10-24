import path from 'node:path';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * The console, served for the real-stack Playwright runs (M11 checks 1 and 4, M05's
 * quality checks).
 *
 * The console as it ships: the entry, the shell, the session, the login, the router and
 * the screens are all the application's own. It used to alias the router to a shim that
 * added M11's order routes before they were integrated; they are in `router.tsx` now,
 * so the shim is gone and this run tests the route table users get.
 */
const consoleRoot = path.resolve(import.meta.dirname, '../..');

export default defineConfig({
  root: consoleRoot,
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [{ find: '@', replacement: path.resolve(consoleRoot, 'src') }],
  },
  server: {
    strictPort: true,
    /*
     * One run tests one console: no file watcher and no hot updates. The API and worker run
     * from a build, frozen for the run; the console now is too, as `warmConsole` transformed
     * it. With the watcher on, an edit to `src/` or to a workspace package's `dist` during a
     * run hot-swapped modules under open pages: a run re-executed `auth/session.tsx` beside
     * the old one, `AppShell` read a context no `SessionProvider` gave and the page went blank
     * (order-workflow.stack.ts check 1, waiting on "Take this order" until it timed out).
     * Nothing in the stack edits the console, so nothing here needs to see a change.
     */
    hmr: false,
    watch: null,
  },
});
