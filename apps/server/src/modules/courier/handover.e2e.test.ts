import { randomUUID } from 'node:crypto';

import { findCostFields } from '@elysium/contracts';
import { withSystem } from '@elysium/db';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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
import { applyCourierMigrations, makeCourier } from './courier.testing.js';

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
    expect(response.statusCode).toBe(400);
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
