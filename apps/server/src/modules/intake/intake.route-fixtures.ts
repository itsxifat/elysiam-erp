import { randomBytes } from 'node:crypto';

import { SEED_ORG_IDS, withSystem } from '@elysium/db';
import { sql } from 'drizzle-orm';

import { applyIntakeMigrations } from './intake.testing.js';
import { newKeyId } from './signature.js';

/**
 * How the route-matrix suite calls M11's site-key routes (D-070).
 *
 * Thunks, never getters: the suite spreads this map into its own, and a getter would run at
 * module load, before the harness exists. The public intake route is `@Public` and so not in
 * the matrix at all — its authentication is the signature, which `intake.e2e.test.ts`
 * exercises.
 *
 * Revoking needs a fresh key per admitted role, because a key revoked once answers the
 * second role with its already-revoked row — still a 201, but the audit assertion wants a
 * change. The key is written directly: issuing through the route would need the master key
 * the suite's environment may not carry, and what is under test here is only who the guard
 * admits.
 */

interface Call {
  readonly url: string;
  readonly body?: unknown;
}

const ORG_A = SEED_ORG_IDS['elysium-lifestyle-bd'] ?? '';

/** Called once from the route-matrix suite's `beforeAll`. */
export async function prepareIntakeFixtures(): Promise<void> {
  await applyIntakeMigrations();
}

async function freshKey(): Promise<string> {
  return withSystem(
    async (tx) => {
      const rows = await tx.execute<{ id: string }>(sql`
        insert into intake.site_keys (org_id, label, key_id, secret_sha256, created_by)
        values (${ORG_A}, 'Route matrix site', ${newKeyId(ORG_A)},
                ${randomBytes(32).toString('hex')}, 'usr_intake_fixture')
        returning id
      `);
      const id = rows[0]?.id;
      if (id === undefined) throw new Error('seeding a site key returned no id');
      return id;
    },
    { orgId: ORG_A },
  );
}

export const INTAKE_ROUTE_FIXTURES: Readonly<Record<string, () => Promise<Call> | Call>> = {
  'GET /v1/intake/site-keys': () => ({ url: '/v1/intake/site-keys' }),
  'POST /v1/intake/site-keys': () => ({
    url: '/v1/intake/site-keys',
    body: { label: 'Route matrix landing page' },
  }),
  'POST /v1/intake/site-keys/:id/revoke': async () => ({
    url: `/v1/intake/site-keys/${await freshKey()}/revoke`,
  }),
};

/** The manifest entries the integrator appends. */
export const INTAKE_ROUTE_KEYS: readonly string[] = Object.keys(INTAKE_ROUTE_FIXTURES);
