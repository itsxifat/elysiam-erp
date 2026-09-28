import { randomUUID } from 'node:crypto';

import { withOrg, withSystem } from '@elysium/db';
import { sql } from 'drizzle-orm';

import { SEED_ORG_IDS } from '@elysium/db';
import {
  applyInventoryMigrations,
  makeLocation,
  seedProductWithSkus,
  warehouseId,
} from './inventory.testing.js';

/**
 * How the route-matrix suite calls M07's routes (M02b's D-070 gate).
 *
 * `route-matrix.e2e.test.ts` asserts that its fixture keys, the manifest and the
 * application's live routes are the same three sets — so the moment
 * `InventoryModule` is registered in `app.module.ts`, that suite fails until these
 * exist. They live here rather than in the suite because the suite is one file shared
 * by every milestone building in parallel, and a second write to it silently discards
 * the first; the integrator adds one import and one spread.
 *
 * The fixtures deliberately do **not** try to succeed. The suite's question is which
 * roles the *guard* admits, so a 404 or a 409 from a handler is as good as a 201 —
 * what matters is that it is not a 403. The exceptions are the mutations, which the
 * suite also checks leave an audit row, so those are given real ids to work on.
 *
 * `prepare()` is idempotent and cheap after the first call: it applies this
 * milestone's migrations (the journal is integrated separately) and seeds one product
 * and one location.
 */

interface Call {
  readonly url: string;
  readonly body?: unknown;
}

const ORG_A = SEED_ORG_IDS['elysium-lifestyle-bd'] ?? '';

interface Fixtures {
  readonly warehouseLocation: string;
  readonly showroomLocation: string;
  readonly skuId: string;
  readonly countId: string;
  readonly transferId: string;
  readonly adjustmentId: string;
}

let prepared: Fixtures | undefined;

/** Called once from the route-matrix suite's `beforeAll`. */
export async function prepareInventoryFixtures(): Promise<void> {
  if (prepared !== undefined) return;
  await applyInventoryMigrations();

  const warehouseLocation = await warehouseId(ORG_A);
  const branch = await withSystem(
    async (tx) => {
      const rows = await tx.execute<{ id: string }>(sql`
        select id from org.branches where org_id = ${ORG_A} and code = 'HQ'
      `);
      return rows[0]?.id ?? null;
    },
    { orgId: ORG_A },
  );
  const showroomLocation = await makeLocation(ORG_A, {
    code: 'SHR-RM',
    name: 'Route matrix showroom',
    kind: 'showroom',
    branchId: branch,
  });
  await makeLocation(ORG_A, {
    code: 'TRANSIT-RM',
    name: 'Route matrix transit',
    kind: 'in_transit',
  });

  const { skus } = await seedProductWithSkus(ORG_A, 'routematrix', 1);
  const skuId = skus[0]?.id ?? '';

  /*
   * An open count and a dispatched transfer, written directly.
   *
   * The suite drives `PUT /counts/:id/lines` and `POST /transfers/:id/receive` as
   * every role, and a route whose id does not exist answers 404 for everybody —
   * which would make the guard's decision invisible. These rows exist so the
   * admitted roles get past the handler far enough to be audited.
   */
  const ids = await withOrg({ orgId: ORG_A, userId: 'usr_route_matrix' }, async (tx) => {
    const count = await tx.execute<{ id: string }>(sql`
      insert into inventory.count_sessions (org_id, location_id, branch_id, created_by)
      values (${ORG_A}, ${warehouseLocation}, ${branch}::uuid, 'usr_route_matrix')
      returning id
    `);
    const countId = count[0]?.id ?? '';
    await tx.execute(sql`
      insert into inventory.count_lines (org_id, session_id, sku_id, snapshot_qty)
      values (${ORG_A}, ${countId}, ${skuId}, 0)
    `);

    const transitRows = await tx.execute<{ id: string }>(sql`
      select id from org.locations where org_id = ${ORG_A} and kind = 'in_transit' limit 1
    `);
    const transfer = await tx.execute<{ id: string }>(sql`
      insert into inventory.stock_transfers
        (org_id, from_location_id, to_location_id, transit_location_id, created_by)
      values (${ORG_A}, ${warehouseLocation}, ${showroomLocation},
              ${transitRows[0]?.id ?? warehouseLocation}, 'usr_route_matrix')
      returning id
    `);

    return { countId, transferId: transfer[0]?.id ?? '' };
  });

  prepared = {
    warehouseLocation,
    showroomLocation,
    skuId,
    countId: ids.countId,
    transferId: ids.transferId,
    // No adjustment is pre-made: every adjustment route here creates its own.
    adjustmentId: randomUUID(),
  };
}

