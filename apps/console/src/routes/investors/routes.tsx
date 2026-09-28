import { createRoute, lazyRouteComponent, type AnyRoute } from '@tanstack/react-router';

/**
 * M25's two investor routes, as a factory the router calls.
 *
 * A factory rather than two `createRoute` calls inside `router.tsx`, for the reason
 * M06's catalog routes give: `router.tsx` is edited concurrently by other milestones
 * in this working tree and a second write would silently discard the first. This
 * milestone's INTEGRATION section hands the integrator the two lines that call this,
 * plus `/investors` in the placeholder exclusion list — a nav entry with both a real
 * route and a "coming soon" placeholder is an ambiguous match, and the one TanStack
 * Router picks is not the one anybody intended.
 *
 * Both screens are `lazyRouteComponent`, per `.claude/rules/frontend.md`: the initial
 * route bundle has a 250 KB gzipped budget (M05 check 5), and an ERP that eagerly
 * imports twenty module screens spends it before the first one renders.
 *
 * Neither carries `validateSearch`: the list has no URL filters (an investor sees one
 * row and the finance team sees the org's, and neither is long enough to page), and
 * the statement's date range is derived from the Asia/Dhaka calendar rather than typed
 * into the address bar. A filter added later gets a schema at the same time.
 *
 * Generic in the root route with an **inferred** return type: annotating it
 * `AnyRoute[]` would widen the whole router's type and lose `navigate({ search })`'s
 * types on every screen, which is the mistake M06 names.
 */
export function investorsRoutes<TRoot extends AnyRoute>(rootRoute: TRoot) {
  const list = createRoute({
    getParentRoute: () => rootRoute,
    path: '/investors',
    component: lazyRouteComponent(() => import('./investors-page.js'), 'InvestorsPage'),
  });

  const detail = createRoute({
    getParentRoute: () => rootRoute,
    path: '/investors/$investorId',
    component: lazyRouteComponent(() => import('./investor-detail.js'), 'InvestorDetailPage'),
  });

  return [list, detail] as const;
}
