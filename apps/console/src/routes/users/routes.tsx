import { createRoute, lazyRouteComponent, type AnyRoute } from '@tanstack/react-router';

/**
 * The staff screen's route (gaps-users-auth), as a factory the router calls, like the
 * other sections'. Lazy: the initial route bundle has a 250 KB budget (M05 check 5).
 */
export function usersRoutes<TRoot extends AnyRoute>(rootRoute: TRoot) {
  const list = createRoute({
    getParentRoute: () => rootRoute,
    path: '/users',
    component: lazyRouteComponent(() => import('./users-page.js'), 'UsersPage'),
  });
  return [list] as const;
}
