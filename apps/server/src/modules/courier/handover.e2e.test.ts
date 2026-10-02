import { randomUUID } from 'node:crypto';

import { findCostFields } from '@elysium/contracts';
import { withSystem } from '@elysium/db';
import { sql } from 'drizzle-orm';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { JobsRuntime } from '../../platform/jobs/jobs.runtime.js';
import {
  ORG_A,
  startHttpHarness,
  type HttpHarness,
  type InjectedResponse,
  type RoleClient,
} from '../../testing/http-harness.js';
import { seedProductWithSkus, warehouseId } from '../inventory/inventory.testing.js';
import {
  applyOrderMigrations,
  seedCustomer,
  seedStockLevel,
  trialBalanceDifference,
} from '../orders/orders.testing.js';
import { COURIER_QUEUE_DEFINITIONS } from './courier.queues.js';
import { applyCourierMigrations, makeCourier } from './courier.testing.js';
import { CourierSyncService } from './sync.service.js';

/**
 * The console gaps' server half, over HTTP against real Postgres (D-390 to D-396).
 *
 * Everything runs through the full application — guard, scope, serializer, audit — with the
 * real orders, courier, inventory and ledger modules, so a courier status that ships an order
 * is proven to post the same journals, in the same order, as a person pressing the buttons:
 *
 * 1. **A courier status ships an order nobody marked shipped (D-390).** A `delivered` reaching
 *    a `packed` order ships it and delivers it in one transaction: two status events, the
 *    handover journal and then the delivery journal, the parcel's collection recorded, the
 *    trial balance at zero. The same status again changes nothing. `hold` changes nothing.
 * 2. **Confirming the handover ships the order (D-391)**, once: the handover journal is
 *    posted by whichever of the two comes first, and Ship after it is refused as a move the
 *    order has already made.
 * 3. **The order detail lists the moves §9 allows from where it is (D-392).**
 * 4. **Bulk pack (D-393)** reports each order's outcome against its id.
 * 5. **The read routes the settings and HR screens need (D-394 to D-396)**, including that the
 *    HR wallet list carries no balance.
 */

let harness: HttpHarness;
let jobs: JobsRuntime | undefined;
let admin: RoleClient;
let hr: RoleClient;

let location = '';
let customerId = '';
let courierId = '';
let accountId = '';
let skuId = '';

beforeAll(async () => {
  harness = await startHttpHarness('gaps-handover');
  await applyOrderMigrations();
  await applyCourierMigrations();
  // The webhook route enqueues its job in the same transaction as the stored body, which
  // needs the courier's queues registered. Registered, not worked: `courierSays` runs the
  // handler itself, so no background worker races the assertions (as `courier.m15.db.test`).
  jobs = await JobsRuntime.start({
    role: 'worker',
    connectionString: harness.database.ownerUrl,
    appRole: 'erp_app',
    queues: COURIER_QUEUE_DEFINITIONS,
    logger: pino({ level: 'silent' }),
    pollingIntervalSeconds: 0.5,
  });

  location = await warehouseId(ORG_A);
  customerId = await seedCustomer(ORG_A, { phoneE164: '+8801711987654', name: 'Nusrat Jahan' });
  const { skus } = await seedProductWithSkus(ORG_A, 'gapshandover', 1);
  const [sku] = skus;
  if (sku === undefined) throw new Error('no SKU seeded');
  skuId = sku.id;
  await seedStockLevel(ORG_A, { skuId, locationId: location, qty: 100, unitCostPoisha: 40_000n });

  courierId = await makeCourier(ORG_A, 'fake', 'Fake Courier');
  accountId = await withSystem(
    async (tx) => {
      const rows = await tx.execute<{ id: string }>(sql`
        insert into courier.courier_accounts
          (org_id, courier_id, provider_code, label, supports_webhook, verified, is_active)
        values (${ORG_A}, ${courierId}, 'fake', 'Gaps courier', true, true, true)
        on conflict (org_id, courier_id) do update set label = excluded.label
        returning id
      `);
      return rows[0]?.id ?? '';
    },
    { orgId: ORG_A },
  );

  admin = await harness.asRole('org_admin', ORG_A);
  hr = await harness.asRole('hr', ORG_A);
}, 420_000);

