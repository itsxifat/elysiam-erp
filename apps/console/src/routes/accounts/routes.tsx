import { createRoute, lazyRouteComponent, type AnyRoute } from '@tanstack/react-router';

import { ledgerSearch } from './ledger-search.js';
import { reportsSearch } from './reports-search.js';

/**
 * The Accounts section's routes (M08, with M03's reports and periods), as a factory
 * the router calls, like every other section's.
 *
 * Every screen is `lazyRouteComponent`: the console's first page has a 250 KB
 * budget (`pnpm check:bundle`), and the reports are the heaviest screens in it.
 * The search validators live in their own small modules so the router does not
 * pull a screen into the first page just to read its URL.
 */
export function accountsRoutes<TRoot extends AnyRoute>(rootRoute: TRoot) {
  const cash = createRoute({
    getParentRoute: () => rootRoute,
    path: '/accounts',
    component: lazyRouteComponent(() => import('./accounts-page.js'), 'AccountsPage'),
  });

  const transfers = createRoute({
    getParentRoute: () => rootRoute,
    path: '/accounts/transfers',
    component: lazyRouteComponent(() => import('./transfers.js'), 'TransfersPage'),
  });

  const setup = createRoute({
    getParentRoute: () => rootRoute,
    path: '/accounts/wallets',
    component: lazyRouteComponent(() => import('./wallets.js'), 'WalletsSetupPage'),
  });

  const wallet = createRoute({
    getParentRoute: () => rootRoute,
    path: '/accounts/wallets/$accountId',
    validateSearch: (search: Record<string, unknown>): { from?: string; to?: string } => ({
      ...(typeof search.from === 'string' ? { from: search.from } : {}),
      ...(typeof search.to === 'string' ? { to: search.to } : {}),
    }),
    component: lazyRouteComponent(() => import('./cash-book.js'), 'CashBookPage'),
  });

  const reports = createRoute({
    getParentRoute: () => rootRoute,
    path: '/accounts/reports',
    validateSearch: reportsSearch,
    component: lazyRouteComponent(() => import('./reports.js'), 'ReportsPage'),
  });

  const ledger = createRoute({
    getParentRoute: () => rootRoute,
    path: '/accounts/ledger',
    validateSearch: ledgerSearch,
    component: lazyRouteComponent(() => import('./ledger.js'), 'LedgerPage'),
  });

  const periods = createRoute({
    getParentRoute: () => rootRoute,
    path: '/accounts/periods',
    component: lazyRouteComponent(() => import('./periods.js'), 'PeriodsPage'),
  });

  const consolidated = createRoute({
    getParentRoute: () => rootRoute,
    path: '/accounts/consolidated',
    validateSearch: (search: Record<string, unknown>): { from?: string; to?: string } => ({
      ...(typeof search.from === 'string' ? { from: search.from } : {}),
      ...(typeof search.to === 'string' ? { to: search.to } : {}),
    }),
    component: lazyRouteComponent(() => import('./consolidated.js'), 'ConsolidatedPage'),
  });

  return [cash, transfers, setup, wallet, reports, ledger, periods, consolidated] as const;
}
