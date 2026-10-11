import { OWNER_ACK_HEADER } from '@elysium/contracts';
import { withGlobal, withSystem } from '@elysium/db';
import { sql } from 'drizzle-orm';
import pino from 'pino';
import { io, type Socket as ClientSocket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { OutboxDispatcher } from '../../platform/events/dispatcher.js';
import { JobsRuntime } from '../../platform/jobs/jobs.runtime.js';
import { createLogger } from '../../platform/logging/logger.js';
import {
  RT_READY,
  bridgeOutboxToRealtime,
  createRealtimeGateway,
  type RealtimeGateway,
} from '../../platform/realtime/index.js';
import {
  APP_DOMAIN,
  ORG_A,
  createBranch,
  ORG_B,
  ORIGIN,
  startHttpHarness,
  type HttpHarness,
  type InjectedResponse,
  type RoleClient,
} from '../../testing/http-harness.js';
import { makeLocation, seedProductWithSkus, warehouseId } from '../inventory/inventory.testing.js';
import { OFFER_QUEUE_DEFINITIONS } from './offers.queues.js';
import { OffersService } from './offers.service.js';
import {
  applyOrderMigrations,
  ownRiderCourier,
  seedCustomer,
  seedOrder,
  seedStockLevel,
} from './orders.testing.js';

/**
 * M41's order workflow over HTTP, against real PostgreSQL (acceptance checks 1 to 5).
 *
 * 1. Two people taking the same new order at once: exactly one succeeds, the other is told who.
 * 2. A non-owner's desk act is refused without the acknowledgement; with it, it goes through,
 *    is audited, and the owner's own socket receives `order.acted_over_owner`.
 * 3. Auto-assign offers to the least-loaded active person and never to an idle, away or paused
 *    one; a decline and an expiry move it on; an accept racing a take has one winner.
 * 4. Call attempts are recorded and shown, and call-back times order the queue.
 * 5. The hub sees confirmed orders at its location, and the desk sees the hub's progress.
 *
 * The offers are dispatched by calling the worker's own `OffersService` rather than by a
 * background worker, so no timer races the assertions; the jobs runtime is started so the
 * service's `enqueue` calls land in pg-boss as they do in production.
 */

let harness: HttpHarness;
let jobs: JobsRuntime | undefined;
let gateway: RealtimeGateway | undefined;
let dispatcher: OutboxDispatcher;
let offers: OffersService;
let port = 0;

let admin: RoleClient;
let otherBrandAdmin: RoleClient;
let warehouse: RoleClient;
/** Rahim and Karim race for orders and own them; the others are the auto-assign cast. */
let rahim: RoleClient;
let karim: RoleClient;
let busy: RoleClient;
let fresh: RoleClient;
let dozing: RoleClient;
let gone: RoleClient;
let paused: RoleClient;

let location = '';
let hub = '';
let courierId = '';
let skuId = '';
let skuCode = '';
let buyer = '';

const open: ClientSocket[] = [];

beforeAll(async () => {
  process.env.LOG_LEVEL = 'fatal';
  harness = await startHttpHarness('orders-workflow');
  await applyOrderMigrations();
  jobs = await JobsRuntime.start({
    role: 'worker',
    connectionString: harness.database.ownerUrl,
    appRole: 'erp_app',
    queues: OFFER_QUEUE_DEFINITIONS,
    logger: pino({ level: 'silent' }),
    pollingIntervalSeconds: 0.5,
  });

  location = await warehouseId(ORG_A);
  hub = await makeLocation(ORG_A, { code: 'HUB2', name: 'Savar hub', kind: 'warehouse' });
  const { skus } = await seedProductWithSkus(ORG_A, 'workflowe2e', 1);
  skuId = skus[0]?.id ?? '';
  skuCode = skus[0]?.code ?? '';
  buyer = await seedCustomer(ORG_A, { phoneE164: '+8801711555123', name: 'Seeded Buyer' });
  for (const at of [location, hub]) {
    await seedStockLevel(ORG_A, { skuId, locationId: at, qty: 500, unitCostPoisha: 40_000n });
  }
  courierId = await ownRiderCourier(ORG_A);

  admin = await harness.asRole('org_admin', ORG_A);
  otherBrandAdmin = await harness.asRole('org_admin', ORG_B);
  warehouse = await harness.asRole('warehouse', ORG_A);
  rahim = await harness.asRole('sales', ORG_A);
  karim = await harness.asRole('sales', ORG_A);
  busy = await harness.asRole('sales', ORG_A);
  fresh = await harness.asRole('sales', ORG_A);
  dozing = await harness.asRole('sales', ORG_A);
  gone = await harness.asRole('sales', ORG_A);
  paused = await harness.asRole('sales', ORG_A);
  for (const [who, name] of [
    [rahim, 'Rahim Uddin'],
    [karim, 'Karim Hossain'],
    [busy, 'Busy Begum'],
    [fresh, 'Fresh Faruk'],
    [dozing, 'Dozing Dipu'],
    [gone, 'Gone Gias'],
    [paused, 'Paused Parvin'],
  ] as const) {
    await withGlobal((tx) =>
      tx.execute(sql`update iam.users set name = ${name} where id = ${who.userId}`),
    );
  }

  // A socket per person whose real-time news is asserted: the real gateway and the real
  // outbox bridge, single-process (no Valkey adapter is needed for one API process).
  await harness.server.listen({ port: 0, host: '127.0.0.1' });
  const address = harness.server.server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  port = address.port;
  const logger = createLogger('workflow-test');
  gateway = createRealtimeGateway(harness.server.server, {
    auth: harness.auth.auth,
    logger,
    trustedOrigins: [ORIGIN],
  });
  dispatcher = new OutboxDispatcher();
  bridgeOutboxToRealtime(dispatcher, gateway, logger);

  offers = harness.app.get(OffersService);
}, 420_000);

afterAll(async () => {
  for (const socket of open) socket.close();
  await gateway?.close();
  await jobs?.stop();
  await harness?.close();
}, 60_000);

// --- helpers --------------------------------------------------------------------------

function body<T>(response: InjectedResponse): T {
  return JSON.parse(response.body) as T;
}

function codeOf(response: InjectedResponse): string | undefined {
  return body<{ code?: string }>(response).code;
}

const ACK = { [OWNER_ACK_HEADER]: '1' };

let phoneSeed = 30_000_000 + Math.floor(Math.random() * 40_000_000);
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
  options: { readonly assignedTo?: string; readonly locationId?: string } = {},
): Promise<Created> {
  const response = await actor.client.request('POST', '/v1/orders', {
    body: {
      channel: 'facebook',
      customer: {
        phone: freshPhone(),
        name: 'Workflow Buyer',
        address: { districtId: 47, thanaId: 365, addressLine: 'House 9, Road 4, Savar' },
      },
      locationId: options.locationId ?? location,
      lines: [{ skuId, qty: 2 }],
      ...(options.assignedTo === undefined ? {} : { assignedTo: options.assignedTo }),
    },
  });
  if (response.statusCode !== 201) {
    throw new Error(`could not take an order: ${String(response.statusCode)} ${response.body}`);
  }
  return body<Created>(response);
}