afterAll(async () => {
  await jobs?.stop();
  await harness?.close();
}, 60_000);

function body<T>(response: InjectedResponse): T {
  return JSON.parse(response.body) as T;
}

/** An order taken, confirmed and (unless told otherwise) packed, through the real routes. */
async function orderAt(status: 'confirmed' | 'packed'): Promise<{ id: string; cod: bigint }> {
  const created = await admin.client.request('POST', '/v1/orders', {
    body: {
      channel: 'phone',
      customerId,
      locationId: location,
      courierId,
      deliveryChargePoisha: '6000',
      lines: [{ skuId, qty: 1, unitPricePoisha: '150000' }],
    },
  });
  expect(created.statusCode, created.body).toBe(201);
  const { id, codAmountPoisha } = body<{ id: string; codAmountPoisha: string }>(created);
  const confirmed = await admin.client.request('POST', `/v1/orders/${id}/confirm`);
  expect(confirmed.statusCode, confirmed.body).toBe(201);
  if (status === 'packed') {
    const packed = await admin.client.request('POST', `/v1/orders/${id}/pack`);
    expect(packed.statusCode, packed.body).toBe(201);
  }
  return { id, cod: BigInt(codAmountPoisha) };
}

/** A booked parcel for the order, as the booking worker would have left it. */
async function bookedParcel(orderId: string, cod: bigint): Promise<string> {
  return withSystem(
    async (tx) => {
      const rows = await tx.execute<{ id: string }>(sql`
        insert into courier.consignments
          (org_id, order_id, courier_account_id, courier_id, branch_id, consignment_no,
           reference, booking_state, status, cod_amount_poisha, booked_at, created_by)
        select ${ORG_A}, o.id, ${accountId}, ${courierId}, o.branch_id,
               ${`GAP-${randomUUID().slice(0, 8)}`}, o.order_no, 'booked', 'booked',
               ${cod.toString()}, now(), 'usr_gaps_test'
        from sales.orders o where o.org_id = ${ORG_A} and o.id = ${orderId}
        returning id
      `);
      const id = rows[0]?.id;
      if (id === undefined) throw new Error('no parcel inserted');
      return id;
    },
    { orgId: ORG_A },
  );
}

async function orderStatus(orderId: string): Promise<string> {
  const response = await admin.client.request('GET', `/v1/orders/${orderId}`);
  expect(response.statusCode).toBe(200);
  return body<{ status: string }>(response).status;
}

async function journalKeys(orderId: string): Promise<string[]> {
  const rows = await withSystem(
    async (tx) =>
      tx.execute<{ idempotency_key: string }>(sql`
        select idempotency_key from ledger.journals
        where org_id = ${ORG_A} and idempotency_key like ${`order:${orderId}:%`}
        order by idempotency_key
      `),
    { orgId: ORG_A },
  );
  return rows.map((row) => row.idempotency_key);
}

/** Σ debit − Σ credit per account subtype, over this order's own journals. */
async function netBySubtype(orderId: string): Promise<Map<string, bigint>> {
  const rows = await withSystem(
    async (tx) =>
      tx.execute<{ subtype: string; net: string }>(sql`
        select a.subtype::text as subtype,
               (coalesce(sum(l.debit_poisha), 0) - coalesce(sum(l.credit_poisha), 0))::text as net
        from ledger.journal_lines l
        join ledger.journals j on j.org_id = l.org_id and j.id = l.journal_id
        join ledger.accounts a on a.org_id = l.org_id and a.id = l.account_id
        where l.org_id = ${ORG_A} and j.idempotency_key like ${`order:${orderId}:%`}
        group by a.subtype
      `),
    { orgId: ORG_A },
  );
  return new Map(rows.map((row) => [row.subtype, BigInt(row.net)]));
}

