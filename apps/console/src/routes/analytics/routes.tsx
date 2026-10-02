import { createRoute, lazyRouteComponent, type AnyRoute } from '@tanstack/react-router';

/**
 * M24's analytics screens: the brand dashboard, the cross-brand leaderboard and Super
 * Admin's view of all brands. A factory the router calls, as every module since M06 does;
 * each screen is its own chunk, and the dashboard's chart is a further one.
 */
export function analyticsRoutes<TRoot extends AnyRoute>(rootRoute: TRoot) {
  const page = (path: string, load: () => Promise<Record<string, unknown>>, name: string) =>
    createRoute({
      getParentRoute: () => rootRoute,
      path,
      component: lazyRouteComponent(load as never, name as never),
    });

  return [
    page('/analytics', () => import('./dashboard.js'), 'AnalyticsDashboardPage'),
    page('/analytics/leaderboard', () => import('./leaderboard.js'), 'LeaderboardPage'),
    page('/analytics/group', () => import('./group.js'), 'GroupPage'),
  ] as const;
}