interface OrderBody {
  readonly id: string;
  readonly status: string;
  readonly assignedTo: string | null;
  readonly assignedAt: string | null;
  readonly calls: {
    attempts: number;
    lastOutcome: string | null;
    callBackAt: string | null;
  };
  readonly hubStage: string | null;
  readonly itemCount?: number;
}

/** An order written straight at a status (no transitions), for the gate's later steps. */
async function seeded(status: string, assignedTo: string, createdBy: string): Promise<string> {
  const { id } = await seedOrder(ORG_A, {
    status,
    customerId: buyer,
    locationId: location,
    lines: [
      {
        skuId,
        skuCode,
        productName: 'Workflow product',
        qty: 1,
        unitPricePoisha: 150_000n,
        ...(status === 'delivered' ? { dispatchUnitCostPoisha: 40_000n, deliveredQty: 1 } : {}),
      },
    ],
    assignedTo,
    createdBy,
  });
  return id;
}

async function detail(id: string, actor: RoleClient = admin): Promise<OrderBody> {
  const response = await actor.client.request('GET', `/v1/orders/${id}`);
  expect(response.statusCode, response.body).toBe(200);
  return body<OrderBody>(response);
}

async function queue(actor: RoleClient, query: string): Promise<OrderBody[]> {
  const response = await actor.client.request('GET', `/v1/orders?limit=100&${query}`);
  expect(response.statusCode, response.body).toBe(200);
  return body<{ items: OrderBody[] }>(response).items;
}

async function beat(actor: RoleClient, input: { visible: boolean; idleSeconds: number }) {
  const response = await actor.client.request('POST', '/v1/team/presence', { body: input });
  expect(response.statusCode, response.body).toBe(201);
  return body<{ state: string; paused: boolean; available: boolean }>(response);
}

async function liveOfferOf(orderId: string): Promise<{ id: string; user_id: string } | undefined> {
  return withSystem(
    async (tx) => {
      const rows = await tx.execute<{ id: string; user_id: string }>(sql`
        select id, user_id from sales.order_offers
        where org_id = ${ORG_A} and order_id = ${orderId} and status = 'offered'
      `);
      return rows[0];
    },
    { orgId: ORG_A },
  );
}

interface Connected {
  readonly socket: ClientSocket;
  readonly received: { name: string; payload: Record<string, unknown> }[];
}

