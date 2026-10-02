import { createRoute, lazyRouteComponent, type AnyRoute } from '@tanstack/react-router';

/**
 * M26's two company-loan routes, as a factory the router calls (the shape M25's investor
 * routes set). Both lazy: the initial route bundle has a 250 KB budget (M05 check 5).
 */
export function loansRoutes<TRoot extends AnyRoute>(rootRoute: TRoot) {
  const list = createRoute({
    getParentRoute: () => rootRoute,
    path: '/loans',
    component: lazyRouteComponent(() => import('./loans-page.js'), 'LoansPage'),
  });

  const detail = createRoute({
    getParentRoute: () => rootRoute,
    path: '/loans/$loanId',
    component: lazyRouteComponent(() => import('./loan-detail.js'), 'LoanDetailPage'),
  });

  return [list, detail] as const;
}
