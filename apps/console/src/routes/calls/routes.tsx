import { createRoute, lazyRouteComponent, type AnyRoute } from '@tanstack/react-router';

/**
 * M47's Calls page (D-845), as a factory the router calls. Its tabs (history, live, extensions)
 * and filters are the page's own search parameters; the page is lazy (M05 check 5's budget).
 */
export function callsRoutes<TRoot extends AnyRoute>(rootRoute: TRoot) {
  const calls = createRoute({
    getParentRoute: () => rootRoute,
    path: '/calls',
    component: lazyRouteComponent(() => import('./calls-page.js'), 'CallsPage'),
  });
  return [calls] as const;
}
