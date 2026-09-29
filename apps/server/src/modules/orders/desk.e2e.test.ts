import { findCostFields } from '@elysium/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ORG_A,
  startHttpHarness,
  type HttpHarness,
  type InjectedResponse,
  type RoleClient,
} from '../../testing/http-harness.js';
import { GotenbergClient } from '../files/pdf/gotenberg.client.js';
import {
  seedProductWithSkus,
  warehouseId,
  type SeededSku,
} from '../inventory/inventory.testing.js';
import { applyOrderMigrations, seedStockLevel } from './orders.testing.js';

/**
 * The order desk over HTTP (M11 acceptance check 5, and the Build list's desk endpoints).
 *
 * Check 5 is "sales sees only their own orders plus the unassigned queue", asserted as a
 * **matrix**: five orders whose ownership differs in exactly one way each, five callers,
 * and every endpoint that can reveal an order — the list, the queue, the detail, the
 * documents, bulk confirm and the duplicate warning — asked the same question. A scope
 * that is right on the list and wrong on the detail is the commonest shape of this bug, so
 * no endpoint is taken on trust because another one passed.
 */

let harness: HttpHarness;
let admin: RoleClient;
let sales1: RoleClient;
let sales2: RoleClient;
let warehouse: RoleClient;
let reseller: RoleClient;

let location = '';
let skus: SeededSku[] = [];

beforeAll(async () => {
  harness = await startHttpHarness('orders-desk');
  await applyOrderMigrations();

  location = await warehouseId(ORG_A);
  ({ skus } = await seedProductWithSkus(ORG_A, 'deske2e', 3));
  for (const sku of skus) {
    await seedStockLevel(ORG_A, {
      skuId: sku.id,
      locationId: location,
      qty: 300,
      unitCostPoisha: 40_000n,
    });
  }

  admin = await harness.asRole('org_admin', ORG_A);
  sales1 = await harness.asRole('sales', ORG_A);
  sales2 = await harness.asRole('sales', ORG_A);
  warehouse = await harness.asRole('warehouse', ORG_A);
  reseller = await harness.asRole('reseller', ORG_A);
}, 420_000);

afterAll(async () => {
  await harness?.close();
}, 60_000);

// --- helpers ------------------------------------------------------------------

function body<T>(response: InjectedResponse): T {
  return JSON.parse(response.body) as T;
}

function sku(index: number): string {
  const found = skus[index];
  if (found === undefined) throw new Error(`no fixture SKU ${String(index)}`);
  return found.id;
}

let phoneSeed = 20_000_000 + Math.floor(Math.random() * 50_000_000);
/** A fresh, valid, throwaway Grameenphone-shaped number per call. */
function freshPhone(): string {
  phoneSeed += 1;
  return `+88017${String(phoneSeed)}`;
}

interface Created {
  readonly id: string;
  readonly orderNo: string;
}

async function take(
  actor: RoleClient,
  options: {
    readonly phone?: string;
    readonly assignedTo?: string;
    readonly channel?: string;
    readonly skuIndex?: number;
  } = {},
): Promise<Created> {
  const response = await actor.client.request('POST', '/v1/orders', {
    body: {
      channel: options.channel ?? 'facebook',
      customer: {
        phone: options.phone ?? freshPhone(),
        name: 'Desk Test Buyer',
        address: { districtId: 47, thanaId: 365, addressLine: 'House 7, Road 3, Savar' },
      },
      locationId: location,
      lines: [{ skuId: sku(options.skuIndex ?? 0), qty: 1 }],
      ...(options.assignedTo === undefined ? {} : { assignedTo: options.assignedTo }),
    },
  });
  if (response.statusCode !== 201) {
    throw new Error(`could not take an order: ${String(response.statusCode)} ${response.body}`);
  }
  return body<Created>(response);
}

async function listIds(actor: RoleClient, query = ''): Promise<Set<string>> {
  const response = await actor.client.request('GET', `/v1/orders?limit=100${query}`);
  expect(response.statusCode).toBe(200);
  return new Set(body<{ items: { id: string }[] }>(response).items.map((item) => item.id));
}

// --- check 5 --------------------------------------------------------------------

