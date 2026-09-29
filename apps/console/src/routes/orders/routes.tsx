import { createRoute, lazyRouteComponent, type AnyRoute } from '@tanstack/react-router';

import { buyerSearchSchema, orderListSearchSchema } from './search.js';

/**
 * M11's five order routes, as a factory the router calls.
 *
 * A factory rather than `createRoute` calls in `router.tsx`, for the reason every module
 * since M06 gives: that file is edited concurrently, and a second write discards the first.
 * M11's INTEGRATION section hands the integrator the lines that call this and the path to
 * drop from the placeholder list (`/orders` is already in `NAVIGATION`).
 *
 * Every screen is `lazyRouteComponent` (`.claude/rules/frontend.md`, M05 check 5's bundle
 * budget). The literal children — `/orders/new`, `/orders/queue`, `/orders/buyers` — are
 * declared before the param route `/orders/$orderId`, so "new" is never read as an order
 * id; TanStack ranks literals first anyway, and the order is what a reader checks.
 *
 * `validateSearch` on the two lists: their filters are a public interface the moment they
 * are in the address bar, and a hand-edited one must fall back to the default view.
 */
export function ordersRoutes<TRoot extends AnyRoute>(rootRoute: TRoot) {
  const list = createRoute({
    getParentRoute: () => rootRoute,
    path: '/orders',
    validateSearch: orderListSearchSchema,
    component: lazyRouteComponent(() => import('./order-list.js'), 'OrderListPage'),
  });

  const desk = createRoute({
    getParentRoute: () => rootRoute,
    path: '/orders/new',
    component: lazyRouteComponent(() => import('./order-desk.js'), 'OrderDeskPage'),
  });

  const queue = createRoute({
    getParentRoute: () => rootRoute,
    path: '/orders/queue',
    component: lazyRouteComponent(() => import('./queue.js'), 'OrderQueuePage'),
  });

  const buyers = createRoute({
    getParentRoute: () => rootRoute,
    path: '/orders/buyers',
    validateSearch: buyerSearchSchema,
    component: lazyRouteComponent(() => import('./buyers.js'), 'BuyerListPage'),
  });

  const detail = createRoute({
    getParentRoute: () => rootRoute,
    path: '/orders/$orderId',
    component: lazyRouteComponent(() => import('./order-detail.js'), 'OrderDetailPage'),
  });

  return [list, desk, queue, buyers, detail] as const;
}
