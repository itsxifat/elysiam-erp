import { defineConfig } from 'wxt';

/**
 * Agent activity tracker (architecture §16). It records the active tab's
 * domain only: never a URL path, page content, keystrokes or screenshots.
 * The permission list stays this narrow on purpose, and M28 builds the rest
 * behind a signed staff policy (D-022).
 */
export default defineConfig({
  // WXT's dev server defaults to 3000, which is the API's port. Left alone,
  // `pnpm dev` binds both and `http://localhost:3000` resolves to whichever
  // won the race — so every VITE_API_URL would point at the extension.
  dev: { server: { port: 3010 } },
  manifest: {
    name: 'Elysiam Agent Activity',
    description: 'Records which work platform an agent is active on, by domain only.',
    permissions: ['storage', 'alarms', 'idle'],
  },
});
