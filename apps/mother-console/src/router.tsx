import { EmptyState } from '@elysium/ui';
import { isMonth } from '@elysium/domain';
import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Link,
} from '@tanstack/react-router';

import { useT } from './i18n/locale.js';
import { Shell } from './shell/shell.js';
import { validateRangeSearch } from './ui/range.js';

/**
 * The owner console's screens (D-480), each its own chunk, with the period in the
 * address bar so a link opens the same view.
 */

function NotFound() {
  const t = useT();
  return (
    <EmptyState
      title={t('common.notFound')}
      detail={t('common.notFoundDetail')}
      action={
        <Link to="/" className="text-sm text-primary underline-offset-4 hover:underline">
          {t('common.backHome')}
        </Link>
      }
    />
  );
}

const root = createRootRoute({ component: Shell, notFoundComponent: NotFound });

const overview = createRoute({
  getParentRoute: () => root,
  path: '/',
  validateSearch: validateRangeSearch,
  component: lazyRouteComponent(() => import('./routes/overview.js'), 'OverviewPage'),
});

const leaderboard = createRoute({
  getParentRoute: () => root,
  path: '/leaderboard',
  validateSearch: (search: Record<string, unknown>): { month?: string } =>
    typeof search.month === 'string' && isMonth(search.month) ? { month: search.month } : {},
  component: lazyRouteComponent(() => import('./routes/leaderboard.js'), 'LeaderboardPage'),
});

const accounts = createRoute({
  getParentRoute: () => root,
  path: '/accounts',
  validateSearch: validateRangeSearch,
  component: lazyRouteComponent(() => import('./routes/accounts.js'), 'AccountsPage'),
});

const brandPage = createRoute({
  getParentRoute: () => root,
  path: '/brands/$brandId',
  validateSearch: validateRangeSearch,
  component: lazyRouteComponent(() => import('./routes/brand.js'), 'BrandPage'),
});

const brandsSettings = createRoute({
  getParentRoute: () => root,
  path: '/settings/brands',
  component: lazyRouteComponent(() => import('./routes/brands.js'), 'BrandsPage'),
});

const people = createRoute({
  getParentRoute: () => root,
  path: '/settings/people',
  component: lazyRouteComponent(() => import('./routes/people.js'), 'PeoplePage'),
});

const activity = createRoute({
  getParentRoute: () => root,
  path: '/activity',
  component: lazyRouteComponent(() => import('./routes/activity.js'), 'ActivityPage'),
});

export const router = createRouter({
  routeTree: root.addChildren([
    overview,
    leaderboard,
    accounts,
    brandPage,
    brandsSettings,
    people,
    activity,
  ]),
  defaultPreload: 'intent',
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
