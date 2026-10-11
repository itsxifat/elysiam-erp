import { createRoute, lazyRouteComponent, type AnyRoute } from '@tanstack/react-router';

/**
 * My account's route (M40), as a factory the router calls, like the other sections'. Lazy: the
 * initial route bundle has a 250 KB budget (M05 check 5), and the QR encoder and the account
 * strings travel in this chunk.
 */
export function accountRoutes<TRoot extends AnyRoute>(rootRoute: TRoot) {
  const account = createRoute({
    getParentRoute: () => rootRoute,
    path: '/account',
    component: lazyRouteComponent(() => import('./account-page.js'), 'AccountPage'),
  });
  return [account] as const;
}
