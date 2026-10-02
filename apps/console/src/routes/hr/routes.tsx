import { createRoute, lazyRouteComponent, type AnyRoute } from '@tanstack/react-router';

/**
 * M19's five HR routes, as a factory the router calls.
 *
 * A factory rather than five `createRoute` calls inside `router.tsx`, for the reason M06's
 * catalog routes give: `router.tsx` is edited concurrently by other milestones in this working
 * tree and a second write would silently discard the first. M19's INTEGRATION section hands
 * the integrator the two lines that call this, plus the two paths to drop from the
 * placeholder list; every route below is defined here, in a file this milestone owns.
 *
 * `/people` and `/payroll` are already in M05's `NAVIGATION` as placeholders, so these
 * replace them rather than adding new sidebar entries.
 *
 * Every screen is `lazyRouteComponent`, per `.claude/rules/frontend.md`: the initial route
 * bundle has a 250 KB gzipped budget (M05 check 5), and an ERP that eagerly imports twenty
 * module screens spends it before the first one renders.
 *
 * `/payroll/runs/$runId` is declared **after** the literal `/payroll/loans`, which is the
 * order that matters here: a param route declared first would also match `loans` and the run
 * detail would try to load a payroll run whose id is the word "loans". TanStack ranks literals
 * above params, so this is belt and braces — but the belt is what somebody reads.
 *
 * Generic in the root route with an **inferred** return type: annotating it `AnyRoute[]` would
 * widen the whole router's type and lose `navigate({ params })`'s types on every screen, which
 * is the mistake M06 names.
 */
export function hrRoutes<TRoot extends AnyRoute>(rootRoute: TRoot) {
  const people = createRoute({
    getParentRoute: () => rootRoute,
    path: '/people',
    component: lazyRouteComponent(() => import('./people.js'), 'PeoplePage'),
  });

  const attendance = createRoute({
    getParentRoute: () => rootRoute,
    path: '/people/attendance',
    component: lazyRouteComponent(() => import('./attendance.js'), 'AttendancePage'),
  });

  const payroll = createRoute({
    getParentRoute: () => rootRoute,
    path: '/payroll',
    component: lazyRouteComponent(() => import('./payroll.js'), 'PayrollPage'),
  });

  const loans = createRoute({
    getParentRoute: () => rootRoute,
    path: '/payroll/loans',
    component: lazyRouteComponent(() => import('./loans.js'), 'LoansPage'),
  });

  const run = createRoute({
    getParentRoute: () => rootRoute,
    path: '/payroll/runs/$runId',
    component: lazyRouteComponent(() => import('./run-detail.js'), 'PayrollRunPage'),
  });

  // M20: the performance section. The agent's dashboard, then HR's three screens.
  const performance = createRoute({
    getParentRoute: () => rootRoute,
    path: '/performance',
    component: lazyRouteComponent(() => import('./performance.js'), 'MyPerformancePage'),
  });

  const targets = createRoute({
    getParentRoute: () => rootRoute,
    path: '/performance/targets',
    component: lazyRouteComponent(() => import('./targets.js'), 'TargetsPage'),
  });

  const productivity = createRoute({
    getParentRoute: () => rootRoute,
    path: '/performance/productivity',
    component: lazyRouteComponent(() => import('./productivity.js'), 'ProductivityPage'),
  });

  const bonusRules = createRoute({
    getParentRoute: () => rootRoute,
    path: '/performance/bonus-rules',
    component: lazyRouteComponent(() => import('./bonus-rules.js'), 'BonusRulesPage'),
  });

  return [
    people,
    attendance,
    payroll,
    loans,
    run,
    performance,
    targets,
    productivity,
    bonusRules,
  ] as const;
}