describe('check 5: sales sees only its own orders plus the unassigned queue', () => {
  it('holds on every endpoint that can reveal an order, for every caller', async () => {
    const mine1 = await take(sales1, { assignedTo: sales1.userId });
    const mine2 = await take(sales2, { assignedTo: sales2.userId });
    const queued = await take(admin);
    const handedTo1 = await take(admin, { assignedTo: sales1.userId });
    const adminsOwn = await take(admin, { assignedTo: admin.userId });

    const all = { mine1, mine2, queued, handedTo1, adminsOwn };
    type Name = keyof typeof all;

    /*
     * The matrix. `true` means the caller may see the order. Read a row as a sentence:
     * "sales1 sees its own order, the queue and the order handed to it, and nothing else."
     * The reseller row is D-098: the same `read Order|own` grant as sales, without the queue.
     */
    const matrix: Record<string, { client: RoleClient; sees: Record<Name, boolean> }> = {
      sales1: {
        client: sales1,
        sees: { mine1: true, mine2: false, queued: true, handedTo1: true, adminsOwn: false },
      },
      sales2: {
        client: sales2,
        sees: { mine1: false, mine2: true, queued: true, handedTo1: false, adminsOwn: false },
      },
      org_admin: {
        client: admin,
        sees: { mine1: true, mine2: true, queued: true, handedTo1: true, adminsOwn: true },
      },
      warehouse: {
        client: warehouse,
        sees: { mine1: true, mine2: true, queued: true, handedTo1: true, adminsOwn: true },
      },
      reseller: {
        client: reseller,
        sees: { mine1: false, mine2: false, queued: false, handedTo1: false, adminsOwn: false },
      },
    };

    for (const [who, row] of Object.entries(matrix)) {
      const listed = await listIds(row.client);
      for (const [name, order] of Object.entries(all) as [Name, Created][]) {
        const expected = row.sees[name];
        // The list.
        expect(listed.has(order.id), `${who} list · ${name}`).toBe(expected);
        // The detail: 404, not 403, for a row outside the scope.
        const detail = await row.client.client.request('GET', `/v1/orders/${order.id}`);
        expect(detail.statusCode, `${who} detail · ${name}`).toBe(expected ? 200 : 404);
        // The documents: an invoice is the whole order in a forwardable form. Asked only
        // where the answer must be a refusal — which is decided before anything renders —
        // so the matrix does not spend twenty PDF renders proving the other half, which the
        // bulk-print test below does once.
        if (!expected) {
          const batch = await row.client.client.request(
            'GET',
            `/v1/orders/documents?ids=${order.id}&kind=label`,
          );
          expect(batch.statusCode, `${who} documents · ${name}`).toBe(404);
        }
      }
    }

    // The queue filter narrows the scope and never widens it.
    const queue1 = await listIds(sales1, '&queue=unassigned');
    expect(queue1.has(queued.id)).toBe(true);
    expect(queue1.has(mine1.id)).toBe(false);
    expect(queue1.has(mine2.id)).toBe(false);
    expect((await listIds(reseller, '&queue=unassigned')).has(queued.id)).toBe(false);

    // Once sales2 claims the queued order it leaves sales1's reach, on the list and the detail.
    expect((await sales2.client.request('POST', `/v1/orders/${queued.id}/claim`)).statusCode).toBe(
      201,
    );
    expect((await listIds(sales1)).has(queued.id)).toBe(false);
    expect((await sales1.client.request('GET', `/v1/orders/${queued.id}`)).statusCode).toBe(404);

    // An agent filter cannot reach past the scope: asking for sales2's orders as sales1
    // returns nothing of sales2's.
    const asked = await listIds(sales1, `&assignedTo=${sales2.userId}`);
    expect(asked.has(mine2.id)).toBe(false);
    expect(asked.has(queued.id)).toBe(false);
  }, 240_000);

  it('confirms in bulk only what the caller could confirm one by one', async () => {
    const mine = await take(sales1, { assignedTo: sales1.userId });
    const theirs = await take(sales2, { assignedTo: sales2.userId });

    const response = await sales1.client.request('POST', '/v1/orders/bulk-confirm', {
      body: { ids: [mine.id, theirs.id] },
    });
    expect(response.statusCode).toBe(201);
    const result = body<{
      confirmed: number;
      results: { id: string; ok: boolean; code?: string; status?: string }[];
    }>(response);
    expect(result.confirmed).toBe(1);
    expect(result.results).toEqual([
      expect.objectContaining({ id: mine.id, ok: true, status: 'confirmed' }),
      // Not "forbidden": outside the scope an order does not exist.
      expect.objectContaining({ id: theirs.id, ok: false, code: 'ORDER_NOT_FOUND' }),
    ]);

    const stillPending = body<{ status: string }>(
      await sales2.client.request('GET', `/v1/orders/${theirs.id}`),
    );
    expect(stillPending.status).toBe('pending');
  }, 120_000);

  it('warns about a colleague’s duplicate without handing over the order', async () => {
    const phone = freshPhone();
    const theirs = await take(sales2, { phone, assignedTo: sales2.userId, skuIndex: 1 });

    const response = await sales1.client.request(
      'GET',
      `/v1/orders/duplicates?phone=${encodeURIComponent(phone.replace('+880', '0'))}&skuIds=${sku(1)},${sku(2)}`,
    );
    expect(response.statusCode).toBe(200);
    const { items } = body<{
      items: { id: string | null; orderNo: string; visible: boolean; skuIds: string[] }[];
    }>(response);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ orderNo: theirs.orderNo, visible: false, id: null });
    expect(items[0]?.skuIds).toEqual([sku(1)]);

    // The owner sees the same duplicate, with the id to open it.
    const own = body<{ items: { id: string | null; visible: boolean }[] }>(
      await sales2.client.request(
        'GET',
        `/v1/orders/duplicates?phone=${encodeURIComponent(phone)}&skuIds=${sku(1)}`,
      ),
    );
    expect(own.items[0]).toMatchObject({ id: theirs.id, visible: true });

    // A reseller holds the same `read Order|own` grant and is not staff: the brand-wide
    // answer is not theirs, so they learn nothing about an order they cannot open (D-098).
    const partner = body<{ items: unknown[] }>(
      await reseller.client.request(
        'GET',
        `/v1/orders/duplicates?phone=${encodeURIComponent(phone)}&skuIds=${sku(1)}`,
      ),
    );
    expect(partner.items).toEqual([]);

    // A different SKU is a customer coming back, not a duplicate.
    const other = body<{ items: unknown[] }>(
      await sales1.client.request(
        'GET',
        `/v1/orders/duplicates?phone=${encodeURIComponent(phone)}&skuIds=${sku(0)}`,
      ),
    );
    expect(other.items).toEqual([]);
  }, 120_000);
});

