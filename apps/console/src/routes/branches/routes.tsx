import { createRoute, lazyRouteComponent, type AnyRoute } from '@tanstack/react-router';

/**
 * M23's two branch routes, as a factory the router calls.
 *
 * A factory rather than two `createRoute` calls inside `router.tsx`, for the reason
 * M06's catalog routes give: `router.tsx` is edited by other milestones in this
 * working tree and a second write would silently discard the first. M23's
 * INTEGRATION section hands the integrator the two lines that call this, the
 * `/branches` navigation entry, and its place in the placeholder exclusion list.
 *
 * Both screens are `lazyRouteComponent` (`.claude/rules/frontend.md`): the initial
 * route bundle has a 250 KB gzipped budget (M05 check 5).
 *
 * Generic in the root route with an **inferred** return type: annotating it
 * `AnyRoute[]` would widen the whole router's type and lose `navigate`'s types on
 * every other screen.
 */
export function branchesRoutes<TRoot extends AnyRoute>(rootRoute: TRoot) {
  const list = createRoute({
    getParentRoute: () => rootRoute,
    path: '/branches',
    component: lazyRouteComponent(() => import('./branches-page.js'), 'BranchesPage'),
  });

  const detail = createRoute({
    getParentRoute: () => rootRoute,
    path: '/branches/$branchId',
    // The range is a filter, so it lives in the URL (frontend rules): a link to
    // "this month at Gulshan" opens on this month. Absent means today, so a plain
    // link from the list needs no search at all.
    validateSearch: (search: Record<string, unknown>): { range?: 'month' } =>
      search.range === 'month' ? { range: 'month' } : {},
    component: lazyRouteComponent(() => import('./branch-detail.js'), 'BranchDetailPage'),
  });

  return [list, detail] as const;
}
