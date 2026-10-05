import { createRootRoute } from '@tanstack/react-router';
import { describe, expect, it } from 'vitest';

import { NAVIGATION, PALETTE_ACTIONS, PALETTE_PAGES } from '../shell/navigation.js';
import { accountsRoutes } from './accounts/routes.js';
import { analyticsRoutes } from './analytics/routes.js';

/**
 * M31 check 2, the console's half (D-471): a brand's console has no screen that reads
 * across brands. The all-brands dashboard, the leaderboard and the all-brands accounts
 * left with their routes; neither the router, the sidebar nor the palette names them.
 */

const GONE = ['/analytics/leaderboard', '/analytics/group', '/accounts/consolidated'];

describe('no cross-brand screen', () => {
  it('is not a route', () => {
    const root = createRootRoute();
    const paths = [...analyticsRoutes(root), ...accountsRoutes(root)].map(
      (route) => (route.options as { path?: string }).path,
    );
    expect(paths).toContain('/analytics');
    for (const path of GONE) expect(paths).not.toContain(path);
  });

  it('is not in the sidebar or the palette', () => {
    const targets = [
      ...NAVIGATION.flatMap((section) => section.items.map((item) => String(item.to))),
      ...PALETTE_PAGES.map((page) => String(page.to)),
      ...PALETTE_ACTIONS.map((action) => String(action.to)),
    ];
    for (const path of GONE) expect(targets).not.toContain(path);
  });
});