async function connect(client: RoleClient, events: readonly string[]): Promise<Connected> {
  const socket = io(`http://127.0.0.1:${String(port)}/rt`, {
    transports: ['websocket'],
    extraHeaders: { cookie: client.client.cookieHeader(), origin: ORIGIN, host: APP_DOMAIN },
    reconnection: false,
  });
  open.push(socket);
  const received: Connected['received'] = [];
  for (const name of events) {
    socket.on(name, (payload: Record<string, unknown>) => received.push({ name, payload }));
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('handshake did not complete')), 15_000);
    socket.on(RT_READY, () => {
      clearTimeout(timer);
      resolve();
    });
    socket.on('connect_error', (error: Error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  return { socket, received };
}

/** Deliver what the outbox holds, then give the sockets a moment to hear it. */
async function deliver(): Promise<void> {
  await dispatcher.drain(500);
  await new Promise((resolve) => setTimeout(resolve, 200));
}

// --- check 1 ----------------------------------------------------------------------------

describe('check 1: two people taking the same new order at once', () => {
  it('lets exactly one take it, and tells the other who has it', async () => {
    const order = await take(admin);

    const [first, second] = await Promise.all([
      rahim.client.request('POST', `/v1/orders/${order.id}/claim`),
      karim.client.request('POST', `/v1/orders/${order.id}/claim`),
    ]);
    const codes = [first.statusCode, second.statusCode].sort((a, b) => a - b);
    expect(codes).toEqual([201, 409]);

    const winner = first.statusCode === 201 ? rahim : karim;
    const loser = first.statusCode === 201 ? second : first;
    const winnerName = winner === rahim ? 'Rahim Uddin' : 'Karim Hossain';
    expect(codeOf(loser)).toBe('ORDER_ALREADY_CLAIMED');
    expect(body<{ detail: string }>(loser).detail).toContain(winnerName);

    const after = await detail(order.id);
    expect(after.assignedTo).toBe(winner.userId);
    expect(after.assignedAt).not.toBeNull();

    // Taking an order you already hold changes nothing and is not an error.
    const again = await winner.client.request('POST', `/v1/orders/${order.id}/claim`);
    expect(again.statusCode).toBe(201);
    expect(body<OrderBody>(again).assignedTo).toBe(winner.userId);
  }, 120_000);

  it('keeps GET free of side effects: opening an unassigned order takes nothing', async () => {
    const order = await take(admin);
    await detail(order.id, rahim);
    expect((await detail(order.id)).assignedTo).toBeNull();
  }, 60_000);
});

// --- check 2 ----------------------------------------------------------------------------

describe('check 2: a non-owner must acknowledge the owner, at every desk step', () => {
  it('refuses without the acknowledgement, and with it acts, audits and tells the owner live', async () => {
    const owner = await connect(rahim, ['order.acted_over_owner']);
    const order = await take(admin, { assignedTo: rahim.userId });

    const refused = await admin.client.request('POST', `/v1/orders/${order.id}/confirm`);
    expect(refused.statusCode).toBe(409);
    expect(codeOf(refused)).toBe('ORDER_HANDLED_BY_OTHER');
    expect(body<{ detail: string }>(refused).detail).toContain('Rahim Uddin');
    expect((await detail(order.id)).status).toBe('pending');

    const acknowledged = await admin.client.request('POST', `/v1/orders/${order.id}/confirm`, {
      headers: ACK,
    });
    expect(acknowledged.statusCode, acknowledged.body).toBe(201);
    expect(body<OrderBody>(acknowledged).status).toBe('confirmed');

    const audited = await withSystem(
      async (tx) => {
        const rows = await tx.execute<{ actor_user_id: string; after: { act: string } }>(sql`
          select actor_user_id, after from audit.audit_log
          where org_id = ${ORG_A} and entity_id = ${order.id} and action = 'order.acted_over_owner'
        `);
        return [...rows];
      },
      { orgId: ORG_A },
    );
    expect(audited).toHaveLength(1);
    expect(audited[0]?.actor_user_id).toBe(admin.userId);
    expect(audited[0]?.after.act).toBe('confirm');

    await deliver();
    const told = owner.received.filter((event) => event.payload.id === order.id);
    expect(told).toHaveLength(1);
    expect(told[0]?.payload).toMatchObject({
      ownerId: rahim.userId,
      actorUserId: admin.userId,
      act: 'confirm',
    });
  }, 120_000);

  it('guards every desk act the same way, and leaves the hub’s moves alone', async () => {
    // Karim enters the order and Rahim takes it: Karim still sees it (he created it) and is the
    // non-owner here.
    const order = await take(karim);
    expect((await rahim.client.request('POST', `/v1/orders/${order.id}/claim`)).statusCode).toBe(
      201,
    );
    const acts: [string, string, unknown][] = [
      ['PATCH', `/v1/orders/${order.id}`, { notes: 'Call after 6 pm' }],
      ['POST', `/v1/orders/${order.id}/calls`, { outcome: 'no_answer' }],
      ['POST', `/v1/orders/${order.id}/hold`, { reason: 'Buyer asked to wait' }],
      [
        'POST',
        `/v1/orders/${order.id}/advances`,
        {
          method: 'bkash',
          transactionRef: `WF${String(Date.now()).slice(-8)}`,
          amountPoisha: '10000',
        },
      ],
    ];
    for (const [method, url, payload] of acts) {
      const response = await karim.client.request(method, url, { body: payload });
      expect(response.statusCode, `${method} ${url}: ${response.body}`).toBe(409);
      expect(codeOf(response)).toBe('ORDER_HANDLED_BY_OTHER');
    }
    // Cancel, release from hold and exchange, at the statuses they start from.
    const held = await seeded('on_hold', rahim.userId, karim.userId);
    const delivered = await seeded('delivered', rahim.userId, karim.userId);
    const later: [string, unknown][] = [
      [`/v1/orders/${order.id}/cancel`, { reason: 'Buyer changed their mind' }],
      [`/v1/orders/${held}/release-hold`, undefined],
      [
        `/v1/orders/${delivered}/exchange`,
        {
          reason: 'Wrong size',
          returnReason: 'customer_refused',
          returnLines: [{ skuId, qty: 1 }],
          lines: [{ skuId, qty: 1 }],
        },
      ],
    ];
    for (const [url, payload] of later) {
      const response = await karim.client.request('POST', url, {
        ...(payload === undefined ? {} : { body: payload }),
      });
      expect(response.statusCode, `POST ${url}: ${response.body}`).toBe(409);
      expect(codeOf(response)).toBe('ORDER_HANDLED_BY_OTHER');
    }
    // The owner needs no acknowledgement for their own order.
    const own = await rahim.client.request('PATCH', `/v1/orders/${order.id}`, {
      body: { notes: 'Rahim’s note' },
    });
    expect(own.statusCode, own.body).toBe(200);
    // With it, the edit goes through.
    const edited = await karim.client.request('PATCH', `/v1/orders/${order.id}`, {
      body: { notes: 'Karim, acknowledged' },
      headers: ACK,
    });
    expect(edited.statusCode, edited.body).toBe(200);

    // Bulk confirm is one gate per order: refused in the batch without it.
    const bulk = await admin.client.request('POST', '/v1/orders/bulk-confirm', {
      body: { ids: [order.id] },
    });
    expect(bulk.statusCode).toBe(201);
    expect(body<{ results: { ok: boolean; code?: string }[] }>(bulk).results[0]).toMatchObject({
      ok: false,
      code: 'ORDER_HANDLED_BY_OTHER',
    });
    const confirmed = await admin.client.request('POST', '/v1/orders/bulk-confirm', {
      body: { ids: [order.id] },
      headers: ACK,
    });
    expect(body<{ confirmed: number }>(confirmed).confirmed).toBe(1);

    // The hub packs Rahim's confirmed order without acknowledging anybody (D-710).
    const packed = await warehouse.client.request('POST', `/v1/orders/${order.id}/pack`);
    expect(packed.statusCode, packed.body).toBe(201);
  }, 120_000);

  it('keeps creating an order for somebody else to a supervisor, and to people who can hold it', async () => {
    // A sales agent may not enter an order already owned by a colleague (D-712).
    const pushed = await karim.client.request('POST', '/v1/orders', {
      body: {
        channel: 'facebook',
        customer: {
          phone: freshPhone(),
          name: 'Pushed Buyer',
          address: { districtId: 47, thanaId: 365, addressLine: 'House 1' },
        },
        locationId: location,
        lines: [{ skuId, qty: 1 }],
        assignedTo: rahim.userId,
      },
    });
    expect(pushed.statusCode).toBe(403);
    expect(codeOf(pushed)).toBe('ORDER_ASSIGN_NOT_ALLOWED');

    // Nor may anybody hand a desk order (no branch) to a branch manager kept to one branch,
    // who could never open it again.
    const branch = await createBranch(ORG_A, `WF${String(Date.now()).slice(-6)}`);
    const manager = await harness.asRole('branch_manager', ORG_A, { branchIds: [branch] });
    const order = await take(admin);
    const stranded = await admin.client.request('POST', `/v1/orders/${order.id}/assign`, {
      body: { assignedTo: manager.userId },
    });
    expect(stranded.statusCode).toBe(400);
    expect(codeOf(stranded)).toBe('ORDER_ASSIGNEE_INVALID');

    // A finished order has nothing left to take.
    const done = await seeded('delivered', admin.userId, admin.userId);
    await withSystem(
      (tx) =>
        tx.execute(sql`
          update sales.orders set assigned_to = null, assigned_at = null
          where org_id = ${ORG_A} and id = ${done}
        `),
      { orgId: ORG_A },
    );
    const late = await rahim.client.request('POST', `/v1/orders/${done}/claim`);
    expect(late.statusCode).toBe(403);
    expect(codeOf(late)).toBe('ORDER_ASSIGN_NOT_ALLOWED');
  }, 120_000);

  it('lets the owner release or hand over, a supervisor reassign, and nobody else', async () => {
    const order = await take(admin, { assignedTo: rahim.userId });

    // Karim cannot see Rahim's order at all (own scope), so it is a 404 rather than a refusal.
    const notTheirs = await karim.client.request('POST', `/v1/orders/${order.id}/release`);
    expect(notTheirs.statusCode).toBe(404);
    // The warehouse sees it, and may not move it.
    const warehouseTries = await warehouse.client.request('POST', `/v1/orders/${order.id}/assign`, {
      body: { assignedTo: karim.userId },
    });
    expect(warehouseTries.statusCode).toBe(403);
    expect(codeOf(warehouseTries)).toBe('ORDER_ASSIGN_NOT_ALLOWED');

    // The owner hands it to Karim.
    const handed = await rahim.client.request('POST', `/v1/orders/${order.id}/assign`, {
      body: { assignedTo: karim.userId },
    });
    expect(handed.statusCode, handed.body).toBe(201);
    expect((await detail(order.id)).assignedTo).toBe(karim.userId);

    // A supervisor gives it back to Rahim; Karim, the owner they moved it from, is told.
    const moved = await admin.client.request('POST', `/v1/orders/${order.id}/assign`, {
      body: { assignedTo: rahim.userId },
    });
    expect(moved.statusCode, moved.body).toBe(201);
    const told = await withSystem(
      async (tx) => {
        const rows = await tx.execute<{ rooms: string[] }>(sql`
          select rooms from events.outbox
          where org_id = ${ORG_A} and name = 'order.acted_over_owner'
            and payload->>'id' = ${order.id} and payload->>'act' = 'reassign'
        `);
        return [...rows];
      },
      { orgId: ORG_A },
    );
    expect(told[0]?.rooms).toContain(`user:${karim.userId}`);

    // Nobody can be handed an order who cannot hold orders here.
    const toAccounts = await admin.client.request('POST', `/v1/orders/${order.id}/assign`, {
      body: { assignedTo: otherBrandAdmin.userId },
    });
    expect(toAccounts.statusCode).toBe(400);
    expect(codeOf(toAccounts)).toBe('ORDER_ASSIGNEE_INVALID');

    // The owner releases it back to New.
    const released = await rahim.client.request('POST', `/v1/orders/${order.id}/release`);
    expect(released.statusCode, released.body).toBe(201);
    expect((await detail(order.id)).assignedTo).toBeNull();
    expect((await queue(karim, 'queue=new')).some((row) => row.id === order.id)).toBe(true);
  }, 120_000);
});

// --- check 3 ----------------------------------------------------------------------------

describe('check 3: auto-assign', () => {
  it('offers to the least-loaded active person, never an idle, away or paused one; a decline and an expiry move it on', async () => {
    const settings = await admin.client.request('PUT', '/v1/orders/workflow-settings', {
      body: { autoAssign: true, offerSeconds: 15, maxOpen: 25 },
    });
    expect(settings.statusCode, settings.body).toBe(200);

    // Busy holds two open orders; Fresh holds none.
    await take(admin, { assignedTo: busy.userId });
    await take(admin, { assignedTo: busy.userId });

    expect((await beat(busy, { visible: true, idleSeconds: 0 })).state).toBe('active');
    expect((await beat(fresh, { visible: true, idleSeconds: 3 })).state).toBe('active');
    // Dozing's tab is open but nobody has touched it for ten minutes: idle.
    expect((await beat(dozing, { visible: true, idleSeconds: 600 })).state).toBe('idle');
    // Gone reported, then went quiet five minutes ago: away.
    await beat(gone, { visible: true, idleSeconds: 0 });
    await withSystem(
      (tx) =>
        tx.execute(sql`
          update team.presence set last_seen_at = now() - interval '5 minutes'
          where org_id = ${ORG_A} and user_id = ${gone.userId}
        `),
      { orgId: ORG_A },
    );
    // Paused is working, and not taking orders.
    await beat(paused, { visible: true, idleSeconds: 0 });
    const pause = await paused.client.request('POST', '/v1/team/presence/pause', {
      body: { paused: true },
    });
    expect(pause.statusCode, pause.body).toBe(201);
    expect(body<{ available: boolean }>(pause).available).toBe(false);

    const freshSocket = await connect(fresh, ['order.offered']);
    const order = await take(admin);
    expect(await offers.dispatch(ORG_A, order.id)).toBe(1);

    const first = await liveOfferOf(order.id);
    expect(first?.user_id).toBe(fresh.userId);

    // The card: number, items, cash to collect and the countdown, to Fresh alone.
    const mine = body<{
      items: {
        id: string;
        orderNo: string;
        itemCount: number;
        codAmountPoisha: string;
        expiresAt: string;
      }[];
    }>(await fresh.client.request('GET', '/v1/orders/offers/mine'));
    expect(mine.items).toHaveLength(1);
    expect(mine.items[0]).toMatchObject({ orderNo: order.orderNo, itemCount: 2 });
    expect(new Date(mine.items[0]?.expiresAt ?? 0).getTime()).toBeGreaterThan(Date.now());
    for (const other of [busy, dozing, gone, paused]) {
      const theirs = body<{ items: unknown[] }>(
        await other.client.request('GET', '/v1/orders/offers/mine'),
      );
      expect(theirs.items).toHaveLength(0);
    }
    await deliver();
    expect(freshSocket.received.some((event) => event.payload.orderId === order.id)).toBe(true);

    // Somebody else cannot answer Fresh's offer.
    const stolen = await busy.client.request('POST', `/v1/orders/offers/${first?.id ?? ''}/accept`);
    expect(stolen.statusCode).toBe(409);
    expect(codeOf(stolen)).toBe('ORDER_OFFER_GONE');

    // Fresh declines: the next person is Busy, the only other active one taking orders.
    const declined = await fresh.client.request(
      'POST',
      `/v1/orders/offers/${first?.id ?? ''}/decline`,
    );
    expect(declined.statusCode, declined.body).toBe(201);
    const queued = await withSystem(
      async (tx) => {
        const rows = await tx.execute<{ n: number }>(sql`
          select count(*)::int as n from pgboss.job
          where name = 'orders.offer_dispatch' and data->'payload'->>'orderId' = ${order.id}
        `);
        return rows[0]?.n ?? 0;
      },
      { orgId: ORG_A },
    );
    expect(queued).toBeGreaterThanOrEqual(1);
    expect(await offers.dispatch(ORG_A, order.id)).toBe(1);
    const second = await liveOfferOf(order.id);
    expect(second?.user_id).toBe(busy.userId);

    // Busy lets it run out. The deadline passes; the expiry moves it on, and with nobody
    // left who has not passed on it, it waits in New.
    expect(await offers.expire(ORG_A, second?.id ?? '')).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 16_000));
    expect(await offers.expire(ORG_A, second?.id ?? '')).toBe(true);
    expect(await liveOfferOf(order.id)).toBeUndefined();
    expect((await detail(order.id)).assignedTo).toBeNull();
    expect((await queue(admin, 'queue=new')).some((row) => row.id === order.id)).toBe(true);

    // Never an idle, away or paused person, for this order or any other.
    const reached = await withSystem(
      async (tx) => {
        const rows = await tx.execute<{ user_id: string }>(sql`
          select distinct user_id from sales.order_offers where org_id = ${ORG_A}
        `);
        return [...rows].map((row) => row.user_id);
      },
      { orgId: ORG_A },
    );
    for (const never of [dozing, gone, paused]) expect(reached).not.toContain(never.userId);

    // Only this order waits now: the supervisor takes the rest of New off the queue.
    for (const row of await queue(admin, 'queue=new')) {
      if (row.id !== order.id) {
        expect((await admin.client.request('POST', `/v1/orders/${row.id}/claim`)).statusCode).toBe(
          201,
        );
      }
    }
    // Dozing comes back to the screen: available now, offered what waits.
    expect((await beat(dozing, { visible: true, idleSeconds: 1 })).available).toBe(true);
    expect(await offers.dispatch(ORG_A, null)).toBeGreaterThanOrEqual(1);
    const third = await liveOfferOf(order.id);
    expect(third?.user_id).toBe(dozing.userId);

    // An accept racing a take: exactly one wins, and the order is the winner's.
    const [accepted, claimed] = await Promise.all([
      dozing.client.request('POST', `/v1/orders/offers/${third?.id ?? ''}/accept`),
      karim.client.request('POST', `/v1/orders/${order.id}/claim`),
    ]);
    const statuses = [accepted.statusCode, claimed.statusCode].sort((a, b) => a - b);
    expect(statuses).toEqual([201, 409]);
    const winner = accepted.statusCode === 201 ? dozing : karim;
    expect((await detail(order.id)).assignedTo).toBe(winner.userId);
    expect(await liveOfferOf(order.id)).toBeUndefined();
    if (accepted.statusCode === 409) expect(codeOf(accepted)).toBe('ORDER_OFFER_GONE');
    else expect(codeOf(claimed)).toBe('ORDER_ALREADY_CLAIMED');

    // An accepted offer cannot be accepted again.
    const twice = await dozing.client.request(
      'POST',
      `/v1/orders/offers/${third?.id ?? ''}/accept`,
    );
    expect(twice.statusCode).toBe(409);
  }, 180_000);

  it('shows the team board to supervisors only, with presence, loads and offers', async () => {
    const board = await admin.client.request('GET', '/v1/orders/team-board');
    expect(board.statusCode, board.body).toBe(200);
    const people = body<{
      people: {
        userId: string;
        presence: { state: string; paused: boolean };
        openOrders: number;
      }[];
      settings: { autoAssign: boolean };
    }>(board);
    expect(people.settings.autoAssign).toBe(true);
    const byId = new Map(people.people.map((person) => [person.userId, person]));
    expect(byId.get(busy.userId)?.openOrders).toBe(2);
    expect(byId.get(gone.userId)?.presence.state).toBe('away');
    expect(byId.get(paused.userId)?.presence.paused).toBe(true);

    expect((await rahim.client.request('GET', '/v1/orders/team-board')).statusCode).toBe(403);
    // Another brand's board names none of this brand's people.
    const theirs = body<{ people: { userId: string }[] }>(
      await otherBrandAdmin.client.request('GET', '/v1/orders/team-board'),
    );
    expect(theirs.people.some((person) => person.userId === busy.userId)).toBe(false);
  }, 60_000);

  it('lapses offers and sweeps at once without the dispatchers waiting on each other', async () => {
    const on = await admin.client.request('PUT', '/v1/orders/workflow-settings', {
      body: { autoAssign: true, offerSeconds: 15, maxOpen: 25 },
    });
    expect(on.statusCode, on.body).toBe(200);
    const one = await harness.asRole('sales', ORG_A);
    const two = await harness.asRole('sales', ORG_A);
    await beat(one, { visible: true, idleSeconds: 0 });
    await beat(two, { visible: true, idleSeconds: 0 });
    const first = await take(admin);
    const second = await take(admin);
    // Each walked away from an offer that ran out a moment ago.
    const lapsed = await withSystem(
      async (tx) => {
        const rows = await tx.execute<{ id: string }>(sql`
          insert into sales.order_offers (org_id, order_id, user_id, offered_at, expires_at)
          values
            (${ORG_A}, ${first.id}, ${one.userId}, now() - interval '1 minute',
             now() - interval '1 second'),
            (${ORG_A}, ${second.id}, ${two.userId}, now() - interval '1 minute',
             now() - interval '1 second')
          returning id
        `);
        return [...rows].map((row) => row.id);
      },
      { orgId: ORG_A },
    );
    const results = await Promise.allSettled([
      offers.expire(ORG_A, lapsed[0] ?? ''),
      offers.expire(ORG_A, lapsed[1] ?? ''),
      offers.sweep(),
      offers.dispatch(ORG_A, first.id),
      offers.dispatch(ORG_A, second.id),
    ]);
    expect(results.filter((result) => result.status === 'rejected')).toEqual([]);
    const statuses = await withSystem(
      async (tx) => {
        const rows = await tx.execute<{ status: string }>(sql`
          select status from sales.order_offers
          where org_id = ${ORG_A} and id in (${lapsed[0] ?? ''}::uuid, ${lapsed[1] ?? ''}::uuid)
        `);
        return [...rows].map((row) => row.status);
      },
      { orgId: ORG_A },
    );
    expect(statuses).toEqual(['expired', 'expired']);
    // Never two live offers for one person.
    const doubled = await withSystem(
      async (tx) =>
        tx.execute<{ user_id: string }>(sql`
          select user_id from sales.order_offers
          where org_id = ${ORG_A} and status = 'offered' group by user_id having count(*) > 1
        `),
      { orgId: ORG_A },
    );
    expect([...doubled]).toEqual([]);
  }, 90_000);

  it('switching auto-assign off withdraws every live offer', async () => {
    const order = await take(admin);
    await beat(fresh, { visible: true, idleSeconds: 0 });
    await offers.dispatch(ORG_A, order.id);
    expect(await liveOfferOf(order.id)).toBeDefined();
    const off = await admin.client.request('PUT', '/v1/orders/workflow-settings', {
      body: { autoAssign: false, offerSeconds: 45, maxOpen: 25 },
    });
    expect(off.statusCode, off.body).toBe(200);
    expect(await liveOfferOf(order.id)).toBeUndefined();
    expect(await offers.dispatch(ORG_A, order.id)).toBe(0);
  }, 60_000);
});

