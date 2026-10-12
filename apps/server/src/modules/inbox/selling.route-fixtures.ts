import { randomUUID } from 'node:crypto';

import { SEED_ORG_IDS, withSystem } from '@elysium/db';
import { sql } from 'drizzle-orm';

/**
 * How the route-matrix suite and the cost sweep call M44b's selling routes (D-070): the picker
 * by a word every seeded catalog has and by an id, the brand's facts, and a size chart made for
 * the call. All reads, so every admitted role gets a 200 and the cost sweep reads a real answer.
 */

interface Call {
  readonly url: string;
  readonly body?: unknown;
}

const ORG_A = SEED_ORG_IDS['elysium-lifestyle-bd'] ?? '';

async function anyProductId(): Promise<string> {
  return withSystem(
    async (tx) =>
      (
        await tx.execute<{ id: string }>(sql`
          select id from catalog.products where org_id = ${ORG_A} order by created_at limit 1
        `)
      )[0]?.id ?? randomUUID(),
    { orgId: ORG_A },
  );
}

async function sizeChartId(): Promise<string> {
  return withSystem(
    async (tx) =>
      (
        await tx.execute<{ id: string }>(sql`
          insert into storefront.size_charts (org_id, name, columns, rows)
          values (${ORG_A}, ${`Matrix chart ${randomUUID().slice(0, 8)}`},
                  array['Size', 'Chest'], '[["M", "40"], ["L", "42"]]'::jsonb)
          returning id
        `)
      )[0]?.id ?? randomUUID(),
    { orgId: ORG_A },
  );
}

export const SELLING_ROUTE_FIXTURES: Readonly<Record<string, () => Promise<Call> | Call>> = {
  'GET /v1/inbox/selling-context': () => ({ url: '/v1/inbox/selling-context' }),
  'GET /v1/inbox/products': async () => ({
    url: `/v1/inbox/products?ids=${await anyProductId()}`,
  }),
  'GET /v1/inbox/size-charts/:id': async () => ({
    url: `/v1/inbox/size-charts/${await sizeChartId()}`,
  }),
};