// --- the desk's reads -------------------------------------------------------------

describe('the desk’s lookups', () => {
  it('finds a buyer by any spelling of their number, with addresses and history', async () => {
    const phone = freshPhone();
    const order = await take(sales1, { phone, assignedTo: sales1.userId });
    const spelled = `0${phone.slice(4, 8)}-${phone.slice(8)}`;

    const response = await sales1.client.request(
      'GET',
      `/v1/customers/lookup?phone=${encodeURIComponent(spelled)}`,
    );
    expect(response.statusCode).toBe(200);
    const found = body<{
      phone: string;
      customer: {
        phone: string;
        addresses: { thanaId: number; isDefault: boolean }[];
        recentOrders: { id: string; orderNo: string }[];
        stats: { orders: number };
      } | null;
    }>(response);
    expect(found.phone).toBe(phone);
    expect(found.customer?.phone).toBe(phone);
    expect(found.customer?.addresses[0]).toMatchObject({ thanaId: 365, isDefault: true });
    expect(found.customer?.recentOrders.map((entry) => entry.id)).toContain(order.id);
    expect(found.customer?.stats.orders).toBe(1);
  }, 120_000);

  it('answers null for a new number and for a colleague’s buyer alike', async () => {
    const unknown = body<{ customer: unknown }>(
      await sales1.client.request(
        'GET',
        `/v1/customers/lookup?phone=${encodeURIComponent(freshPhone())}`,
      ),
    );
    expect(unknown.customer).toBeNull();

    const phone = freshPhone();
    await take(sales2, { phone, assignedTo: sales2.userId });
    const colleagues = await sales1.client.request(
      'GET',
      `/v1/customers/lookup?phone=${encodeURIComponent(phone)}`,
    );
    expect(colleagues.statusCode).toBe(200);
    expect(body<{ customer: unknown }>(colleagues).customer).toBeNull();

    const invalid = await sales1.client.request('GET', '/v1/customers/lookup?phone=0123456');
    expect(invalid.statusCode).toBe(400);
  }, 120_000);

  it('serves every thana with the zone that covers it', async () => {
    const response = await sales1.client.request('GET', '/v1/delivery-zones/areas');
    expect(response.statusCode).toBe(200);
    const { areas, zones } = body<{
      areas: { thanaId: number; districtId: number; zoneId: string | null }[];
      zones: { id: string; code: string; chargePoisha: string }[];
    }>(response);
    expect(areas.length).toBeGreaterThan(400);
    const savar = areas.find((area) => area.thanaId === 365);
    expect(savar?.districtId).toBe(47);
    // The same zone `create` would resolve: the charge the desk previews is the one invoiced.
    const zone = zones.find((entry) => entry.id === savar?.zoneId);
    const forArea = body<{ id: string }>(
      await sales1.client.request('GET', '/v1/delivery-zones/for-area?districtId=47&thanaId=365'),
    );
    expect(zone?.id).toBe(forArea.id);
  }, 120_000);

  it('lists the people who act on orders, and none of them to a reseller', async () => {
    const staff = body<{ items: { userId: string; roles: string[] }[] }>(
      await sales1.client.request('GET', '/v1/orders/agents'),
    );
    const ids = staff.items.map((item) => item.userId);
    expect(ids).toContain(sales1.userId);
    expect(ids).toContain(sales2.userId);
    expect(staff.items.find((item) => item.userId === sales2.userId)?.roles).toEqual(['sales']);
    expect(JSON.stringify(staff)).not.toMatch(/@example\.invalid/);

    const partner = body<{ items: unknown[] }>(
      await reseller.client.request('GET', '/v1/orders/agents'),
    );
    expect(partner.items).toEqual([]);
  }, 120_000);
});