// --- check 4 ----------------------------------------------------------------------------

describe('check 4: verification calls', () => {
  it('records each attempt, shows the count and the call-back, and puts due call-backs first', async () => {
    const plain = await take(admin, { assignedTo: rahim.userId });
    const due = await take(admin, { assignedTo: rahim.userId });
    const later = await take(admin, { assignedTo: rahim.userId });

    for (const outcome of ['no_answer', 'busy']) {
      const logged = await rahim.client.request('POST', `/v1/orders/${due.id}/calls`, {
        body: { outcome, note: `Tried: ${outcome}` },
      });
      expect(logged.statusCode, logged.body).toBe(201);
    }
    const inAnHour = new Date(Date.now() + 3_600_000).toISOString();
    const callBack = await rahim.client.request('POST', `/v1/orders/${due.id}/calls`, {
      body: { outcome: 'call_back', callBackAt: inAnHour, note: 'Asked to call after lunch' },
    });
    expect(callBack.statusCode, callBack.body).toBe(201);
    const inTwoHours = new Date(Date.now() + 7_200_000).toISOString();
    await rahim.client.request('POST', `/v1/orders/${later.id}/calls`, {
      body: { outcome: 'call_back', callBackAt: inTwoHours },
    });

    // A call-back needs its time, and nothing else has one.
    const noTime = await rahim.client.request('POST', `/v1/orders/${plain.id}/calls`, {
      body: { outcome: 'call_back' },
    });
    expect(noTime.statusCode).toBe(400);
    expect(codeOf(noTime)).toBe('ORDER_CALL_INVALID');
    const stray = await rahim.client.request('POST', `/v1/orders/${plain.id}/calls`, {
      body: { outcome: 'reached', callBackAt: inAnHour },
    });
    expect(codeOf(stray)).toBe('ORDER_CALL_INVALID');

    const list = body<{
      items: { outcome: string; callBackAt: string | null; calledBy: string }[];
    }>(await rahim.client.request('GET', `/v1/orders/${due.id}/calls`));
    expect(list.items.map((call) => call.outcome)).toEqual(['call_back', 'busy', 'no_answer']);
    expect(list.items[0]?.calledBy).toBe(rahim.userId);
    const summary = (await detail(due.id)).calls;
    expect(summary).toMatchObject({ attempts: 3, lastOutcome: 'call_back' });
    expect(summary.callBackAt).not.toBeNull();

    // The call-back comes due (the clock moved on, as it would by the afternoon).
    await withSystem(
      (tx) =>
        tx.execute(sql`
          update sales.orders set call_back_at = now() - interval '5 minutes'
          where org_id = ${ORG_A} and id = ${due.id}
        `),
      { orgId: ORG_A },
    );
    const mine = (await queue(rahim, 'queue=mine&status=pending'))
      .map((row) => row.id)
      .filter((id) => [plain.id, due.id, later.id].includes(id));
    expect(mine).toEqual([due.id, plain.id, later.id]);
    const callbacks = (await queue(rahim, 'queue=callbacks')).map((row) => row.id);
    expect(callbacks).toContain(due.id);
    expect(callbacks).not.toContain(later.id);
    expect((await queue(rahim, 'queue=verifying')).map((row) => row.id)).toEqual(
      expect.arrayContaining([due.id, later.id]),
    );

    // The record of a call is never edited, by anyone.
    await expect(
      withSystem(
        (tx) => tx.execute(sql`update sales.call_attempts set note = 'x' where org_id = ${ORG_A}`),
        { orgId: ORG_A },
      ),
    ).rejects.toThrow();
  }, 120_000);
});

