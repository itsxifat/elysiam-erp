import { createHash, randomUUID } from 'node:crypto';

import { SEED_ORG_IDS, withGlobal, withSystem } from '@elysium/db';
import { sql } from 'drizzle-orm';

/**
 * How the route-matrix suite and the cost sweep call M35b's packing routes (D-070): the
 * console's scanner lookup and devices, and the label sheet (asked for an order that does not
 * exist, so no role's call needs Gotenberg; `packing.e2e.test.ts` renders a real one).
 */

interface Call {
  readonly url: string;
  readonly body?: unknown;
}

const ORG_A = SEED_ORG_IDS['elysium-lifestyle-bd'] ?? '';
const FIXTURE_USER = 'usr_packing_fixture';

/** A person to own the devices a revocation is tried on; idempotent. */
export async function preparePackingFixtures(): Promise<void> {
  await withGlobal(async (tx) => {
    await tx.execute(sql`
      insert into iam.users (id, email, name, email_verified)
      values (${FIXTURE_USER}, 'packing-fixture@example.invalid', 'Packing fixture', true)
      on conflict (id) do nothing
    `);
  });
}

async function insertDevice(): Promise<string> {
  return withSystem(
    async (tx) =>
      (
        await tx.execute<{ id: string }>(sql`
          insert into packing.scanner_devices (org_id, user_id, label, token_sha256, via, expires_at)
          values (${ORG_A}, ${FIXTURE_USER}, 'Fixture phone',
                  ${createHash('sha256').update(randomUUID()).digest('hex')}, 'console',
                  now() + interval '30 days')
          returning id
        `)
      )[0]?.id ?? '',
    { orgId: ORG_A },
  );
}

export const PACKING_ROUTE_FIXTURES: Readonly<Record<string, () => Promise<Call> | Call>> = {
  'GET /v1/scanner/lookup': () => ({ url: '/v1/scanner/lookup?code=NO-SUCH-PARCEL' }),
  'GET /v1/scanner/devices': () => ({ url: '/v1/scanner/devices' }),
  'POST /v1/scanner/devices': () => ({
    url: '/v1/scanner/devices',
    body: { deviceName: 'Matrix' },
  }),
  'POST /v1/scanner/devices/:id/revoke': async () => ({
    url: `/v1/scanner/devices/${await insertDevice()}/revoke`,
  }),
  'POST /v1/packing/labels': () => ({
    url: '/v1/packing/labels',
    body: { orderIds: [randomUUID()], size: 'a4' },
  }),
};
