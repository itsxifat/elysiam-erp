import { createRoute, lazyRouteComponent, type AnyRoute } from '@tanstack/react-router';

/**
 * The settings section's routes (D-394), as a factory the router calls — the arrangement
 * every section uses so `router.tsx` is edited in one place.
 *
 * `/settings` sends the caller to the first tab their role can open (`SettingsIndexPage`);
 * each tab is its own lazily loaded screen, gated again inside on the grant its routes declare.
 */
export function settingsRoutes<TRoot extends AnyRoute>(rootRoute: TRoot) {
  const index = createRoute({
    getParentRoute: () => rootRoute,
    path: '/settings',
    component: lazyRouteComponent(() => import('./parts.js'), 'SettingsIndexPage'),
  });
  const thresholds = createRoute({
    getParentRoute: () => rootRoute,
    path: '/settings/thresholds',
    component: lazyRouteComponent(() => import('./thresholds.js'), 'ThresholdsPage'),
  });
  const zones = createRoute({
    getParentRoute: () => rootRoute,
    path: '/settings/zones',
    component: lazyRouteComponent(() => import('./zones.js'), 'ZonesPage'),
  });
  const couriers = createRoute({
    getParentRoute: () => rootRoute,
    path: '/settings/couriers',
    component: lazyRouteComponent(() => import('./couriers.js'), 'CouriersPage'),
  });
  const siteKeys = createRoute({
    getParentRoute: () => rootRoute,
    path: '/settings/site-keys',
    component: lazyRouteComponent(() => import('./site-keys.js'), 'SiteKeysPage'),
  });
  const registers = createRoute({
    getParentRoute: () => rootRoute,
    path: '/settings/registers',
    component: lazyRouteComponent(() => import('./registers.js'), 'RegistersPage'),
  });
  return [index, thresholds, zones, couriers, siteKeys, registers] as const;
}
