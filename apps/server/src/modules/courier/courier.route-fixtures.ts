import { randomUUID } from 'node:crypto';

import { SEED_ORG_IDS, withSystem } from '@elysium/db';
import { sql } from 'drizzle-orm';

import {
  applyCourierMigrations,
  makeBankWallet,
  makeCourier,
  seedShippedOrder,
} from './courier.testing.js';

/**
 * How the route-matrix suite calls M12's routes (M02b's D-070 gate).
 *
 * `route-matrix.e2e.test.ts` asserts that its fixture keys, the manifest and the application's
 * live routes are the same three sets — so the moment `CourierModule` is registered in
 * `app.module.ts`, that suite fails until these exist. They live here rather than in the suite
 * because the suite is one file shared by every milestone building in parallel, and a second
 * write to it silently discards the first; the integrator adds one import and one spread.
 *
 * The fixtures deliberately do **not** try to succeed. The suite's question is which roles the
 * *guard* admits, so a 404 or a 409 from a handler is as good as a 201 — what matters is that
 * it is not a 403. The exceptions are the mutations, which the suite also checks leave an audit
 * row, so those are given real ids to work on.
 *
 * The webhook route is **absent on purpose**: it is `@Public`, so there is no role to vary, and
 * the manifest excludes public routes for that reason. Its authenticity is tested in
 * `courier.db.test.ts`, which is where a wrong secret can be shown to store nothing.
 *
 * `prepare()` is idempotent and cheap after the first call.
 */

interface Call {
  readonly url: string;
  readonly body?: unknown;
}

const ORG_A = SEED_ORG_IDS['elysium-lifestyle-bd'] ?? '';

interface Fixtures {
  readonly courierId: string;
  readonly walletId: string;
  readonly orderId: string;
  readonly skuId: string;
  readonly consignmentId: string;
  readonly settlementId: string;
}

let prepared: Fixtures | undefined;

/** Called once from the route-matrix suite's `beforeAll`. */
export async function prepareCourierFixtures(): Promise<void> {
  if (prepared !== undefined) return;

  // M15's migrations, until the integrator registers them in the journal (guarded, idempotent).
  await applyCourierMigrations();

  const courierId = await makeCourier(ORG_A, 'fake', 'Fake Courier');
  const walletId = await makeBankWallet(ORG_A, '1115');
  const order = await seedShippedOrder(ORG_A, { orgCode: 'RMX' });

  /*
   * A consignment and a settlement, written directly.
   *
   * Both are this module's own create paths, which `courier.db.test.ts` drives properly. Here
   * they exist only so the read and the sub-resource routes have a real id to be refused or
   * served for — a fixture pointing at a random uuid would 404 for every role and prove nothing
   * about the ones that should have been admitted.
   */
  const { consignmentId, settlementId } = await withSystem(
    async (tx) => {
      const accountRows = await tx.execute<{ id: string }>(sql`
        insert into courier.courier_accounts
          (org_id, courier_id, provider_code, label, supports_webhook, settlement_wallet_id,
           verified, is_active)
        values (${ORG_A}, ${courierId}, 'fake', 'Route matrix courier', true, ${walletId},
                true, true)
        on conflict (org_id, courier_id) do update set label = excluded.label
        returning id
      `);
      const accountId = accountRows[0]?.id ?? '';

      const consignmentRows = await tx.execute<{ id: string }>(sql`
        insert into courier.consignments
          (org_id, order_id, courier_account_id, courier_id, branch_id, consignment_no,
           reference, booking_state, status, cod_amount_poisha, collected_poisha, booked_at,
           delivered_at, created_by)
        values (${ORG_A}, ${order.orderId}, ${accountId}, ${courierId}, ${order.branchId},
                ${`RMX-${randomUUID().slice(0, 8)}`}, ${order.orderNo}, 'booked', 'delivered',
                ${order.codAmountPoisha.toString()}, ${order.codAmountPoisha.toString()},
                now(), now(), 'usr_route_matrix')
        returning id
      `);

      const settlementRows = await tx.execute<{ id: string }>(sql`
        insert into courier.settlements
          (org_id, courier_account_id, courier_id, reference, settlement_date, wallet_id,
           file_gross_poisha, file_charges_poisha, file_net_poisha, file_row_count,
           matched_gross_poisha, matched_charges_poisha, matched_delivery_charges_poisha,
           matched_return_charges_poisha, matched_other_charges_poisha, matched_net_poisha,
           matched_row_count, exception_count, imported_by)
        values (${ORG_A}, ${accountId}, ${courierId}, 'RMX-S1', current_date, ${walletId},
                1000, 100, 900, 1, 1000, 100, 100, 0, 0, 900, 1, 0, 'usr_route_matrix')
        returning id
      `);

      return {
        consignmentId: consignmentRows[0]?.id ?? '',
        settlementId: settlementRows[0]?.id ?? '',
      };
    },
    { orgId: ORG_A },
  );

  prepared = {
    courierId,
    walletId,
    orderId: order.orderId,
    skuId: order.skuId,
    consignmentId,
    settlementId,
  };
}

