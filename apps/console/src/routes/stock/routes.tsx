import { createRoute, lazyRouteComponent, type AnyRoute } from '@tanstack/react-router';

import { tableSearchSchema } from '../../lib/table-search.js';

/**
 * M07's four stock routes, as a factory the router calls.
 *
 * A factory rather than four `createRoute` calls inside `router.tsx`, for the reason
 * M06's catalog routes give: `router.tsx` is edited concurrently by other milestones in
 * this working tree and a second write would silently discard the first. M07's
 * INTEGRATION section hands the integrator the two lines that call this; every route
 * below is defined here, in a file this milestone owns.
 *
 * Every screen is `lazyRouteComponent`, per `.claude/rules/frontend.md`: the initial
 * route bundle has a 250 KB gzipped budget (M05 check 5), and an ERP that eagerly
 * imports twenty module screens spends it before the first one renders.
 *
 * `/stock` carries `validateSearch` because its filters are in the URL, and that makes
 * them a public interface the moment they are in the address bar: `?page=-4` has to
 * degrade to the default view rather than reach the API as a 400 that reads like a
 * server fault.
 *
 * The literal children are declared before nothing — there is no `/stock/$id` — so the
 * order here is only about reading. Generic in the root route with an **inferred**
 * return type: annotating it `AnyRoute[]` would widen the whole router's type and lose
 * `navigate({ search })`'s types on every screen, which is the mistake M06 names.
 */
export function stockRoutes<TRoot extends AnyRoute>(rootRoute: TRoot) {
  const levels = createRoute({
    getParentRoute: () => rootRoute,
    path: '/stock',
    validateSearch: tableSearchSchema,
    component: lazyRouteComponent(() => import('./stock-levels.js'), 'StockLevelsPage'),
  });

  const adjustments = createRoute({
    getParentRoute: () => rootRoute,
    path: '/stock/adjustments',
    component: lazyRouteComponent(() => import('./adjustments.js'), 'StockAdjustmentsPage'),
  });

  const transfers = createRoute({
    getParentRoute: () => rootRoute,
    path: '/stock/transfers',
    component: lazyRouteComponent(() => import('./transfers.js'), 'StockTransfersPage'),
  });

  const counts = createRoute({
    getParentRoute: () => rootRoute,
    path: '/stock/counts',
    component: lazyRouteComponent(() => import('./counts.js'), 'StockCountsPage'),
  });

  return [levels, adjustments, transfers, counts] as const;
}
