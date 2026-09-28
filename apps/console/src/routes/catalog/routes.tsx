import { createRoute, lazyRouteComponent, type AnyRoute } from '@tanstack/react-router';

import { tableSearchSchema } from '../../lib/table-search.js';

/**
 * The catalog's four routes, as a factory the router calls.
 *
 * A factory rather than four `createRoute` calls inside `router.tsx`, because
 * `router.tsx` is edited concurrently by other milestones in this working tree and
 * a second write would silently discard the first. M06's INTEGRATION section hands
 * the integrator the two lines that call this; every route below is defined here, in
 * a file this milestone owns.
 *
 * Every screen is `lazyRouteComponent`, per `.claude/rules/frontend.md`: the initial
 * route bundle has a 250 KB gzipped budget (M05 check 5) and an ERP that eagerly
 * imports twenty module screens spends it before the first one renders.
 *
 * `/catalog` and `/catalog/import` carry `validateSearch`, and the list route needs
 * it for more than tidiness: the search params are a public interface the moment
 * they are in the address bar, so `?page=-4` has to degrade to the default view
 * rather than reach the API as a 400 that reads like a server fault.
 *
 * The order matters. `/catalog/new` is declared before `/catalog/$productId` so the
 * literal wins over the parameter — otherwise "new" is parsed as a product id and
 * the create screen is a 404 that looks like a permissions problem.
 */
/**
 * Generic in the root route, with an **inferred** return type.
 *
 * Annotating this `AnyRoute[]` is the mistake worth naming: `addChildren` infers the
 * whole router's type from its children, so one `AnyRoute` in that array widens the
 * route tree and `navigate({ search })` loses its types — on *every* screen, not
 * only these. It surfaced as five errors each in the approvals and table demo
 * screens, which had not been touched.
 */
export function catalogRoutes<TRoot extends AnyRoute>(rootRoute: TRoot) {
  const list = createRoute({
    getParentRoute: () => rootRoute,
    path: '/catalog',
    validateSearch: tableSearchSchema,
    component: lazyRouteComponent(() => import('./products.js'), 'CatalogProductsPage'),
  });

  const structure = createRoute({
    getParentRoute: () => rootRoute,
    path: '/catalog/structure',
    component: lazyRouteComponent(() => import('./structure.js'), 'CatalogStructurePage'),
  });

  const importPrices = createRoute({
    getParentRoute: () => rootRoute,
    path: '/catalog/import',
    component: lazyRouteComponent(() => import('./import.js'), 'CatalogImportPage'),
  });

  const create = createRoute({
    getParentRoute: () => rootRoute,
    path: '/catalog/new',
    component: lazyRouteComponent(() => import('./new-product.js'), 'CatalogNewProductPage'),
  });

  const detail = createRoute({
    getParentRoute: () => rootRoute,
    path: '/catalog/$productId',
    component: lazyRouteComponent(() => import('./product-detail.js'), 'CatalogProductPage'),
  });

  return [list, structure, importPrices, create, detail] as const;
}
