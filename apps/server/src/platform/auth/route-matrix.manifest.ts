/**
 * The routes the generated route-matrix suite drives (M02b, D-070).
 *
 * The milestone's gate fails a route that lacks "a declared ability **or** a
 * matrix test". The first half is metadata the gate reads off Nest. The second
 * half is this list: `route-matrix.e2e.test.ts` holds one fixture per entry —
 * how to call the route for real — and drives every entry as every role,
 * asserting the guard admits exactly the roles the matrix grants and that a
 * successful mutation leaves an audit row. The suite also asserts this list,
 * its fixtures and the application's live routes are the same set, so none of
 * the three can drift.
 *
 * `check-route-matrix` then fails any route that declares an ability or
 * mutates but is missing here, and any entry here that no longer exists — so a
 * new route cannot ship without being added to the suite, and the suite cannot
 * quietly keep testing a route that is gone.
 *
 * Public routes are absent on purpose: there is no role to vary. Add a route
 * here in the same commit that adds its fixture to the suite.
 */
export const ROUTE_MATRIX_MANIFEST: readonly string[] = [
  'GET /v1/approvals',
  'GET /v1/approvals/:id',
  'POST /v1/approvals',
  'POST /v1/approvals/:id/decide',
  'PUT /v1/approvals/thresholds',
  'GET /v1/demo/costed-items',
  'POST /v1/demo/costed-items',
  'GET /v1/ledger/accounts',
  'GET /v1/ledger/accounts/:id/ledger',
  'GET /v1/ledger/day-book',
  'GET /v1/ledger/party-balances',
  'GET /v1/ledger/periods',
  'GET /v1/ledger/trial-balance',
  'GET /v1/ledger/wallets',
  'GET /v1/ledger/wallets/:id/cash-book',
  'POST /v1/ledger/cash-in',
  'POST /v1/ledger/periods/close',
  'POST /v1/ledger/periods/reopen',
  'GET /v1/me',
  'POST /v1/me/active-org',
  'GET /v1/me/orgs',
  'POST /v1/users',
];

/** The manifest key for a route, as `describeRoutes` reports it. */
export function routeKey(route: { readonly method: string; readonly path: string }): string {
  return `${route.method} ${route.path}`;
}
