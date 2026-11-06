import { createRoute, lazyRouteComponent, type AnyRoute } from '@tanstack/react-router';

/**
 * `/locations`: the brand's stock locations on a page of their own (D-951), a factory the
 * router calls like every module's. Lazy, so the page and its strings stay out of the first
 * download (the 250 KB budget, M05 check 5).
 */
export function locationsRoutes<TRoot extends AnyRoute>(rootRoute: TRoot) {
  const list = createRoute({
    getParentRoute: () => rootRoute,
    path: '/locations',
    component: lazyRouteComponent(() => import('./locations-page.js'), 'LocationsPage'),
  });
  return [list] as const;
}
