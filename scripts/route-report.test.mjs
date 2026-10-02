import { describe, expect, it } from 'vitest';

import { pathPattern, renderReport } from './route-report.mjs';

/**
 * The route report's matching (M30 check 3), without booting the application.
 */

const keyOf = (route) => `${route.method} ${route.path}`;

function route(overrides) {
  return {
    controller: 'C',
    handler: 'h',
    method: 'GET',
    path: '/v1/orders/:id',
    declared: 'read:Order',
    ability: { action: 'read', subject: 'Order' },
    problem: null,
    ...overrides,
  };
}

describe('route report', () => {
  it('matches a parameter however the test spells it, and only to the end of the path', () => {
    const pattern = pathPattern('/v1/orders/:id');
    expect(pattern.test("request('GET', `/v1/orders/${id}`)")).toBe(true);
    expect(pattern.test("request('GET', '/v1/orders/0d4e-uuid?expand=1')")).toBe(true);
    expect(pattern.test('request(`/v1/orders/${id}/confirm`)')).toBe(false);
    expect(pathPattern('/v1/orders').test("'/v1/orders/agents'")).toBe(false);
    expect(pathPattern('/v1/orders').test("'/v1/orders?limit=5'")).toBe(true);
  });

  it('names the fixture file and the feature tests, and lists matrix-only routes', () => {
    const { markdown, counts } = renderReport({
      routes: [
        route({}),
        route({ method: 'POST', path: '/v1/orders/:id/confirm', declared: 'update:Order' }),
        route({ path: '/health/live', declared: 'public:liveness', ability: null }),
      ],
      manifest: ['GET /v1/orders/:id', 'POST /v1/orders/:id/confirm'],
      routeKey: keyOf,
      sources: [
        {
          file: 'apps/server/src/modules/orders/orders.route-fixtures.ts',
          text: "'GET /v1/orders/:id': () => ({}), 'POST /v1/orders/:id/confirm': () => ({})",
        },
        {
          file: 'apps/server/src/modules/orders/orders.e2e.test.ts',
          text: "client.request('GET', `/v1/orders/${id}`)",
        },
        { file: 'apps/server/src/modules/health/health.e2e.test.ts', text: "'/health/live'" },
      ],
      generatedAt: '2026-10-02',
      commit: 'abc1234',
    });

    expect(counts).toMatchObject({ routes: 3, public: 1, matrix: 2, noFeatureTest: 1 });
    expect(markdown).toContain(
      '| GET | `/v1/orders/:id` | read:Order | orders.route-fixtures.ts | orders.e2e.test.ts |',
    );
    expect(markdown).toContain(
      '| GET | `/health/live` | public:liveness | — | health.e2e.test.ts |',
    );
    expect(markdown).toContain('- `POST /v1/orders/:id/confirm` (update:Order)');
  });

  it('names the module suites beside the controller of a route with no HTTP test', () => {
    const { markdown } = renderReport({
      routes: [route({ controller: 'CatalogController', path: '/v1/catalog/categories' })],
      manifest: ['GET /v1/catalog/categories'],
      routeKey: keyOf,
      sources: [
        {
          file: 'apps/server/src/modules/catalog/catalog.db.test.ts',
          text: 'service-level tests',
        },
      ],
      generatedAt: '2026-10-02',
      commit: 'abc1234',
      controllerFiles: new Map([
        ['CatalogController', 'apps/server/src/modules/catalog/catalog.controller.ts'],
      ]),
    });
    expect(markdown).toContain('- `GET /v1/catalog/categories` (read:Order): catalog.db.test.ts');
  });

  it('counts an undeclared route so the command can fail on it', () => {
    const { counts } = renderReport({
      routes: [route({ declared: null, ability: null })],
      manifest: [],
      routeKey: keyOf,
      sources: [],
      generatedAt: '2026-10-02',
      commit: 'abc1234',
    });
    expect(counts.undeclared).toBe(1);
  });
});
