import { createRoute, lazyRouteComponent, type AnyRoute } from '@tanstack/react-router';

import { inboxSearchSchema } from './logic.js';

/**
 * M42's inbox route, as a factory the router calls (the arrangement every section uses, so
 * `router.tsx` is edited in one place). Lazy, like every screen (M05 check 5's bundle budget).
 * `validateSearch`: the filters and the open conversation are in the address bar, and a
 * hand-edited one falls back to the default view.
 */
export function inboxRoutes<TRoot extends AnyRoute>(rootRoute: TRoot) {
  const inbox = createRoute({
    getParentRoute: () => rootRoute,
    path: '/inbox',
    validateSearch: inboxSearchSchema,
    component: lazyRouteComponent(() => import('./inbox-page.js'), 'InboxPage'),
  });
  return [inbox] as const;
}