/** The parcel's money and return columns, as the settlement matcher reads them. */
async function parcelOutcome(parcelId: string) {
  const [row] = await withSystem(
    async (tx) =>
      tx.execute<{
        collected_poisha: string | null;
        delivered_at: string | null;
        returned_at: string | null;
      }>(sql`
        select collected_poisha::text as collected_poisha, delivered_at, returned_at
        from courier.consignments where org_id = ${ORG_A} and id = ${parcelId}
      `),
    { orgId: ORG_A },
  );
  return row;
}

/**
 * The courier's own word, the way the worker processes it: the webhook route stores the body
 * and the job applies it with no person, no context and no request (the path D-390 is for).
 */
async function courierSays(parcelId: string, state: string): Promise<void> {
  const [parcel] = await withSystem(
    async (tx) =>
      tx.execute<{ consignment_no: string }>(sql`
        select consignment_no from courier.consignments where org_id = ${ORG_A} and id = ${parcelId}
      `),
    { orgId: ORG_A },
  );
  const response = await harness.server.inject({
    method: 'POST',
    url: `/v1/courier/webhooks/${ORG_A}/fake`,
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({
      consignment_no: parcel?.consignment_no,
      state,
      at: new Date().toISOString(),
    }),
  });
  expect(response.statusCode, response.body).toBeLessThan(300);
  const [delivery] = await withSystem(
    async (tx) =>
      tx.execute<{ id: string }>(sql`
        select id from courier.webhook_deliveries
        where org_id = ${ORG_A} and processed_at is null
        order by received_at desc limit 1
      `),
    { orgId: ORG_A },
  );
  if (delivery === undefined) throw new Error('the webhook stored nothing');
  await harness.app.get(CourierSyncService).runWebhook({
    orgId: ORG_A,
    payload: { deliveryId: delivery.id, courierAccountId: accountId },
  });
}

async function statusEvents(orderId: string): Promise<{ from: string; to: string }[]> {
  const rows = await withSystem(
    async (tx) =>
      tx.execute<{ from_status: string | null; to_status: string }>(sql`
        select from_status::text as from_status, to_status::text as to_status
        from sales.order_events
        where org_id = ${ORG_A} and order_id = ${orderId}
        order by occurred_at, id
      `),
    { orgId: ORG_A },
  );
  return rows
    .filter((row) => row.from_status !== null)
    .map((row) => ({ from: row.from_status ?? '', to: row.to_status }));
}

