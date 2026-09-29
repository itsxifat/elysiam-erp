import { createRoute, lazyRouteComponent, type AnyRoute } from '@tanstack/react-router';

/**
 * M15's courier routes, as a factory the router calls.
 *
 * A factory rather than `createRoute` calls inside `router.tsx`, for the reason M06's catalog
 * routes give: `router.tsx` is edited concurrently by other milestones, and a second write
 * silently discards the first. The INTEGRATION notes hand the integrator the two lines that
 * call this, plus `/courier` in the placeholder exclusion list and a `NAVIGATION` entry.
 *
 * Every screen is `lazyRouteComponent` (M05 check 5's 250 KB initial-bundle budget). None
 * carries `validateSearch`: the filters here are few and screen-local — a threshold, a date
 * window — and a filter that earns a URL gets a schema when it does.
 *
 * The literal children (`/courier/stuck`) are declared before the parameterised ones
 * (`/courier/parcels/$consignmentId`) only for reading order; TanStack ranks static segments
 * above params whatever the order. Generic in the root route with an **inferred** return type,
 * so the router's types survive (the mistake M06 names).
 */
export function courierRoutes<TRoot extends AnyRoute>(rootRoute: TRoot) {
  const parcels = createRoute({
    getParentRoute: () => rootRoute,
    path: '/courier',
    component: lazyRouteComponent(() => import('./parcels.js'), 'CourierParcelsPage'),
  });

  const stuck = createRoute({
    getParentRoute: () => rootRoute,
    path: '/courier/stuck',
    component: lazyRouteComponent(() => import('./stuck.js'), 'StuckParcelsPage'),
  });

  const performance = createRoute({
    getParentRoute: () => rootRoute,
    path: '/courier/performance',
    component: lazyRouteComponent(() => import('./performance.js'), 'CourierPerformancePage'),
  });

  const settlements = createRoute({
    getParentRoute: () => rootRoute,
    path: '/courier/settlements',
    component: lazyRouteComponent(() => import('./settlements.js'), 'CourierSettlementsPage'),
  });

  const settlement = createRoute({
    getParentRoute: () => rootRoute,
    path: '/courier/settlements/$settlementId',
    component: lazyRouteComponent(() => import('./settlement-detail.js'), 'SettlementDetailPage'),
  });

  const returns = createRoute({
    getParentRoute: () => rootRoute,
    path: '/courier/returns',
    component: lazyRouteComponent(() => import('./returns.js'), 'CourierReturnsPage'),
  });

  const parcel = createRoute({
    getParentRoute: () => rootRoute,
    path: '/courier/parcels/$consignmentId',
    component: lazyRouteComponent(() => import('./parcel-timeline.js'), 'ParcelTimelinePage'),
  });

  return [parcels, stuck, performance, settlements, settlement, returns, parcel] as const;
}
