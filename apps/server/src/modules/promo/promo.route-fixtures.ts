import { randomUUID } from 'node:crypto';

import { SEED_ORG_IDS, withSystem } from '@elysium/db';
import { sql } from 'drizzle-orm';

/**
 * The route-matrix suite's calls for M16's promo routes.
 *
 * Every fixture is a thunk, evaluated once per role after `preparePromoFixtures()` has
 * run, so a fresh code per call is possible and nothing reads state at import time — the
 * shape `pos.route-fixtures.ts` established.
 *
 * The fixtures do not try to succeed; the suite's question is which roles the *guard*
 * admits. Two things shape the answers here:
 *
 * - **`POST /v1/promo/codes` needs a distinct code per call.** `promo_codes_org_code_idx`
 *   is unique per org, so a fixed word would answer 409 to every admitted role after the
 *   first, and 409 is an admission the suite would have to special-case.
 * - **`POST /v1/promo/check` answers 404 for a code nobody created.** That is still an
 *   admission by the guard, which is what is being measured; the seeded code below exists
 *   so the path is exercised against a real row rather than only against a miss.
 */

interface Call {
  readonly url: string;
  readonly body?: unknown;
}

const ORG_A = SEED_ORG_IDS['elysium-lifestyle-bd'] ?? '';

let seededCodeId = '';
let seededCode = '';

function token(length: number): string {
  return randomUUID().replace(/-/g, '').slice(0, length).toUpperCase();
}

/** One code that exists, so the read and check routes have a real row to name. */
export async function preparePromoFixtures(): Promise<void> {
  seededCode = `MATRIX${token(6)}`;
  seededCodeId = await withSystem(
    async (tx) => {
      const rows = await tx.execute<{ id: string }>(sql`
        insert into promo.codes (org_id, code, kind, value_bps, created_by)
        values (${ORG_A}, ${seededCode}, 'percent', 1000, 'usr_route_matrix')
        returning id
      `);
      return rows[0]?.id ?? '';
    },
    { orgId: ORG_A },
  );
}

export const PROMO_ROUTE_FIXTURES: Readonly<Record<string, () => Promise<Call> | Call>> = {
  'GET /v1/promo/codes': () => ({ url: '/v1/promo/codes' }),
  'POST /v1/promo/codes': () => ({
    url: '/v1/promo/codes',
    body: { code: `MATRIX${token(6)}`, kind: 'percent', valueBps: 500 },
  }),
  'PATCH /v1/promo/codes/:id': () => ({
    url: `/v1/promo/codes/${seededCodeId}`,
    // Paused rather than archived: the suite runs this once per admitted role, and
    // pausing an already-paused code is idempotent.
    body: { status: 'paused' },
  }),
  'GET /v1/promo/codes/:id/redemptions': () => ({
    url: `/v1/promo/codes/${seededCodeId}/redemptions`,
  }),
  'POST /v1/promo/check': () => ({
    url: '/v1/promo/check',
    body: {
      code: seededCode,
      lines: [{ skuId: randomUUID(), netPoisha: '100000' }],
      deliveryChargePoisha: '6000',
      channel: 'desk',
    },
  }),
};

export const PROMO_ROUTE_KEYS: readonly string[] = Object.keys(PROMO_ROUTE_FIXTURES);