describe('the order list’s filters', () => {
  it('filters by channel, agent, zone and status, and pages with hasNext', async () => {
    const whatsapp = await take(admin, { channel: 'whatsapp', assignedTo: sales1.userId });
    const facebook = await take(admin, { channel: 'facebook', assignedTo: sales1.userId });

    const byChannel = await listIds(admin, '&channel=whatsapp');
    expect(byChannel.has(whatsapp.id)).toBe(true);
    expect(byChannel.has(facebook.id)).toBe(false);

    const byAgent = await listIds(admin, `&assignedTo=${sales1.userId}`);
    expect(byAgent.has(whatsapp.id) && byAgent.has(facebook.id)).toBe(true);

    const detail = body<{ deliveryZoneId: string }>(
      await admin.client.request('GET', `/v1/orders/${whatsapp.id}`),
    );
    expect((await listIds(admin, `&zoneId=${detail.deliveryZoneId}`)).has(whatsapp.id)).toBe(true);
    expect(
      (await listIds(admin, '&zoneId=00000000-0000-4000-8000-000000000000')).has(whatsapp.id),
    ).toBe(false);
    expect((await listIds(admin, '&status=cancelled')).has(whatsapp.id)).toBe(false);

    const pageOne = body<{ items: unknown[]; hasNext: boolean }>(
      await admin.client.request('GET', '/v1/orders?limit=1'),
    );
    expect(pageOne.items).toHaveLength(1);
    expect(pageOne.hasNext).toBe(true);

    const bad = await admin.client.request('GET', '/v1/orders?channel=pigeon');
    expect(bad.statusCode).toBe(400);
  }, 120_000);
});

describe('the order detail’s timeline', () => {
  it('tells the order’s story once, in order, with no audit payloads', async () => {
    const order = await take(admin);
    await sales1.client.request('POST', `/v1/orders/${order.id}/claim`);
    await sales1.client.request('POST', `/v1/orders/${order.id}/confirm`);

    const detail = body<{
      timeline: ({ kind: 'status'; to: string } | { kind: 'activity'; action: string })[];
    }>(await sales1.client.request('GET', `/v1/orders/${order.id}`));

    expect(
      detail.timeline.map((entry) =>
        entry.kind === 'status' ? `status:${entry.to}` : entry.action,
      ),
    ).toEqual(['status:pending', 'order.claimed', 'status:confirmed']);
    expect(JSON.stringify(detail.timeline)).not.toMatch(/"before"|"after"/);
  }, 120_000);
});

describe('bulk print', () => {
  it('renders one PDF with a page per order, for labels and invoices', async () => {
    if (
      !(await new GotenbergClient(process.env.GOTENBERG_URL ?? 'http://localhost:3030').isReady())
    ) {
      // Not skipped silently: the reason is in the output of every run that hits it.
      console.warn('bulk print not exercised: Gotenberg is not reachable');
      return;
    }
    const first = await take(sales1, { assignedTo: sales1.userId });
    const second = await take(sales1, { assignedTo: sales1.userId });

    for (const kind of ['label', 'invoice'] as const) {
      const response = await sales1.client.request(
        'GET',
        `/v1/orders/documents?ids=${first.id},${second.id}&kind=${kind}`,
      );
      expect(response.statusCode, kind).toBe(200);
      expect(response.headers['content-type']).toBe('application/pdf');
      expect(response.body.slice(0, 4)).toBe('%PDF');
    }

    const single = await sales1.client.request('GET', `/v1/orders/${first.id}/document?kind=label`);
    expect(single.statusCode).toBe(200);
  }, 180_000);
});

describe('invariant 5 on the desk’s responses', () => {
  it('carries no cost field on any of them', async () => {
    const phone = freshPhone();
    const order = await take(sales1, { phone, assignedTo: sales1.userId });
    for (const url of [
      `/v1/orders/${order.id}`,
      '/v1/orders?limit=10',
      `/v1/customers/lookup?phone=${encodeURIComponent(phone)}`,
      `/v1/orders/duplicates?phone=${encodeURIComponent(phone)}&skuIds=${sku(0)}`,
      '/v1/delivery-zones/areas',
    ]) {
      const response = await sales1.client.request('GET', url);
      expect(response.statusCode, url).toBe(200);
      expect(findCostFields(body<unknown>(response)), url).toEqual([]);
    }
  }, 120_000);
});