// --- check 5 ----------------------------------------------------------------------------

describe('check 5: the hub and the desk', () => {
  it('shows the hub its own location’s confirmed orders, stage by stage, and the desk the progress', async () => {
    const profile = await admin.client.request('PUT', `/v1/team/profiles/${warehouse.userId}`, {
      body: { workTypes: [], hubLocationId: hub },
    });
    expect(profile.statusCode, profile.body).toBe(200);

    const atHub = await take(admin, { assignedTo: rahim.userId, locationId: hub });
    const elsewhere = await take(admin, { assignedTo: rahim.userId, locationId: location });
    for (const order of [atHub, elsewhere]) {
      const confirmed = await rahim.client.request('POST', `/v1/orders/${order.id}/confirm`);
      expect(confirmed.statusCode, confirmed.body).toBe(201);
    }

    const toPrint = (await queue(warehouse, 'queue=hub_print')).map((row) => row.id);
    expect(toPrint).toContain(atHub.id);
    expect(toPrint).not.toContain(elsewhere.id);
    // A supervisor with no hub sees every location's.
    expect((await queue(admin, 'queue=hub_print')).map((row) => row.id)).toEqual(
      expect.arrayContaining([atHub.id, elsewhere.id]),
    );
    expect((await detail(atHub.id, rahim)).hubStage).toBe('to_print');

    const printed = await warehouse.client.request('POST', '/v1/orders/mark-printed', {
      body: { ids: [atHub.id] },
    });
    expect(printed.statusCode, printed.body).toBe(201);
    expect((await queue(warehouse, 'queue=hub_packing')).map((row) => row.id)).toContain(atHub.id);
    expect((await queue(warehouse, 'queue=hub_print')).map((row) => row.id)).not.toContain(
      atHub.id,
    );
    expect((await detail(atHub.id, rahim)).hubStage).toBe('packing');

    expect((await warehouse.client.request('POST', `/v1/orders/${atHub.id}/pack`)).statusCode).toBe(
      201,
    );
    expect((await queue(warehouse, 'queue=hub_packed')).map((row) => row.id)).toContain(atHub.id);
    expect((await detail(atHub.id, rahim)).hubStage).toBe('packed');

    const shipped = await warehouse.client.request('POST', `/v1/orders/${atHub.id}/ship`, {
      body: { courierId, consignmentNo: `WF-${atHub.id.slice(0, 8)}` },
    });
    expect(shipped.statusCode, shipped.body).toBe(201);
    expect((await queue(warehouse, 'queue=hub_handed')).map((row) => row.id)).toContain(atHub.id);

    // The desk that sold it follows it: today's confirmations, with the hub's stage.
    const today = await queue(rahim, 'queue=confirmed_today');
    expect(today.find((row) => row.id === atHub.id)?.hubStage).toBe('handed_over');
    expect(today.find((row) => row.id === elsewhere.id)?.hubStage).toBe('to_print');
  }, 120_000);
});

