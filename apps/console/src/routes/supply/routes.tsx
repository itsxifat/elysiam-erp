import { createRoute, lazyRouteComponent, type AnyRoute } from '@tanstack/react-router';

/**
 * M09's five supply routes, as a factory the router calls.
 *
 * A factory rather than five `createRoute` calls inside `router.tsx`, for the reason M06's
 * catalog routes give: `router.tsx` is edited concurrently by other milestones in this
 * working tree and a second write would silently discard the first. M09's INTEGRATION
 * section hands the integrator the two lines that call this; every route below is defined
 * here, in a file this milestone owns.
 *
 * Every screen is `lazyRouteComponent`, per `.claude/rules/frontend.md`: the initial route
 * bundle has a 250 KB gzipped budget (M05 check 5), and an ERP that eagerly imports twenty
 * module screens spends it before the first one renders.
 *
 * `/supply/suppliers/$supplierId` is declared after the literal children, which is what
 * keeps `/supply/entries` from matching it. Generic in the root route with an **inferred**
 * return type: annotating it `AnyRoute[]` would widen the whole router's type and lose
 * `navigate({ params })`'s types on every screen, which is the mistake M06 names.
 */
export function supplyRoutes<TRoot extends AnyRoute>(rootRoute: TRoot) {
  const suppliers = createRoute({
    getParentRoute: () => rootRoute,
    path: '/supply',
    component: lazyRouteComponent(() => import('./suppliers.js'), 'SuppliersPage'),
  });

  const entries = createRoute({
    getParentRoute: () => rootRoute,
    path: '/supply/entries',
    component: lazyRouteComponent(() => import('./entries.js'), 'SupplyEntriesPage'),
  });

  const returns = createRoute({
    getParentRoute: () => rootRoute,
    path: '/supply/returns',
    component: lazyRouteComponent(() => import('./returns.js'), 'SupplyReturnsPage'),
  });

  const payments = createRoute({
    getParentRoute: () => rootRoute,
    path: '/supply/payments',
    component: lazyRouteComponent(() => import('./payments.js'), 'SupplyPaymentsPage'),
  });

  // M39b (D-638): the standard buying price spreadsheet.
  const buyingPrices = createRoute({
    getParentRoute: () => rootRoute,
    path: '/supply/buying-prices',
    component: lazyRouteComponent(() => import('./buying-prices.js'), 'SupplyBuyingPricesPage'),
  });

  const supplier = createRoute({
    getParentRoute: () => rootRoute,
    path: '/supply/suppliers/$supplierId',
    component: lazyRouteComponent(() => import('./supplier-detail.js'), 'SupplierDetailPage'),
  });

  return [suppliers, entries, returns, payments, buyingPrices, supplier] as const;
}
