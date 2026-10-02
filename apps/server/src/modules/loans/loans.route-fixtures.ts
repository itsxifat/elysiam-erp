import { randomUUID } from 'node:crypto';

import { SEED_ORG_IDS, seedAccountId, withSystem } from '@elysium/db';
import { sql } from 'drizzle-orm';

/**
 * How the route-matrix suite calls M26's loan routes (M02b's D-070 gate).
 *
 * The suite asks which roles the guard admits, so a 404 from a handler is as good as a 201;
 * what matters is that it is not a 403. Mutations get a fresh uuid per call, because the
 * suite runs each fixture once per role and the second admitted role must not be answered
 * from the first's row. `GET /:id` and `POST /:id/payments` name a loan that does not
 * exist: an admitted role gets 404, a refused one 403.
 */

interface Call {
  readonly url: string;
  readonly body?: unknown;
}

const ORG_A = SEED_ORG_IDS['elysium-lifestyle-bd'] ?? '';
const BANK = seedAccountId(ORG_A, '1100');

let lenderId: string | undefined;

/** Called once from the route-matrix suite's `beforeAll`. */
export async function prepareLoanFixtures(): Promise<void> {
  if (lenderId !== undefined) return;
  lenderId = await withSystem(
    async (tx) => {
      const rows = await tx.execute<{ id: string }>(sql`
        insert into loans.lenders (org_id, name, kind, created_by)
        values (${ORG_A}, 'Route Matrix Bank', 'bank', 'usr_route_matrix')
        returning id
      `);
      const id = rows[0]?.id;
      if (id === undefined) throw new Error('could not seed the route-matrix lender');
      return id;
    },
    { orgId: ORG_A },
  );
}

function lender(): string {
  if (lenderId === undefined) throw new Error('call prepareLoanFixtures() in beforeAll first');
  return lenderId;
}

export const LOANS_ROUTE_FIXTURES: Readonly<Record<string, () => Promise<Call> | Call>> = {
  'GET /v1/loans/lenders': () => ({ url: '/v1/loans/lenders' }),
  'POST /v1/loans/lenders': () => ({
    url: '/v1/loans/lenders',
    body: { name: 'Route Matrix Lender', kind: 'person' },
  }),
  'POST /v1/loans/preview': () => ({
    url: '/v1/loans/preview',
    body: { principalPoisha: '1000000', rateBps: 1200, method: 'reducing', tenureMonths: 3 },
  }),
  'GET /v1/loans': () => ({ url: '/v1/loans' }),
  'POST /v1/loans': () => ({
    url: '/v1/loans',
    body: {
      loanId: randomUUID(),
      lenderId: lender(),
      principalPoisha: '1000000',
      rateBps: 1200,
      method: 'reducing',
      tenureMonths: 3,
      walletAccountId: BANK,
    },
  }),
  'GET /v1/loans/:id': () => ({ url: `/v1/loans/${randomUUID()}` }),
  'POST /v1/loans/:id/payments': () => ({
    url: `/v1/loans/${randomUUID()}/payments`,
    body: { paymentId: randomUUID(), instalmentId: randomUUID(), walletAccountId: BANK },
  }),
};