describe('a courier status ships an order nobody marked shipped (D-390)', () => {
  it('ships then delivers a packed order on "delivered", posting both journals in order', async () => {
    const order = await orderAt('packed');
    const parcel = await bookedParcel(order.id, order.cod);
    const before = await trialBalanceDifference(ORG_A);

    const response = await admin.client.request('POST', `/v1/courier/parcels/${parcel}/status`, {
      body: { status: 'delivered', rawStatus: 'delivered', reason: 'The rider phoned it in.' },
    });
    expect(response.statusCode, response.body).toBe(201);

    expect(await orderStatus(order.id)).toBe('delivered');
    // Two rows of §9's table, each with its own event (same instant, so compared as a set).
    const events = await statusEvents(order.id);
    expect(events).toContainEqual({ from: 'packed', to: 'shipped' });
    expect(events).toContainEqual({ from: 'shipped', to: 'delivered' });
    // Sorted by key; the handover posts first in the transaction (the delivery relieves it).
    expect(await journalKeys(order.id)).toEqual([
      `order:${order.id}:delivered`,
      `order:${order.id}:handover`,
    ]);
    expect(await trialBalanceDifference(ORG_A)).toBe(before);
    // Exact amounts, not only balance: what the handover put in transit the delivery took out
    // again, and the courier owes exactly the COD.
    const moved = await netBySubtype(order.id);
    expect(moved.get('goods_in_transit') ?? 0n).toBe(0n);
    expect(moved.get('courier_receivable')).toBe(order.cod);

    const [parcelRow] = await withSystem(
      async (tx) =>
        tx.execute<{ collected_poisha: string | null; order_to_status: string | null }>(sql`
          select c.collected_poisha::text as collected_poisha,
                 (select e.order_to_status from courier.consignment_events e
                  where e.org_id = c.org_id and e.consignment_id = c.id
                  order by e.created_at desc, e.occurred_at desc limit 1) as order_to_status
          from courier.consignments c where c.org_id = ${ORG_A} and c.id = ${parcel}
        `),
      { orgId: ORG_A },
    );
    // The collection is the delivery journal's debit, and the event records where the
    // whole sequence landed.
    expect(parcelRow?.collected_poisha).toBe(order.cod.toString());
    expect(parcelRow?.order_to_status).toBe('delivered');

    // The same fact again, at another instant: past the dedupe row, stopped by the machine.
    const again = await admin.client.request('POST', `/v1/courier/parcels/${parcel}/status`, {
      body: {
        status: 'delivered',
        rawStatus: 'delivered',
        reason: 'Phoned in twice.',
        occurredAt: new Date(Date.now() - 60_000).toISOString(),
      },
    });
    expect(again.statusCode, again.body).toBe(201);
    expect(await journalKeys(order.id)).toHaveLength(2);
    expect(await trialBalanceDifference(ORG_A)).toBe(before);
  });

  it('ships a confirmed order on "picked_up" and stops there', async () => {
    const order = await orderAt('confirmed');
    const parcel = await bookedParcel(order.id, order.cod);
    const response = await admin.client.request('POST', `/v1/courier/parcels/${parcel}/status`, {
      body: { status: 'picked_up', rawStatus: 'picked', reason: 'Collected from the shelf.' },
    });
    expect(response.statusCode, response.body).toBe(201);
    expect(await orderStatus(order.id)).toBe('shipped');
    expect(await journalKeys(order.id)).toEqual([`order:${order.id}:handover`]);
  });

  it('moves nothing on "hold", which does not prove the parcel left', async () => {
    const order = await orderAt('packed');
    const parcel = await bookedParcel(order.id, order.cod);
    const response = await admin.client.request('POST', `/v1/courier/parcels/${parcel}/status`, {
      body: { status: 'hold', rawStatus: 'in_review', reason: 'Courier reviewing.' },
    });
    expect(response.statusCode, response.body).toBe(201);
    expect(await orderStatus(order.id)).toBe('packed');
    expect(await journalKeys(order.id)).toEqual([]);
  });
});

describe('the courier’s own word, through the worker (ledger audit of D-390)', () => {
  it('ships on a partial delivery with no figure, and records no collection (C1)', async () => {
    const order = await orderAt('packed');
    const parcel = await bookedParcel(order.id, order.cod);
    await courierSays(parcel, 'part_handed');

    expect(await orderStatus(order.id)).toBe('shipped');
    expect(await journalKeys(order.id)).toEqual([`order:${order.id}:handover`]);
    // No delivery journal, so no collection: the parcel is not a settlement candidate.
    const outcome = await parcelOutcome(parcel);
    expect(outcome?.collected_poisha).toBeNull();
    expect(outcome?.delivered_at).toBeNull();
  });

  it('ships and starts the return for a parcel back at the merchant, collecting nothing', async () => {
    const order = await orderAt('packed');
    const parcel = await bookedParcel(order.id, order.cod);
    await courierSays(parcel, 'back_at_warehouse');

    expect(await orderStatus(order.id)).toBe('return_in_transit');
    expect(await journalKeys(order.id)).toEqual([`order:${order.id}:handover`]);
    const outcome = await parcelOutcome(parcel);
    expect(outcome?.returned_at).not.toBeNull();
    expect(outcome?.collected_poisha).toBeNull();
    expect(outcome?.delivered_at).toBeNull();
  });

  it('delivers a packed order on the courier’s "delivered", with the exact amounts', async () => {
    const order = await orderAt('packed');
    const parcel = await bookedParcel(order.id, order.cod);
    await courierSays(parcel, 'handed_to_customer');

    expect(await orderStatus(order.id)).toBe('delivered');
    const moved = await netBySubtype(order.id);
    expect(moved.get('goods_in_transit') ?? 0n).toBe(0n);
    expect(moved.get('courier_receivable')).toBe(order.cod);
    expect((await parcelOutcome(parcel))?.collected_poisha).toBe(order.cod.toString());
  });

  it('delivers once, with no second handover, when a person shipped the order first', async () => {
    const order = await orderAt('packed');
    const parcel = await bookedParcel(order.id, order.cod);
    const ship = await admin.client.request('POST', `/v1/orders/${order.id}/ship`, { body: {} });
    expect(ship.statusCode, ship.body).toBe(201);
    await courierSays(parcel, 'handed_to_customer');

    expect(await orderStatus(order.id)).toBe('delivered');
    expect(await journalKeys(order.id)).toEqual([
      `order:${order.id}:delivered`,
      `order:${order.id}:handover`,
    ]);
  });
});

