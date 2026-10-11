import { createRoute, lazyRouteComponent, type AnyRoute } from '@tanstack/react-router';

/**
 * M42's inbox route, as a factory the router calls (the arrangement every section uses, so
 * `router.tsx` is edited in one place). Lazy, like every screen (M05 check 5's bundle budget).
 * The filters and the open conversation are in the address bar; the page parses them with
 * `inboxSearchSchema` (`useSchemaSearch`'s arrangement), so the schema travels in the inbox's
 * chunk rather than in the first download, which is at its budget.
 */
export function inboxRoutes<TRoot extends AnyRoute>(rootRoute: TRoot) {
  const inbox = createRoute({
    getParentRoute: () => rootRoute,
    path: '/inbox',
    component: lazyRouteComponent(() => import('./inbox-page.js'), 'InboxPage'),
  });
  return [inbox] as const;
}
