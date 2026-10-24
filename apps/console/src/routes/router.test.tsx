import { describe, expect, it, vi } from 'vitest';

vi.mock('../env.js', () => ({ env: { VITE_API_URL: 'http://api.test' } }));

/**
 * The console's route tree builds (D-904's review). A sidebar entry with both a real route and a
 * "coming soon" placeholder is two routes with one path, and the router refuses the whole tree:
 * the console never boots, and no other test would notice, because none of them builds it.
 */
describe('the route tree', () => {
  it('builds, with one route for each path a sidebar entry opens', async () => {
    const { router } = await import('./router.js');
    const { NAVIGATION } = await import('../shell/navigation.js');
    // The root route's path is `/` too; the overview is the route a person opens there.
    const paths = Object.values(router.routesById)
      .filter((route) => !route.isRoot)
      .map((route) => route.fullPath);
    for (const item of NAVIGATION.flatMap((section) => section.items)) {
      expect(
        paths.filter((path) => path === item.to),
        item.to,
      ).toHaveLength(1);
    }
    expect(paths).toContain('/courier-portal');
  });
});