describe('a person’s status and delivery go through the parcel (ledger audit W1, W2)', () => {
  it('refuses a hand-set status that would move the order, dated before yesterday', async () => {
    const order = await orderAt('packed');
    const parcel = await bookedParcel(order.id, order.cod);
    const old = new Date(Date.now() - 5 * 86_400_000).toISOString();
    const moving = await admin.client.request('POST', `/v1/courier/parcels/${parcel}/status`, {
      body: { status: 'delivered', rawStatus: 'delivered', reason: 'Late entry.', occurredAt: old },
    });
    expect(moving.statusCode).toBe(409);
    expect(body<{ code: string }>(moving).code).toBe('APPROVAL_REQUIRED');
    expect(await orderStatus(order.id)).toBe('packed');

    // A tracking-only status moves no money and keeps its date.
    const tracking = await admin.client.request('POST', `/v1/courier/parcels/${parcel}/status`, {
      body: {
        status: 'pickup_pending',
        rawStatus: 'waiting',
        reason: 'Late entry.',
        occurredAt: old,
      },
    });
    expect(tracking.statusCode, tracking.body).toBe(201);
  });

  it('refuses a delivery on the order while its parcel is with a courier', async () => {
    const order = await orderAt('packed');
    await bookedParcel(order.id, order.cod);
    const ship = await admin.client.request('POST', `/v1/orders/${order.id}/ship`, { body: {} });
    expect(ship.statusCode, ship.body).toBe(201);

    const deliver = await admin.client.request('POST', `/v1/orders/${order.id}/deliver`, {
      body: {},
    });
    expect(deliver.statusCode).toBe(409);
    expect(await orderStatus(order.id)).toBe('shipped');
    expect(await journalKeys(order.id)).toEqual([`order:${order.id}:handover`]);
  });
});

describe('the ledger re-audit of D-392 (W-A, W-B, N-B)', () => {
  it('receives a parcel the courier cancelled after pickup, on the parcel’s own route', async () => {
    const order = await orderAt('packed');
    const parcel = await bookedParcel(order.id, order.cod);
    await courierSays(parcel, 'collected');
    await courierSays(parcel, 'called_off');
    // §9: once shipped, a cancellation is a return; the tracking now reads `cancelled`.
    expect(await orderStatus(order.id)).toBe('return_in_transit');

    const received = await admin.client.request(
      'POST',
      `/v1/courier/parcels/${parcel}/receive-return`,
      {
        body: {
          reason: 'Came back unopened.',
          returnReason: 'customer_refused',
          lines: [{ skuId, sellableQty: 1, damagedQty: 0 }],
        },
      },
    );
    expect(received.statusCode, received.body).toBe(201);
    expect(await orderStatus(order.id)).toBe('returned');
    // Back on the shelf: nothing is left in transit for this order.
    expect((await netBySubtype(order.id)).get('goods_in_transit') ?? 0n).toBe(0n);
  });

  it('carries a person’s reason for a short collection to the Sales discounts line', async () => {
    const order = await orderAt('packed');
    const parcel = await bookedParcel(order.id, order.cod);
    const short = (order.cod - 10_000n).toString();
    const response = await admin.client.request('POST', `/v1/courier/parcels/${parcel}/status`, {
      body: {
        status: 'delivered',
        rawStatus: 'Set from the order detail',
        reason: 'Buyer paid ৳100 less for a stain.',
        collectedPoisha: short,
        differenceReason: 'Buyer paid ৳100 less for a stain.',
      },
    });
    expect(response.statusCode, response.body).toBe(201);
    const memos = await withSystem(
      async (tx) =>
        tx.execute<{ memo: string | null }>(sql`
          select l.memo
          from ledger.journal_lines l
          join ledger.journals j on j.org_id = l.org_id and j.id = l.journal_id
          join ledger.accounts a on a.org_id = l.org_id and a.id = l.account_id
          where l.org_id = ${ORG_A} and j.idempotency_key = ${`order:${order.id}:delivered`}
            and a.subtype = 'sales_discounts'
        `),
      { orgId: ORG_A },
    );
    expect(memos.map((row) => row.memo)).toEqual(['Buyer paid ৳100 less for a stain.']);
    expect((await parcelOutcome(parcel))?.collected_poisha).toBe(short);
  });

  it('refuses a hand-set status that would move the order while its booking is queued', async () => {
    const order = await orderAt('packed');
    const parcel = await bookedParcel(order.id, order.cod);
    await withSystem(
      async (tx) =>
        tx.execute(sql`
          update courier.consignments set booking_state = 'pending', consignment_no = null
          where org_id = ${ORG_A} and id = ${parcel}
        `),
      { orgId: ORG_A },
    );
    const response = await admin.client.request('POST', `/v1/courier/parcels/${parcel}/status`, {
      body: { status: 'delivered', rawStatus: 'delivered', reason: 'Too early.' },
    });
    expect(response.statusCode).toBe(400);
    expect(await orderStatus(order.id)).toBe('packed');
  });
});

