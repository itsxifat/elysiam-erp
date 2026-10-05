/**
 * The route-matrix suite's calls for M24's analytics routes.
 *
 * Every fixture is a thunk, evaluated once per role; the suite's question is which roles
 * the guard admits. Each one is repeatable by every admitted role:
 *
 * - the refresh recomputes three long-past days, which a rerun replaces rather than adds to;
 * - the narrative answers `{ enabled: false }`, because the flag is off by default (D-327).
 */

interface Call {
  readonly url: string;
  readonly body?: unknown;
}

export const ANALYTICS_ROUTE_FIXTURES: Readonly<Record<string, () => Promise<Call> | Call>> = {
  'GET /v1/analytics/dashboard': () => ({
    url: '/v1/analytics/dashboard?from=2026-09-01&to=2026-09-30',
  }),
  'GET /v1/analytics/insights': () => ({ url: '/v1/analytics/insights?month=2026-09' }),
  'GET /v1/analytics/narrative': () => ({ url: '/v1/analytics/narrative?month=2026-09' }),
  'POST /v1/analytics/rollups/refresh': () => ({
    url: '/v1/analytics/rollups/refresh',
    body: { from: '2001-01-01', to: '2001-01-03' },
  }),
  'GET /v1/analytics/export': () => ({
    url: '/v1/analytics/export?from=2026-09-01&to=2026-09-30&format=csv',
  }),
};

export const ANALYTICS_ROUTE_KEYS: readonly string[] = Object.keys(ANALYTICS_ROUTE_FIXTURES);
