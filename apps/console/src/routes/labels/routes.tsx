import { createRoute, lazyRouteComponent, type AnyRoute } from '@tanstack/react-router';

/**
 * M46's two areas (D-800), as a factory the router calls: Labels (the label desks: ready for
 * label, the queue, the print log, printers, terminals and the print station) and Packaging
 * (to pack, the packing station, packed, the handover, terminals and cameras). Each tab is the
 * page's `?tab=`, read by the page itself; both pages are lazy (M05 check 5's budget).
 */
export function labelsRoutes<TRoot extends AnyRoute>(rootRoute: TRoot) {
  const labels = createRoute({
    getParentRoute: () => rootRoute,
    path: '/labels',
    component: lazyRouteComponent(() => import('./labels-page.js'), 'LabelsPage'),
  });
  const packaging = createRoute({
    getParentRoute: () => rootRoute,
    path: '/packaging',
    component: lazyRouteComponent(() => import('./packaging-page.js'), 'PackagingPage'),
  });
  // D-904: the courier portal, a page of its own for the person at the rider's desk.
  const courierPortal = createRoute({
    getParentRoute: () => rootRoute,
    path: '/courier-portal',
    component: lazyRouteComponent(() => import('./courier-portal.js'), 'CourierPortalPage'),
  });
  return [labels, packaging, courierPortal] as const;
}
