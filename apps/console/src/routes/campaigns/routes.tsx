import { createRoute, lazyRouteComponent, type AnyRoute } from '@tanstack/react-router';

/**
 * M16's campaign screens: promo codes, and the notify module's templates, opt-outs and
 * delivery log. A factory the router calls, as every module since M06 does.
 */
export function campaignsRoutes<TRoot extends AnyRoute>(rootRoute: TRoot) {
  const codes = createRoute({
    getParentRoute: () => rootRoute,
    path: '/campaigns',
    component: lazyRouteComponent(() => import('./promo-codes.js'), 'PromoCodesPage'),
  });

  const templates = createRoute({
    getParentRoute: () => rootRoute,
    path: '/campaigns/templates',
    component: lazyRouteComponent(() => import('./templates.js'), 'TemplatesPage'),
  });

  const optOuts = createRoute({
    getParentRoute: () => rootRoute,
    path: '/campaigns/opt-outs',
    component: lazyRouteComponent(() => import('./opt-outs.js'), 'OptOutsPage'),
  });

  const log = createRoute({
    getParentRoute: () => rootRoute,
    path: '/campaigns/log',
    component: lazyRouteComponent(() => import('./delivery-log.js'), 'DeliveryLogPage'),
  });

  return [codes, templates, optOuts, log] as const;
}
