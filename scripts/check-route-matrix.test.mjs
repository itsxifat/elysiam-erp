import { describe, expect, it } from 'vitest';

import { checkRoutes } from './check-route-matrix.mjs';

/**
 * The route gate's rules (M02b check 6, D-070), without booting the app.
 *
 * Check 6 itself — add an undeclared route, watch `pnpm check:routes` fail,
 * revert — is demonstrated against the real application in the Verification
 * Report. These pin each rule so a refactor of the gate cannot quietly drop one.
 */

const keyOf = (route) => `${route.method} ${route.path}`;

function route(overrides) {
  return {
    controller: 'C',
    handler: 'h',
    method: 'GET',
    path: '/v1/things',
    declared: 'read:Order',
    ability: { action: 'read', subject: 'Order' },
    problem: null,
    ...overrides,
  };
}

describe('check-route-matrix rules', () => {
  it('passes a declared route that the matrix suite drives', () => {
    expect(checkRoutes([route({})], ['GET /v1/things'], keyOf)).toEqual([]);
  });

  it('fails a route that declares nothing', () => {
    const failures = checkRoutes([route({ declared: null, ability: null })], [], keyOf);
    expect(failures.join('\n')).toMatch(/declares no ability/);
  });

  it('fails a route with contradictory declarations', () => {
    const failures = checkRoutes(
      [route({ declared: null, problem: 'the handler declares both @Public and an ability' })],
      ['GET /v1/things'],
      keyOf,
    );
    expect(failures.join('\n')).toMatch(/contradictory/);
  });

  it('fails a declared route with no matrix test', () => {
    const failures = checkRoutes([route({})], [], keyOf);
    expect(failures.join('\n')).toMatch(/has no matrix test/);
  });

  it('fails an authenticated-only mutation with no matrix test too', () => {
    const failures = checkRoutes(
      [route({ method: 'POST', declared: 'authenticated', ability: null })],
      [],
      keyOf,
    );
    expect(failures.join('\n')).toMatch(/has no matrix test/);
  });

  it('does not ask a public route for a matrix test', () => {
    expect(checkRoutes([route({ declared: 'public:health', ability: null })], [], keyOf)).toEqual(
      [],
    );
  });

  it('fails a manifest entry whose route is gone', () => {
    const failures = checkRoutes([route({})], ['GET /v1/things', 'GET /v1/gone'], keyOf);
    expect(failures.join('\n')).toMatch(/GET \/v1\/gone: in the manifest, but no such route/);
  });
});