describe('confirming the handover ships the order, once (D-391)', () => {
  it('ships a packed order, and Ship afterwards is refused as already done', async () => {
    const order = await orderAt('packed');
    const parcel = await bookedParcel(order.id, order.cod);

    const handover = await admin.client.request('POST', `/v1/courier/parcels/${parcel}/handover`, {
      body: {},
    });
    expect(handover.statusCode, handover.body).toBe(201);
    expect(body<{ orderTo: string | null }>(handover).orderTo).toBe('shipped');
    expect(await orderStatus(order.id)).toBe('shipped');
    expect(await journalKeys(order.id)).toEqual([`order:${order.id}:handover`]);

    const second = await admin.client.request('POST', `/v1/courier/parcels/${parcel}/handover`, {
      body: {},
    });
    expect(second.statusCode, second.body).toBe(201);
    expect(body<{ orderTo: string | null }>(second).orderTo).toBeNull();

    const ship = await admin.client.request('POST', `/v1/orders/${order.id}/ship`, { body: {} });
    expect(ship.statusCode).toBe(409);
    expect(await journalKeys(order.id)).toEqual([`order:${order.id}:handover`]);
  });

  it('refuses a handover dated before yesterday when it would ship the order', async () => {
    const order = await orderAt('packed');
    const parcel = await bookedParcel(order.id, order.cod);
    const response = await admin.client.request('POST', `/v1/courier/parcels/${parcel}/handover`, {
      body: { occurredAt: new Date(Date.now() - 5 * 86_400_000).toISOString() },
    });
    expect(response.statusCode).toBe(409);
    expect(body<{ code: string }>(response).code).toBe('APPROVAL_REQUIRED');
    expect(await orderStatus(order.id)).toBe('packed');
  });
});

describe('the order detail offers the moves §9 allows (D-392)', () => {
  it('lists the triggers from the order’s status, with the reason each needs', async () => {
    const order = await orderAt('confirmed');
    const response = await admin.client.request('GET', `/v1/orders/${order.id}`);
    expect(response.statusCode).toBe(200);
    const detail = body<{
      transitions: { trigger: string; to: string; requiresReason: boolean }[];
    }>(response);
    expect(detail.transitions.map((row) => row.trigger).sort()).toEqual(
      ['cancel', 'hold', 'pack', 'ship'].sort(),
    );
    expect(detail.transitions.find((row) => row.trigger === 'hold')?.requiresReason).toBe(true);
    expect(detail.transitions.find((row) => row.trigger === 'pack')?.requiresReason).toBe(false);
    expect(findCostFields(detail)).toEqual([]);
  });

  it('lists one order’s parcels through the parcel list’s order filter', async () => {
    const order = await orderAt('packed');
    const parcel = await bookedParcel(order.id, order.cod);
    const response = await admin.client.request('GET', `/v1/courier/parcels?orderId=${order.id}`);
    expect(response.statusCode).toBe(200);
    expect(body<{ items: { id: string }[] }>(response).items.map((row) => row.id)).toEqual([
      parcel,
    ]);
  });
});