function fixtures(): Fixtures {
  if (prepared === undefined) {
    throw new Error('call prepareCourierFixtures() in the suite’s beforeAll first');
  }
  return prepared;
}

/**
 * One entry per manifest line, keyed exactly as `routeKey` builds it.
 *
 * A `POST` with no body is given `{}` rather than nothing: the global pipeline parses the body
 * before the guard runs, so a missing body would 400 before the guard had a chance to refuse —
 * and a 400 for every role is a fixture that tests nothing.
 */
export const COURIER_ROUTE_FIXTURES: Readonly<Record<string, () => Call>> = {
  'GET /v1/courier/accounts': () => ({ url: '/v1/courier/accounts' }),
  'GET /v1/courier/providers': () => ({ url: '/v1/courier/providers' }),
  'POST /v1/courier/accounts': () => ({
    url: '/v1/courier/accounts',
    body: {
      courierId: fixtures().courierId,
      providerCode: 'fake',
      label: 'Route matrix courier',
      mode: 'sandbox',
      pollAfterHours: 6,
      settlementWalletId: fixtures().walletId,
      isActive: false,
    },
  }),

  'POST /v1/courier/parcels': () => ({
    url: '/v1/courier/parcels',
    body: { orderId: fixtures().orderId, courierId: fixtures().courierId },
  }),
  'GET /v1/courier/parcels/:id': () => ({ url: `/v1/courier/parcels/${fixtures().consignmentId}` }),
  'POST /v1/courier/parcels/:id/handover': () => ({
    url: `/v1/courier/parcels/${fixtures().consignmentId}/handover`,
    body: {},
  }),
  'POST /v1/courier/parcels/:id/status': () => ({
    url: `/v1/courier/parcels/${fixtures().consignmentId}/status`,
    body: {
      status: 'in_transit',
      rawStatus: 'moving',
      reason: 'The courier sync has not caught up.',
    },
  }),
  'GET /v1/courier/parcels/:id/returnable': () => ({
    url: `/v1/courier/parcels/${fixtures().consignmentId}/returnable`,
  }),
  'POST /v1/courier/parcels/:id/receive-return': () => ({
    url: `/v1/courier/parcels/${fixtures().consignmentId}/receive-return`,
    body: {
      reason: 'Customer refused at the door.',
      returnReason: 'customer_refused',
      lines: [{ skuId: fixtures().skuId, sellableQty: 1, damagedQty: 0 }],
    },
  }),

  'GET /v1/courier/settlements': () => ({ url: '/v1/courier/settlements' }),
  'GET /v1/courier/settlements/:id': () => ({
    url: `/v1/courier/settlements/${fixtures().settlementId}`,
  }),
  'GET /v1/courier/settlements/:id/exceptions': () => ({
    url: `/v1/courier/settlements/${fixtures().settlementId}/exceptions`,
  }),
  'POST /v1/courier/settlements': () => ({
    url: '/v1/courier/settlements',
    body: {
      courierId: fixtures().courierId,
      walletId: fixtures().walletId,
      fileName: 'fake-2026-03-31-S9001.csv',
      // A one-row statement that matches nothing, so the handler refuses for a reason that has
      // nothing to do with the caller's role.
      fileBase64: Buffer.from('consignment_id,cod_amount\nRMX-NOPE,100.00\n', 'utf8').toString(
        'base64',
      ),
    },
  }),
  'POST /v1/courier/settlements/:id/approval': () => ({
    url: `/v1/courier/settlements/${fixtures().settlementId}/approval`,
    body: {},
  }),
  'POST /v1/courier/settlements/:id/reject': () => ({
    url: `/v1/courier/settlements/${fixtures().settlementId}/reject`,
    body: { reason: 'The courier is re-issuing this statement.' },
  }),

  'GET /v1/courier/reports/cod-reconciliation': () => ({
    url: '/v1/courier/reports/cod-reconciliation',
  }),

  // --- M15 ---------------------------------------------------------------------
  //
  // The mutations below are chosen to succeed without enqueueing, like M12's booking fixture
  // (whose order already has a live parcel): the route-matrix harness starts no pg-boss
  // runtime, and an `enqueue` there would be a 500 that says nothing about the guard.

  'GET /v1/courier/parcels': () => ({ url: '/v1/courier/parcels?pageSize=5' }),
  'POST /v1/courier/parcels/bulk': () => ({
    url: '/v1/courier/parcels/bulk',
    // The fixture order already has a live parcel, so the booking returns it and queues nothing.
    body: { orderIds: [fixtures().orderId] },
  }),
  'GET /v1/courier/labels': () => ({
    url: `/v1/courier/labels?ids=${fixtures().consignmentId}`,
  }),
  'GET /v1/courier/selection/preview': () => ({
    url: `/v1/courier/selection/preview?orderId=${fixtures().orderId}`,
  }),
  'GET /v1/courier/selection-rules': () => ({ url: '/v1/courier/selection-rules' }),
  'PUT /v1/courier/selection-rules': () => ({
    url: '/v1/courier/selection-rules',
    // An empty set: a valid save that routes nothing differently for the suites after this one.
    body: { rules: [] },
  }),
  'GET /v1/courier/stuck': () => ({ url: '/v1/courier/stuck?thresholdDays=3' }),
  'GET /v1/courier/stuck/export': () => ({ url: '/v1/courier/stuck/export?thresholdDays=3' }),
  'POST /v1/courier/stuck/repoll': () => ({
    url: '/v1/courier/stuck/repoll',
    // Delivered, so nothing is pollable and nothing is queued — a 200 with `queued: 0`.
    body: { consignmentIds: [fixtures().consignmentId] },
  }),
  'POST /v1/courier/parcels/:id/escalations': () => ({
    url: `/v1/courier/parcels/${fixtures().consignmentId}/escalations`,
    body: { note: 'Asked the hub about this parcel.' },
  }),
  'POST /v1/courier/settlements/fetch': () => ({
    url: '/v1/courier/settlements/fetch',
    // A courier with no account: refused with a 404 before anything is queued.
    body: { courierId: randomUUID() },
  }),
  'GET /v1/courier/settlements/fetch-runs': () => ({ url: '/v1/courier/settlements/fetch-runs' }),
  'GET /v1/courier/reports/performance': () => ({ url: '/v1/courier/reports/performance' }),
};

/** The manifest lines M12 and M15 add, in the order they appear above. */
export const COURIER_ROUTE_KEYS: readonly string[] = Object.keys(COURIER_ROUTE_FIXTURES);

/** M15's thirteen, for the INTEGRATION notes and the module's own HTTP smoke test. */
export const COURIER_M15_ROUTE_KEYS: readonly string[] = COURIER_ROUTE_KEYS.slice(
  COURIER_ROUTE_KEYS.indexOf('GET /v1/courier/parcels'),
);