function state(): Fixtures {
  if (prepared === undefined) {
    throw new Error('call prepareInventoryFixtures() in the suite’s beforeAll first');
  }
  return prepared;
}

export const INVENTORY_ROUTE_FIXTURES: Readonly<Record<string, () => Promise<Call> | Call>> = {
  'GET /v1/inventory/locations': () => ({ url: '/v1/inventory/locations' }),
  'POST /v1/inventory/locations': () => ({
    url: '/v1/inventory/locations',
    // A fresh code per call: the suite runs each fixture once per role, and a
    // duplicate code would answer 400 for the second admitted role.
    body: {
      code: `RM-${randomUUID().slice(0, 6).toUpperCase()}`,
      name: 'Route matrix warehouse',
      kind: 'warehouse',
    },
  }),
  'PATCH /v1/inventory/locations/:id': () => ({
    url: `/v1/inventory/locations/${state().warehouseLocation}`,
    body: { name: 'Main Warehouse' },
  }),
  'GET /v1/inventory/stock': () => ({ url: '/v1/inventory/stock' }),
  'GET /v1/inventory/valuation': () => ({ url: '/v1/inventory/valuation' }),
  'GET /v1/inventory/movements': () => ({ url: '/v1/inventory/movements' }),
  'PUT /v1/inventory/reorder-levels': () => ({
    url: '/v1/inventory/reorder-levels',
    body: { skuId: state().skuId, locationId: state().warehouseLocation, reorderLevel: 3 },
  }),
  'GET /v1/inventory/adjustments': () => ({ url: '/v1/inventory/adjustments' }),
  'POST /v1/inventory/adjustments': () => ({
    url: '/v1/inventory/adjustments',
    // A gain rather than a loss: a loss needs stock on the shelf, and this fixture's
    // SKU has none — the guard's answer is the same either way, and a gain gets far
    // enough to be audited.
    body: {
      locationId: state().warehouseLocation,
      direction: 'gain',
      reason: 'Route matrix fixture',
      lines: [{ skuId: state().skuId, qty: 1 }],
    },
  }),
  'GET /v1/inventory/transfers': () => ({ url: '/v1/inventory/transfers' }),
  'POST /v1/inventory/transfers': () => ({
    url: '/v1/inventory/transfers',
    body: {
      fromLocationId: state().warehouseLocation,
      toLocationId: state().showroomLocation,
      lines: [{ skuId: state().skuId, qty: 1 }],
    },
  }),
  'POST /v1/inventory/transfers/:id/receive': () => ({
    url: `/v1/inventory/transfers/${state().transferId}/receive`,
  }),
  'GET /v1/inventory/counts': () => ({ url: '/v1/inventory/counts' }),
  'GET /v1/inventory/counts/:id': () => ({ url: `/v1/inventory/counts/${state().countId}` }),
  'POST /v1/inventory/counts': () => ({
    url: '/v1/inventory/counts',
    // The partial unique index allows one open count per location, so each call
    // needs its own: a second open count at the same location answers 409 for
    // everybody after the first admitted role.
    body: { locationId: state().warehouseLocation },
  }),
  'PUT /v1/inventory/counts/:id/lines': () => ({
    url: `/v1/inventory/counts/${state().countId}/lines`,
    body: { lines: [{ skuId: state().skuId, countedQty: 0 }] },
  }),
  'POST /v1/inventory/counts/:id/submit': () => ({
    url: `/v1/inventory/counts/${state().countId}/submit`,
  }),
  'POST /v1/inventory/counts/:id/close': () => ({
    url: `/v1/inventory/counts/${state().countId}/close`,
  }),
  'GET /v1/inventory/reconciliations': () => ({ url: '/v1/inventory/reconciliations' }),
};

/** The manifest entries the integrator appends, derived from the fixtures. */
export const INVENTORY_ROUTE_KEYS: readonly string[] = Object.keys(INVENTORY_ROUTE_FIXTURES);
