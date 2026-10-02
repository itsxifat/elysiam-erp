import { createRoute, lazyRouteComponent, type AnyRoute } from '@tanstack/react-router';
import { z } from 'zod';

import { RFM_SEGMENTS } from './api.js';

/**
 * M16's buyer screens, as a factory the router calls (the arrangement every module since
 * M06 uses). `/customers/lapsed` is declared before the param route so "lapsed" is never
 * read as a buyer's id.
 */

export const CUSTOMER_PAGE_SIZE = 25;
export const LAPSED_PAGE_SIZE = 50;

/** A hand-edited address bar falls back to the default view rather than an error. */
export const customerSearchSchema = z.object({
  q: z.string().trim().min(2).max(64).optional().catch(undefined),
  page: z.coerce.number().int().min(1).max(4_000).catch(1).default(1),
});
export type CustomerSearch = z.infer<typeof customerSearchSchema>;

export const lapsedSearchSchema = z.object({
  days: z.coerce.number().int().min(1).max(3_650).catch(90).default(90),
  minDelivered: z.coerce.number().int().min(1).max(1_000).catch(1).default(1),
  segment: z.enum(RFM_SEGMENTS).optional().catch(undefined),
  page: z.coerce.number().int().min(1).max(20_000).catch(1).default(1),
});
export type LapsedSearch = z.infer<typeof lapsedSearchSchema>;

export function customersRoutes<TRoot extends AnyRoute>(rootRoute: TRoot) {
  const list = createRoute({
    getParentRoute: () => rootRoute,
    path: '/customers',
    validateSearch: customerSearchSchema,
    component: lazyRouteComponent(() => import('./customers-page.js'), 'CustomersPage'),
  });

  const lapsed = createRoute({
    getParentRoute: () => rootRoute,
    path: '/customers/lapsed',
    validateSearch: lapsedSearchSchema,
    component: lazyRouteComponent(() => import('./lapsed.js'), 'LapsedBuyersPage'),
  });

  const profile = createRoute({
    getParentRoute: () => rootRoute,
    path: '/customers/$customerId',
    component: lazyRouteComponent(() => import('./profile.js'), 'BuyerProfilePage'),
  });

  return [list, lapsed, profile] as const;
}
