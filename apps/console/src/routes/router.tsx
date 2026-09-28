import { EmptyState } from '@elysium/ui';
import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Link,
} from '@tanstack/react-router';

import { catalogRoutes } from './catalog/routes.js';
import { hrRoutes } from './hr/routes.js';
import { investorsRoutes } from './investors/routes.js';
import { stockRoutes } from './stock/routes.js';
import { supplyRoutes } from './supply/routes.js';
import { AppShell } from '../shell/app-shell.js';
import { useT } from '../i18n/locale.js';
import { tableSearchSchema } from '../lib/table-search.js';
import { NAVIGATION } from '../shell/navigation.js';

/**
 * The console's route tree (M05 Build list, check 5).
 *
 * **Every screen is code-split.** `.claude/rules/frontend.md` says so, and check 5
 * puts a number on why: the initial route bundle has a 250 KB gzipped budget, and
 * an ERP that eagerly imports twenty module screens spends it before the first
 * screen renders. `lazyRouteComponent` makes each one its own chunk, and the
 * router prefetches on intent, so the split costs nothing perceptible.
 *
 * **Routes are declared in code rather than generated from files.** The file-route
 * convention needs `@tanstack/router-plugin`, which this repo's pnpm catalog does
 * not carry; adding it means editing `pnpm-workspace.yaml`, which is shared with
 * other agents this session. The API is the same one the generated tree would
 * produce, so converting later is mechanical — recorded as D-118.
 *
 * `validateSearch` is on every list route, and it is what makes check 2 safe as
 * well as true: the search params are a public interface the moment they are in
 * the address bar, so a hand-edited `?page=-4` has to degrade to the default view
 * rather than reach the API.
 */

const rootRoute = createRootRoute({ component: AppShell, notFoundComponent: NotFound });

const overviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: lazyRouteComponent(() => import('./overview.js'), 'OverviewPage'),
});

const approvalsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/approvals',
  validateSearch: tableSearchSchema,
  component: lazyRouteComponent(() => import('./approvals.js'), 'ApprovalsPage'),
});

const tablesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/tables',
  validateSearch: tableSearchSchema,
  component: lazyRouteComponent(() => import('./tables.js'), 'TablesPage'),
});

/**
 * A route per navigation entry whose module has not been built yet.
 *
 * They exist so the CASL-driven sidebar is honest: a link the router does not know
 * lands on the not-found screen, which reads as a broken application rather than
 * as "this module arrives in M06". Each is replaced by its module's own route, and
 * because the path is taken from `NAVIGATION` there is no second list to keep in
 * step — a nav entry without a route is impossible by construction.
 */
/**
 * M06 owns `/catalog` and its children, defined in `./catalog/routes.tsx`.
 *
 * Declared before the placeholders and excluded from them below: a nav entry with
 * both a real route and a "coming soon" placeholder is an ambiguous match, and the
 * one TanStack Router picks is not the one anybody intended.
 */
const catalog = catalogRoutes(rootRoute);

/**
 * M07 owns `/stock` and its children, defined in `./stock/routes.tsx`.
 *
 * Declared beside the catalog's and excluded from the placeholders below for the same
 * reason: a nav entry with both a real route and a "coming soon" placeholder is an
 * ambiguous match, and the one TanStack Router picks is not the one anybody intended.
 */
const stock = stockRoutes(rootRoute);

/**
 * M09 owns `/supply` and its children, defined in `./supply/routes.tsx`.
 *
 * Excluded from the placeholders below like the other two: a nav entry with both a real
 * route and a "coming soon" placeholder is an ambiguous match, and the one TanStack
 * Router picks is not the one anybody intended.
 */
const supply = supplyRoutes(rootRoute);

/**
 * M19 owns `/people` and `/payroll`; M25 owns `/investors`.
 *
 * Excluded from the placeholders below like the others: a nav entry with both a real
 * route and a "coming soon" placeholder is an ambiguous match.
 */
const hr = hrRoutes(rootRoute);
const investors = investorsRoutes(rootRoute);

const placeholderRoutes = NAVIGATION.flatMap((section) => section.items)
  .filter(
    (item) =>
      ![
        '/',
        '/approvals',
        '/tables',
        '/catalog',
        '/stock',
        '/supply',
        '/people',
        '/payroll',
        '/investors',
      ].includes(item.to),
  )
  .map((item) =>
    createRoute({
      getParentRoute: () => rootRoute,
      path: item.to,
      component: () => <ComingSoon labelKey={item.labelKey} />,
    }),
  );

const routeTree = rootRoute.addChildren([
  overviewRoute,
  approvalsRoute,
  ...(import.meta.env.DEV ? [tablesRoute] : []),
  ...catalog,
  ...stock,
  ...supply,
  ...hr,
  ...investors,
  ...placeholderRoutes,
]);

export const router = createRouter({
  routeTree,
  // Prefetch a route's chunk when the pointer or keyboard lands on its link, so
  // code splitting does not become a visible pause on every first navigation.
  defaultPreload: 'intent',
  defaultPreloadStaleTime: 0,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

function ComingSoon({ labelKey }: { readonly labelKey: Parameters<ReturnType<typeof useT>>[0] }) {
  const t = useT();
  return (
    <div className="space-y-5">
      <h1 className="text-lg font-semibold tracking-tight">{t(labelKey)}</h1>
      <EmptyState title={t(labelKey)} detail={t('overview.shellNote')} />
    </div>
  );
}

function NotFound() {
  const t = useT();
  return (
    <EmptyState
      title={t('notFound.title')}
      detail={t('notFound.detail')}
      action={
        <Link
          to="/"
          className="text-sm font-medium text-primary underline-offset-4 hover:underline"
        >
          {t('notFound.home')}
        </Link>
      }
    />
  );
}
