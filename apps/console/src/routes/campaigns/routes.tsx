import { createRoute, lazyRouteComponent, type AnyRoute } from '@tanstack/react-router';

/**
 * The campaign screens: discounts and flash sales (M16, M35a), and the notify module's
 * templates, opt-outs and delivery log. A factory the router calls, as every module since
 * M06 does. Every screen is lazy: the initial route keeps its 250 KB budget.
 *
 * `/campaigns/flash-sales/new` is declared before `/campaigns/flash-sales/$saleId` so the
 * literal wins over the parameter.
 */
export function campaignsRoutes<TRoot extends AnyRoute>(rootRoute: TRoot) {
  const codes = createRoute({
    getParentRoute: () => rootRoute,
    path: '/campaigns',
    component: lazyRouteComponent(() => import('./discounts.js'), 'DiscountsPage'),
  });

  const flashSales = createRoute({
    getParentRoute: () => rootRoute,
    path: '/campaigns/flash-sales',
    component: lazyRouteComponent(() => import('./flash-sales.js'), 'FlashSalesPage'),
  });

  const newFlashSale = createRoute({
    getParentRoute: () => rootRoute,
    path: '/campaigns/flash-sales/new',
    component: lazyRouteComponent(() => import('./flash-sale-editor.js'), 'NewFlashSalePage'),
  });

  const flashSale = createRoute({
    getParentRoute: () => rootRoute,
    path: '/campaigns/flash-sales/$saleId',
    component: lazyRouteComponent(() => import('./flash-sale-editor.js'), 'FlashSaleEditorPage'),
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

  return [codes, flashSales, newFlashSale, flashSale, templates, optOuts, log] as const;
}
