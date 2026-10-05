import { createRoute, lazyRouteComponent, type AnyRoute } from '@tanstack/react-router';

/**
 * The Website section's routes (M33), as a factory the router calls — the arrangement
 * every section uses so `router.tsx` is edited in one place.
 *
 * Every screen is its own lazily loaded chunk: nothing of this section is in the initial
 * route's bundle (the 250 KB budget, M05 check 5). `/website` sends the caller to Settings.
 */
export function websiteRoutes<TRoot extends AnyRoute>(rootRoute: TRoot) {
  const index = createRoute({
    getParentRoute: () => rootRoute,
    path: '/website',
    component: lazyRouteComponent(() => import('./parts.js'), 'WebsiteIndexPage'),
  });
  const settings = createRoute({
    getParentRoute: () => rootRoute,
    path: '/website/settings',
    component: lazyRouteComponent(() => import('./settings.js'), 'WebsiteSettingsPage'),
  });
  const hero = createRoute({
    getParentRoute: () => rootRoute,
    path: '/website/hero',
    component: lazyRouteComponent(() => import('./hero.js'), 'WebsiteHeroPage'),
  });
  const menu = createRoute({
    getParentRoute: () => rootRoute,
    path: '/website/menu',
    component: lazyRouteComponent(() => import('./menu.js'), 'WebsiteMenuPage'),
  });
  const sizeCharts = createRoute({
    getParentRoute: () => rootRoute,
    path: '/website/size-charts',
    component: lazyRouteComponent(() => import('./size-charts.js'), 'WebsiteSizeChartsPage'),
  });
  const connection = createRoute({
    getParentRoute: () => rootRoute,
    path: '/website/connection',
    component: lazyRouteComponent(() => import('./connection.js'), 'WebsiteConnectionPage'),
  });
  return [index, settings, hero, menu, sizeCharts, connection] as const;
}
