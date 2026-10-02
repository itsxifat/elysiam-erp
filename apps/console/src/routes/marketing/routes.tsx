import { createRoute, lazyRouteComponent, type AnyRoute } from '@tanstack/react-router';

/**
 * M18's marketing screens: the dashboard, campaigns, spend, leads and their segments, and
 * the Meta link with the conversion log. A factory the router calls, as every module since
 * M06 does; each screen is its own chunk, and the dashboard's chart is a further one.
 */
export function marketingRoutes<TRoot extends AnyRoute>(rootRoute: TRoot) {
  const page = (path: string, load: () => Promise<Record<string, unknown>>, name: string) =>
    createRoute({
      getParentRoute: () => rootRoute,
      path,
      component: lazyRouteComponent(load as never, name as never),
    });

  return [
    page('/marketing', () => import('./dashboard.js'), 'MarketingDashboardPage'),
    page('/marketing/campaigns', () => import('./campaigns.js'), 'MarketingCampaignsPage'),
    page('/marketing/spend', () => import('./spend.js'), 'MarketingSpendPage'),
    page('/marketing/leads', () => import('./leads.js'), 'MarketingLeadsPage'),
    page('/marketing/segments', () => import('./leads.js'), 'MarketingSegmentsPage'),
    page('/marketing/meta', () => import('./meta.js'), 'MarketingMetaPage'),
  ] as const;
}