// --- presence and desk profiles -------------------------------------------------------

describe('presence and desk profiles', () => {
  it('audits a change of presence and not a beat that changes nothing', async () => {
    const actor = await harness.asRole('sales', ORG_A);
    const count = async () =>
      withSystem(
        async (tx) => {
          const rows = await tx.execute<{ n: number }>(sql`
            select count(*)::int as n from audit.audit_log
            where org_id = ${ORG_A} and actor_user_id = ${actor.userId}
              and action like 'team.presence%'
          `);
          return rows[0]?.n ?? 0;
        },
        { orgId: ORG_A },
      );
    await beat(actor, { visible: true, idleSeconds: 0 });
    expect(await count()).toBe(1);
    await beat(actor, { visible: true, idleSeconds: 5 });
    await beat(actor, { visible: true, idleSeconds: 9 });
    expect(await count()).toBe(1);
    await beat(actor, { visible: false, idleSeconds: 0 });
    // Hidden, with the last input more than two minutes ago: idle, and that is a change.
    await withSystem(
      (tx) =>
        tx.execute(sql`
          update team.presence set last_active_at = now() - interval '10 minutes'
          where org_id = ${ORG_A} and user_id = ${actor.userId}
        `),
      { orgId: ORG_A },
    );
    expect((await beat(actor, { visible: false, idleSeconds: 0 })).state).toBe('idle');
    expect(await count()).toBe(2);
  }, 60_000);

  it('keeps desk profiles to the org admin and to people of this brand', async () => {
    expect((await rahim.client.request('GET', '/v1/team/profiles')).statusCode).toBe(403);
    const stranger = await otherBrandAdmin.client.request(
      'PUT',
      `/v1/team/profiles/${rahim.userId}`,
      { body: { workTypes: ['orders'], hubLocationId: null } },
    );
    expect(stranger.statusCode).toBe(404);
    const badHub = await admin.client.request('PUT', `/v1/team/profiles/${rahim.userId}`, {
      body: { workTypes: ['orders'], hubLocationId: '00000000-0000-4000-8000-000000000000' },
    });
    expect(badHub.statusCode).toBe(400);
    const me = body<{ profile: { workTypes: string[]; defaultProfile: boolean } }>(
      await rahim.client.request('GET', '/v1/team/me'),
    );
    expect(me.profile).toMatchObject({ workTypes: ['orders', 'messages'], defaultProfile: true });
  }, 60_000);
});
