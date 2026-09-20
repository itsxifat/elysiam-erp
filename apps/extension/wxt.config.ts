import { defineConfig } from 'wxt';

/**
 * Agent activity tracker (architecture §16). It records the active tab's
 * domain only: never a URL path, page content, keystrokes or screenshots.
 * The permission list stays this narrow on purpose, and M28 builds the rest
 * behind a signed staff policy (D-022).
 */
export default defineConfig({
  manifest: {
    name: 'Elysium Agent Activity',
    description: 'Records which work platform an agent is active on, by domain only.',
    permissions: ['storage', 'alarms', 'idle'],
  },
});
