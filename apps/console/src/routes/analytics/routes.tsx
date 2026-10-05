import { createRoute, lazyRouteComponent, type AnyRoute } from '@tanstack/react-router';

/**
 * M24's analytics screen: the brand dashboard. A factory the router calls, as every module
 * since M06 does; the screen is its own chunk, and the dashboard's chart is a further one.
 * The leaderboard and the all-brands view left with M31 (D-471).
 */
export function analyticsRoutes<TRoot extends AnyRoute>(rootRoute: TRoot) {
  const page = (path: string, load: () => Promise<Record<string, unknown>>, name: string) =>
    createRoute({
      getParentRoute: () => rootRoute,
      path,
      component: lazyRouteComponent(load as never, name as never),
    });

  return [page('/analytics', () => import('./dashboard.js'), 'AnalyticsDashboardPage')] as const;
}
