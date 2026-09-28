import { SEED_ORG_IDS, withOrg } from '@elysium/db';
import { sql } from 'drizzle-orm';

import { applyFraudMigrations, TEST_HASH_KEY } from './fraud.testing.js';

/**
 * How the route-matrix suite calls M13's routes (M02b's D-070 gate).
 *
 * `route-matrix.e2e.test.ts` asserts that its fixture keys, the manifest and the
 * application's live routes are the same three sets — so the moment `FraudModule` is
 * registered in `app.module.ts`, that suite fails until these exist. They live here rather
 * than in the suite because the suite is one file shared by every milestone building in
 * parallel, and a second write to it silently discards the first; the integrator adds one
 * import and one spread.
 *
 * The fixtures deliberately do **not** try to succeed. The suite's question is which roles
 * the *guard* admits, so a 404 or a 400 from a handler is as good as a 200 — what matters is
 * that it is not a 403. The mutations are given bodies that would work, because the suite
 * also checks a successful mutation leaves an audit row.
 *
 * `prepare()` is idempotent and cheap after the first call.
 */

const ORG_A = SEED_ORG_IDS['elysium-lifestyle-bd'] ?? '';

/**
 * A fixture number, and not a real one.
 *
 * `017` followed by a run of one digit is not in any operator's issued block, and invariant
 * 10 forbids a real number in a fixture — the route-matrix suite drives every route as
 * every role, so this number would end up in a great many rows.
 */
const FIXTURE_PHONE = '01700000009';

interface Call {
  readonly url: string;
  readonly body?: unknown;
}

let preparedFlagId: string | undefined;

/** Called once from the route-matrix suite's `beforeAll`. */
export async function prepareFraudFixtures(): Promise<void> {
  if (preparedFlagId !== undefined) return;

  // The config provider is a factory that reads the environment at `app.init()`, so the key
  // has to be present before the harness builds the module graph. Set rather than required,
  // because the gate boots the app with no infrastructure at all.
  process.env.FRAUD_PHONE_HASH_KEY ??= TEST_HASH_KEY;

  await applyFraudMigrations();

  /*
   * A standing flag for the clear route to act on, written directly.
   *
   * Through `withOrg` rather than `withSystem`: `fraud.phone_flags` is a tenant table with
   * FORCE RLS, so an uncontexted insert is refused even for the owner — and using the
   * application role here means the fixture exercises the same policy the application does.
   *
   * The hash is written literally rather than computed, because computing it would mean
   * constructing `PhoneHashService` — which needs the config provider, which the harness
   * owns. 64 hex characters is all the check constraint asks for, and this row exists only
   * to be cleared.
   */
  const flagId = await withOrg({ orgId: ORG_A, userId: 'route-matrix' }, async (tx) => {
    const rows = await tx.execute<{ id: string }>(sql`
      insert into fraud.phone_flags (org_id, phone_hash, severity, reason, created_by)
      values (${ORG_A}, ${'a'.repeat(64)}, 1, 'route matrix fixture', 'route-matrix')
      returning id
    `);
    return rows[0]?.id ?? '';
  });

  preparedFlagId = flagId;
}

function flagId(): string {
  if (preparedFlagId === undefined) {
    throw new Error('prepareFraudFixtures() must run in the suite’s beforeAll');
  }
  return preparedFlagId;
}

/**
 * One entry per manifest line, keyed exactly as `routeKey` renders it.
 *
 * `POST /v1/fraud/flags/:id/clear` is the only one that needs a prepared row. The others
 * work against whatever the database holds, because a badge for an unknown number is a valid
 * answer and a rules write is an upsert.
 */
export const FRAUD_ROUTE_FIXTURES: Readonly<Record<string, () => Call>> = {
  'GET /v1/fraud/check': () => ({ url: `/v1/fraud/check?phone=${FIXTURE_PHONE}` }),
  'GET /v1/fraud/rules': () => ({ url: '/v1/fraud/rules' }),
  'PUT /v1/fraud/rules': () => ({
    url: '/v1/fraud/rules',
    body: {
      allowMin: 70,
      warnMin: 40,
      requireAdvanceMin: 20,
      providerEnabled: false,
      providerTtlMinutes: 4_320,
    },
  }),
  'POST /v1/fraud/flags': () => ({
    url: '/v1/fraud/flags',
    body: { phone: FIXTURE_PHONE, severity: 1, reason: 'route matrix' },
  }),
  // Every entry is a thunk, including the ones that need no prepared state.
  //
  // The suite spreads these maps into its own object literal, so a getter would be
  // *invoked* by the spread — at module load, long before `prepareFraudFixtures` has run —
  // and `flagId()` would throw before a single test started. A thunk is not called until
  // the suite drives the route, which is also the contract the other modules' fixture
  // files follow.
  'POST /v1/fraud/flags/:id/clear': () => ({
    url: `/v1/fraud/flags/${flagId()}/clear`,
    body: { reason: 'route matrix' },
  }),
  'GET /v1/fraud/orders/:orderId/overrides': () => ({
    // A uuid that names nothing. An empty list is the right answer and is not a 403, which is
    // the only thing the suite is asking.
    url: '/v1/fraud/orders/00000000-0000-4000-8000-000000000000/overrides',
  }),
};

/** The manifest lines these fixtures cover, for the INTEGRATION notes. */
export const FRAUD_ROUTES: readonly string[] = [
  'GET /v1/fraud/check',
  'GET /v1/fraud/orders/:orderId/overrides',
  'GET /v1/fraud/rules',
  'POST /v1/fraud/flags',
  'POST /v1/fraud/flags/:id/clear',
  'PUT /v1/fraud/rules',
];
