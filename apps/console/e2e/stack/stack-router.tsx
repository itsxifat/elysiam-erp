import { createRouter, type AnyRoute } from '@tanstack/react-router';

import { ordersRoutes } from '../../src/routes/orders/routes.js';
import { router as integrated } from '../../src/routes/router.js';

/**
 * The console's router, with M11's routes mounted the way INTEGRATION mounts them.
 *
 * Used only by `e2e/stack/vite.config.ts`. If the real router already knows `/orders/new`,
 * the integration has landed and this returns it unchanged. Otherwise it takes the real
 * route tree, drops the `/orders` "coming soon" placeholder (a real route and a placeholder
 * at one path is the ambiguity `router.tsx` itself avoids), and adds `ordersRoutes()` —
 * the same three edits the INTEGRATION lines make.
 */
function withOrders() {
  if ('/orders/new' in integrated.routesById) return integrated;

  const root = integrated.routeTree as AnyRoute;
  const existing = (root.children ?? []) as AnyRoute[];
  const kept = existing.filter((route) => (route.options as { path?: string }).path !== '/orders');
  root.addChildren([...kept, ...ordersRoutes(root)]);

  return createRouter({
    routeTree: root,
    defaultPreload: 'intent',
    defaultPreloadStaleTime: 0,
  });
}

export const router = withOrders() as typeof integrated;