describe('bulk pack and ship (D-393)', () => {
  it('moves each order on its own and reports every refusal against its id', async () => {
    const first = await orderAt('confirmed');
    const second = await orderAt('confirmed');
    const already = await orderAt('packed');
    const response = await admin.client.request('POST', '/v1/orders/bulk-transition', {
      body: { ids: [first.id, second.id, already.id], trigger: 'pack' },
    });
    expect(response.statusCode, response.body).toBe(201);
    const result = body<{
      moved: number;
      results: { id: string; ok: boolean; status?: string; code?: string }[];
    }>(response);
    expect(result.moved).toBe(2);
    expect(result.results.map((row) => row.ok)).toEqual([true, true, false]);
    expect(result.results[2]?.code).toBe('ORDER_TRANSITION_INVALID');

    const shipped = await admin.client.request('POST', '/v1/orders/bulk-transition', {
      body: { ids: [first.id, second.id], trigger: 'ship' },
    });
    expect(body<{ moved: number }>(shipped).moved).toBe(2);
    expect(await journalKeys(first.id)).toEqual([`order:${first.id}:handover`]);
  });

  it('refuses a trigger that needs input per order', async () => {
    const order = await orderAt('confirmed');
    const response = await admin.client.request('POST', '/v1/orders/bulk-transition', {
      body: { ids: [order.id], trigger: 'hold' },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('the read routes the settings and HR screens need (D-394 to D-396)', () => {
  it('lists thresholds with a pending relaxation beside the value in force', async () => {
    const set = await admin.client.request('PUT', '/v1/approvals/thresholds', {
      body: { type: 'wallet_adjustment', thresholdPoisha: '500000' },
    });
    expect(set.statusCode, set.body).toBe(200);

    const response = await admin.client.request('GET', '/v1/approvals/thresholds');
    expect(response.statusCode).toBe(200);
    const list = body<{
      items: {
        type: string;
        thresholdPoisha: string | null;
        pending: { thresholdPoisha: string }[];
      }[];
      alwaysHeld: string[];
    }>(response);
    expect(list.alwaysHeld).toContain('period_reopen');
    expect(list.items.map((item) => item.type)).not.toContain('period_reopen');
    const wallet = list.items.find((item) => item.type === 'wallet_adjustment');
    // A first threshold is a relaxation, so it waits for a second org admin (D-073).
    expect(wallet?.thresholdPoisha).toBeNull();
    expect(wallet?.pending.map((entry) => entry.thresholdPoisha)).toContain('500000');
  });

  it('lists the courier adapters with field names and never a value', async () => {
    const response = await admin.client.request('GET', '/v1/courier/providers');
    expect(response.statusCode).toBe(200);
    const providers = body<{
      items: { code: string; verified: boolean; enabled: boolean; credentialFields: string[] }[];
    }>(response).items;
    const fake = providers.find((entry) => entry.code === 'fake');
    expect(fake?.verified).toBe(true);
    const steadfast = providers.find((entry) => entry.code === 'steadfast');
    expect(steadfast?.credentialFields.length).toBeGreaterThan(0);
    for (const entry of providers) expect(entry.credentialFields).not.toContain('webhookToken');
  });

  it('gives HR the wallets to pay from, as id and name only', async () => {
    const response = await hr.client.request('GET', '/v1/hr/payroll/wallets');
    expect(response.statusCode, response.body).toBe(200);
    const items = body<{ items: Record<string, unknown>[] }>(response).items;
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) expect(Object.keys(item).sort()).toEqual(['accountId', 'name']);

    // The balance-carrying list stays closed to hr, which holds no `read Wallet`.
    const ledger = await hr.client.request('GET', '/v1/ledger/wallets');
    expect(ledger.statusCode).toBe(403);
  });
});
