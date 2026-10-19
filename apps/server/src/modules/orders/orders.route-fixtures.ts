import { SEED_ORG_IDS, withSystem } from '@elysium/db';
import { createTestUser, grantMembership } from '@elysium/db/testing';
import { sql } from 'drizzle-orm';

import {
  seedProductWithSkus,
  warehouseId,
  type SeededSku,
} from '../inventory/inventory.testing.js';
import {
  applyOrderMigrations,
  ownRiderCourier,
  seedCustomer,
  seedAdvance,
  seedOrder,
  seedStockLevel,
  walletAccount,
  type SeedOrderLine,
} from './orders.testing.js';

/**
 * How the route-matrix suite calls M10's routes (M02b's D-070 gate).
 *
 * `route-matrix.e2e.test.ts` asserts that its fixture keys, the manifest and the
 * application's live routes are the same three sets — so the moment `OrdersModule` is
 * registered in `app.module.ts`, that suite fails until these exist. They live here rather
 * than in the suite because the suite is one file shared by every milestone building in
 * parallel, and a second write to it silently discards the first; the integrator adds one
 * import and one spread.
 *
 * ## Why every transition fixture builds its own order
 *
 * The suite drives each fixture **once per role** and asserts three things: the guard
 * admits exactly the roles §6 grants, no route answers 5xx, and every mutating route is
 * successfully exercised at least once with an audit row to show for it. A transition is
 * one-way, so a fixture pointing at a fixed order id would succeed for the first admitted
 * role and answer 409 for the rest — which satisfies the audit check and hides something
 * worse: if the *first* admitted role happens to be one whose row scope excludes the
 * order, nothing ever succeeds and the suite fails for a reason that has nothing to do
 * with permissions.
 *
 * So each fixture seeds a fresh order in exactly the status its transition starts from.
 * `seedOrder` writes the row at that status directly rather than walking it there, which
 * is legal (0041's trigger guards `UPDATE OF status`, not INSERT) and turns what would be
 * a four-request setup into three inserts.
 *
 * `prepare()` is idempotent and cheap after the first call: it applies this milestone's
 * migrations (the journal is integrated separately), seeds one product with three SKUs and
 * puts enough stock on the shelf that no fixture can run the warehouse out.
 */

interface Call {
  readonly url: string;
  readonly body?: unknown;
}

const ORG_A = SEED_ORG_IDS['elysium-lifestyle-bd'] ?? '';
const FIXTURE_USER = 'usr_orders_fixture';

/** Enough that dozens of confirms and dispatches across every role cannot exhaust it. */
const STOCKED = 500;
const UNIT_COST = 40_000n;
const UNIT_PRICE = 150_000n;

interface Fixtures {
  /** M41: a real sales agent, so an order can be handed to somebody who may hold it. */
  readonly agentId: string;
  readonly location: string;
  readonly customerId: string;
  readonly courierId: string;
  readonly walletAccountId: string;
  readonly skus: readonly SeededSku[];
}

let prepared: Fixtures | undefined;

/** Called once from the route-matrix suite's `beforeAll`. */
export async function prepareOrderFixtures(): Promise<void> {
  if (prepared !== undefined) return;
  await applyOrderMigrations();

  const location = await warehouseId(ORG_A);
  const { skus } = await seedProductWithSkus(ORG_A, 'ordermatrix', 3);
  for (const sku of skus) {
    await seedStockLevel(ORG_A, {
      skuId: sku.id,
      locationId: location,
      qty: STOCKED,
      unitCostPoisha: UNIT_COST,
    });
  }

  const agent = await createTestUser({ name: 'Route matrix agent' });
  await grantMembership({ userId: agent.id, orgId: ORG_A, role: 'sales' });

  prepared = {
    agentId: agent.id,
    location,
    customerId: await seedCustomer(ORG_A, {
      phoneE164: '+8801711000000',
      name: 'Route matrix buyer',
    }),
    courierId: await ownRiderCourier(ORG_A),
    walletAccountId: await walletAccount(ORG_A),
    skus,
  };
}

function state(): Fixtures {
  if (prepared === undefined) {
    throw new Error('call prepareOrderFixtures() in the suite’s beforeAll first');
  }
  return prepared;
}

function sku(index: number): SeededSku {
  const found = state().skus[index];
  if (found === undefined) throw new Error(`no fixture SKU ${String(index)}`);
  return found;
}

function line(index: number, overrides: Partial<SeedOrderLine> = {}): SeedOrderLine {
  const target = sku(index);
  return {
    skuId: target.id,
    skuCode: target.code,
    productName: 'Route matrix product',
    qty: 2,
    unitPricePoisha: UNIT_PRICE,
    ...overrides,
  };
}

/** A fresh order at `status`, with whatever that status implies already true of it. */
async function freshOrder(
  status: string,
  options: {
    readonly lines?: readonly SeedOrderLine[];
    readonly reserve?: boolean;
    readonly withCourier?: boolean;
    readonly assignedTo?: string | null;
    readonly advancePaidPoisha?: bigint;
  } = {},
): Promise<string> {
  const fixtures = state();
  const order = await seedOrder(ORG_A, {
    status,
    customerId: fixtures.customerId,
    locationId: fixtures.location,
    lines: options.lines ?? [line(0)],
    reserve: options.reserve ?? false,
    assignedTo: options.assignedTo ?? null,
    createdBy: FIXTURE_USER,
    ...(options.withCourier === true ? { courierId: fixtures.courierId } : {}),
    ...(options.advancePaidPoisha === undefined
      ? {}
      : { advancePaidPoisha: options.advancePaidPoisha }),
  });
  return order.id;
}

/**
 * A live offer of a fresh pending order to a fresh agent (M41). Its own agent each time: a
 * person holds one live offer at a time.
 */
async function freshOffer(): Promise<string> {
  const orderId = await freshOrder('pending');
  const agent = await createTestUser({ name: 'Route matrix offeree' });
  await grantMembership({ userId: agent.id, orgId: ORG_A, role: 'sales' });
  const rows = await withSystem(
    (tx) =>
      tx.execute<{ id: string }>(sql`
        insert into sales.order_offers (org_id, order_id, user_id, expires_at)
        values (${ORG_A}, ${orderId}, ${agent.id}, now() + interval '10 minutes')
        returning id
      `),
    { orgId: ORG_A },
  );
  const id = [...rows][0]?.id;
  if (id === undefined) throw new Error('the fixture offer was not written');
  return id;
}

/** A number nobody else has, so each admitted role's call meets a fresh buyer (M48). */
function freshPhone(): string {
  return `+88017${String(Math.floor(Math.random() * 90_000_000) + 10_000_000)}`;
}

/** A fresh buyer with no orders (so nobody's: every role with `update Customer` reaches them). */
async function freshPerson(extraPhones = 0): Promise<{ customerId: string; phoneIds: string[] }> {
  const customerId = await seedCustomer(ORG_A, { phoneE164: freshPhone(), name: 'Matrix person' });
  for (let index = 0; index < extraPhones; index += 1) {
    await withSystem(
      (tx) =>
        tx.execute(sql`
          insert into sales.customer_phones (org_id, customer_id, phone_e164, rank, source)
          values (${ORG_A}, ${customerId}, ${freshPhone()}, ${index + 2}, 'import')
        `),
      { orgId: ORG_A },
    );
  }
  const rows = await withSystem(
    (tx) =>
      tx.execute<{ id: string }>(sql`
        select id from sales.customer_phones
        where org_id = ${ORG_A} and customer_id = ${customerId} and retired_at is null
        order by rank
      `),
    { orgId: ORG_A },
  );
  return { customerId, phoneIds: [...rows].map((row) => row.id) };
}

/** M49 (D-894): a district and a thana in it, from the reference data. */
async function anyArea(): Promise<{ districtId: number; thanaId: number }> {
  const rows = await withSystem(
    (tx) =>
      tx.execute<{ district_id: number; thana_id: number }>(sql`
        select district_id, id as thana_id from ref.thanas order by id limit 1
      `),
    { orgId: ORG_A },
  );
  return { districtId: rows[0]?.district_id ?? 1, thanaId: rows[0]?.thana_id ?? 1 };
}

/**
 * M49 (D-894): a fresh buyer with a saved address of their own (not the default the seed gives
 * them), for replacing or removing it.
 */
async function personWithAddress(): Promise<{ customerId: string; addressId: string }> {
  const { customerId } = await freshPerson();
  const area = await anyArea();
  const rows = await withSystem(
    (tx) =>
      tx.execute<{ id: string }>(sql`
        insert into sales.customer_addresses
          (org_id, customer_id, district_id, thana_id, address_line, is_default)
        values (${ORG_A}, ${customerId}, ${area.districtId}, ${area.thanaId}, 'House 1, Road 2', false)
        returning id
      `),
    { orgId: ORG_A },
  );
  return { customerId, addressId: rows[0]?.id ?? '' };
}

/** A line as a shipped order carries it: the dispatch cost is already recorded. */
function dispatched(index: number, overrides: Partial<SeedOrderLine> = {}): SeedOrderLine {
  return line(index, { dispatchUnitCostPoisha: UNIT_COST, ...overrides });
}

export const ORDERS_ROUTE_FIXTURES: Readonly<Record<string, () => Promise<Call> | Call>> = {
  'GET /v1/orders': () => ({ url: '/v1/orders' }),

  'POST /v1/orders': () => ({
    url: '/v1/orders',
    body: {
      channel: 'phone',
      customerId: state().customerId,
      locationId: state().location,
      lines: [{ skuId: sku(0).id, qty: 1 }],
    },
  }),

  'GET /v1/orders/availability': () => ({
    url: `/v1/orders/availability?skuIds=${sku(0).id}&locationId=${state().location}`,
  }),

  'GET /v1/orders/:id': async () => ({ url: `/v1/orders/${await freshOrder('pending')}` }),

  'PATCH /v1/orders/:id': async () => ({
    url: `/v1/orders/${await freshOrder('pending')}`,
    body: { notes: 'Route matrix edit' },
  }),

  'POST /v1/orders/:id/confirm': async () => ({
    url: `/v1/orders/${await freshOrder('pending')}/confirm`,
  }),

  'POST /v1/orders/:id/hold': async () => ({
    url: `/v1/orders/${await freshOrder('confirmed', { reserve: true })}/hold`,
    body: { reason: 'Route matrix hold' },
  }),

  'POST /v1/orders/:id/release-hold': async () => ({
    url: `/v1/orders/${await freshOrder('on_hold', { reserve: true })}/release-hold`,
  }),

  'POST /v1/orders/:id/cancel': async () => ({
    url: `/v1/orders/${await freshOrder('confirmed', { reserve: true })}/cancel`,
    body: { reason: 'Route matrix cancel' },
  }),

  'POST /v1/orders/:id/pack': async () => ({
    url: `/v1/orders/${await freshOrder('confirmed', { reserve: true })}/pack`,
  }),

  'POST /v1/orders/:id/ship': async () => ({
    // Reserved, because `dispatch` consumes the hold: shipping an order that holds
    // nothing would drive `stock_levels.reserved` negative and be refused by a CHECK.
    url: `/v1/orders/${await freshOrder('packed', { reserve: true })}/ship`,
    body: { courierId: state().courierId, consignmentNo: 'RM-0001' },
  }),

  'POST /v1/orders/:id/deliver': async () => ({
    url: `/v1/orders/${await freshOrder('shipped', { lines: [dispatched(0)], withCourier: true })}/deliver`,
  }),

  'POST /v1/orders/:id/partial-delivery': async () => {
    const orderId = await freshOrder('shipped', {
      lines: [dispatched(0), dispatched(1)],
      withCourier: true,
    });
    return {
      url: `/v1/orders/${orderId}/partial-delivery`,
      body: { lines: [{ skuId: sku(0).id, deliveredQty: 2 }] },
    };
  },

  'POST /v1/orders/:id/start-return': async () => ({
    url: `/v1/orders/${await freshOrder('shipped', { lines: [dispatched(0)], withCourier: true })}/start-return`,
    body: { reason: 'Buyer refused the parcel' },
  }),

  'POST /v1/orders/:id/receive-return': async () => {
    const orderId = await freshOrder('return_in_transit', {
      lines: [dispatched(0)],
      withCourier: true,
    });
    return {
      url: `/v1/orders/${orderId}/receive-return`,
      body: {
        reason: 'Came back unopened',
        returnReason: 'customer_refused',
        locationId: state().location,
      },
    };
  },

  'POST /v1/orders/:id/assign': async () => ({
    // M41 (D-712): a queued order routed to an agent, which only a supervisor may do; everyone
    // else admitted is refused by the rule, not by the guard.
    url: `/v1/orders/${await freshOrder('pending')}/assign`,
    body: { assignedTo: state().agentId },
  }),

  // --- M41: release, calls, the hub's slips, offers, settings, the team board ----------

  'POST /v1/orders/:id/release': async () => ({
    // The agent's order, released by a supervisor; anyone else is refused by the rule.
    url: `/v1/orders/${await freshOrder('pending', { assignedTo: state().agentId })}/release`,
  }),

  'POST /v1/orders/:id/calls': async () => ({
    // Nobody holds it, so the owner's gate lets every admitted role in.
    url: `/v1/orders/${await freshOrder('pending')}/calls`,
    body: { outcome: 'no_answer', note: 'Route matrix call' },
  }),

  'GET /v1/orders/:id/calls': async () => ({
    url: `/v1/orders/${await freshOrder('pending')}/calls`,
  }),

  'POST /v1/orders/mark-printed': async () => ({
    url: '/v1/orders/mark-printed',
    body: { ids: [await freshOrder('confirmed', { reserve: true })] },
  }),

  'GET /v1/orders/offers/mine': () => ({ url: '/v1/orders/offers/mine' }),

  'POST /v1/orders/offers/:id/accept': async () => ({
    // Offered to the agent, so every caller here is somebody else: refused, never 5xx.
    url: `/v1/orders/offers/${await freshOffer()}/accept`,
  }),

  'POST /v1/orders/offers/:id/decline': async () => ({
    url: `/v1/orders/offers/${await freshOffer()}/decline`,
  }),

  'GET /v1/orders/workflow-settings': () => ({ url: '/v1/orders/workflow-settings' }),

  'PUT /v1/orders/workflow-settings': () => ({
    url: '/v1/orders/workflow-settings',
    body: { autoAssign: false, offerSeconds: 45, maxOpen: 25 },
  }),

  'GET /v1/orders/team-board': () => ({ url: '/v1/orders/team-board' }),

  'POST /v1/orders/:id/claim': async () => ({
    url: `/v1/orders/${await freshOrder('pending')}/claim`,
  }),

  // --- M17: advances and return reasons ------------------------------------------

  'GET /v1/orders/:id/advances': async () => ({
    url: `/v1/orders/${await freshOrder('pending')}/advances`,
  }),

  'POST /v1/orders/:id/advances': async () => ({
    // A fresh reference per call: one bKash payment backs one live claim.
    url: `/v1/orders/${await freshOrder('pending')}/advances`,
    body: {
      method: 'bkash',
      transactionRef: `RM${String(Date.now()).slice(-8)}${String(Math.floor(Math.random() * 1e6))}`,
      amountPoisha: '10000',
    },
  }),

  'GET /v1/order-advances': () => ({ url: '/v1/order-advances' }),

  'POST /v1/order-advances/:id/verify': async () => {
    // Recorded by the fixture user, so every admitted role is somebody else (four eyes).
    const orderId = await freshOrder('pending');
    const id = await seedAdvance(ORG_A, {
      orderId,
      status: 'pending',
      amountPoisha: 10_000n,
      walletAccountId: state().walletAccountId,
    });
    return {
      url: `/v1/order-advances/${id}/verify`,
      body: { walletAccountId: state().walletAccountId },
    };
  },

  'POST /v1/order-advances/:id/reject': async () => {
    const orderId = await freshOrder('pending');
    const id = await seedAdvance(ORG_A, {
      orderId,
      status: 'pending',
      amountPoisha: 10_000n,
      walletAccountId: state().walletAccountId,
    });
    return {
      url: `/v1/order-advances/${id}/reject`,
      body: { reason: 'No such payment in the bKash statement' },
    };
  },

  'POST /v1/order-advances/:id/refund': async () => {
    // Owed back after a cancel, with its received journal already posted.
    const orderId = await freshOrder('cancelled');
    const id = await seedAdvance(ORG_A, {
      orderId,
      status: 'refund_due',
      amountPoisha: 10_000n,
      walletAccountId: state().walletAccountId,
    });
    return { url: `/v1/order-advances/${id}/refund`, body: {} };
  },

  'POST /v1/order-advances/:id/void': async () => {
    // Verified on a pending order that carries it, with no parcel: undoable (D-236).
    const orderId = await freshOrder('pending', { advancePaidPoisha: 10_000n });
    const id = await seedAdvance(ORG_A, {
      orderId,
      status: 'verified',
      amountPoisha: 10_000n,
      walletAccountId: state().walletAccountId,
    });
    return {
      url: `/v1/order-advances/${id}/void`,
      body: { reason: 'Verified against the wrong statement line' },
    };
  },

  'GET /v1/orders/return-reasons': () => ({
    url: '/v1/orders/return-reasons?from=2026-01-01&to=2026-12-31',
  }),

  'POST /v1/orders/:id/exchange': async () => {
    // Delivered in full, with the dispatch cost recorded: the exchange puts those units
    // back at that cost and turns what was paid for them into a credit (§9).
    const orderId = await freshOrder('delivered', {
      lines: [dispatched(0, { deliveredQty: 2 })],
      withCourier: true,
    });
    return {
      url: `/v1/orders/${orderId}/exchange`,
      body: {
        reason: 'Wrong size delivered',
        returnReason: 'size_issue',
        returnLines: [{ skuId: sku(0).id, qty: 1 }],
        lines: [{ skuId: sku(1).id, qty: 1 }],
        locationId: state().location,
      },
    };
  },

  'GET /v1/orders/:id/document': async () => ({
    url: `/v1/orders/${await freshOrder('pending')}/document?kind=invoice`,
  }),

  // --- M11: the order desk ------------------------------------------------------

  'GET /v1/orders/duplicates': () => ({
    url: `/v1/orders/duplicates?phone=01711000000&skuIds=${sku(0).id}`,
  }),

  'GET /v1/orders/agents': () => ({ url: '/v1/orders/agents' }),

  'POST /v1/orders/bulk-confirm': async () => ({
    // A fresh pending order per admitted role, unassigned so a sales agent's queue reaches
    // it. A role whose scope or §9 row cannot confirm it still gets a 201 with the refusal
    // reported against the id — which is the route's contract, and still an audited call.
    url: '/v1/orders/bulk-confirm',
    body: { ids: [await freshOrder('pending')] },
  }),

  'POST /v1/orders/bulk-transition': async () => ({
    // A fresh confirmed, reserved order per admitted role, packed through the single path.
    // A role whose scope cannot reach it still gets a 201 with the refusal against its id.
    url: '/v1/orders/bulk-transition',
    body: { ids: [await freshOrder('confirmed', { reserve: true })], trigger: 'pack' },
  }),

  'GET /v1/orders/documents': async () => ({
    url: `/v1/orders/documents?ids=${await freshOrder('pending')}&kind=label`,
  }),

  'GET /v1/customers/lookup': () => ({ url: '/v1/customers/lookup?phone=01711000000' }),

  'GET /v1/delivery-zones/areas': () => ({ url: '/v1/delivery-zones/areas' }),

  'GET /v1/buyers': () => ({ url: '/v1/buyers?limit=5' }),

  'GET /v1/buyers/export': () => ({ url: '/v1/buyers/export?format=csv&size=M' }),

  'GET /v1/crm/reengagement': () => ({ url: '/v1/crm/reengagement?days=30&limit=5' }),

  'GET /v1/crm/reengagement/export': () => ({ url: '/v1/crm/reengagement/export?days=30' }),

  'GET /v1/customers': () => ({ url: '/v1/customers' }),

  'POST /v1/customers': () => ({
    url: '/v1/customers',
    // A fresh number per call, so every admitted role's create makes a new buyer rather than
    // finding the first role's (M48: the number names whoever uses it).
    body: {
      phone: `+88017${String(Math.floor(Math.random() * 90_000_000) + 10_000_000)}`,
      name: 'Route matrix buyer',
    },
  }),

  'GET /v1/customers/:id': () => ({ url: `/v1/customers/${state().customerId}` }),

  'GET /v1/customers/:id/profile': () => ({
    url: `/v1/customers/${state().customerId}/profile`,
  }),

  'PATCH /v1/customers/:id': () => ({
    url: `/v1/customers/${state().customerId}`,
    body: { name: 'Route matrix buyer' },
  }),

  // M48 (D-870 to D-886): a buyer's numbers, merges and an order's buyer.
  'POST /v1/customers/:id/phones': async () => ({
    url: `/v1/customers/${(await freshPerson()).customerId}/phones`,
    body: { phone: freshPhone(), relation: 'work', note: 'Office line, weekdays' },
  }),

  'PATCH /v1/customers/:id/phones/:phoneId': async () => {
    const person = await freshPerson(1);
    return {
      url: `/v1/customers/${person.customerId}/phones/${person.phoneIds[1] ?? ''}`,
      body: { note: 'Her sister’s phone, evenings', rank: 1 },
    };
  },

  'POST /v1/customers/:id/phones/:phoneId/retire': async () => {
    const person = await freshPerson(1);
    return {
      url: `/v1/customers/${person.customerId}/phones/${person.phoneIds[1] ?? ''}/retire`,
      body: { reason: 'changed_number' },
    };
  },

  // M49 (D-894): the address book. A fresh buyer each call, so every admitted role succeeds.
  'POST /v1/customers/:id/addresses': async () => ({
    url: `/v1/customers/${(await freshPerson()).customerId}/addresses`,
    body: { ...(await anyArea()), addressLine: 'House 12, Road 5', label: 'Home' },
  }),

  'PUT /v1/customers/:id/addresses/:addressId': async () => {
    const person = await personWithAddress();
    return {
      url: `/v1/customers/${person.customerId}/addresses/${person.addressId}`,
      body: { ...(await anyArea()), addressLine: 'House 14, Road 5', label: 'Office' },
    };
  },

  'DELETE /v1/customers/:id/addresses/:addressId': async () => {
    const person = await personWithAddress();
    return { url: `/v1/customers/${person.customerId}/addresses/${person.addressId}` };
  },

  'POST /v1/customers/:id/merge': async () => {
    // Supervisors only (D-886): the others with `update Customer` meet the service's refusal.
    const kept = await freshPerson();
    const other = await freshPerson();
    return {
      url: `/v1/customers/${kept.customerId}/merge`,
      body: { otherCustomerId: other.customerId, reason: 'The same person, entered twice' },
    };
  },

  'POST /v1/orders/:id/buyer': async () => ({
    url: `/v1/orders/${await freshOrder('pending')}/buyer`,
    body: { customerId: (await freshPerson()).customerId, reason: 'Ordered by her husband' },
  }),

  'POST /v1/orders/:id/buyer-checked': async () => ({
    url: `/v1/orders/${await freshOrder('pending')}/buyer-checked`,
  }),

  'PUT /v1/customers/:id/pinned-note': () => ({
    url: `/v1/customers/${state().customerId}/pinned-note`,
    body: { body: 'Route matrix note' },
  }),

  'GET /v1/delivery-zones': () => ({ url: '/v1/delivery-zones' }),

  // District 47 is Dhaka, which migration 0042 maps to `inside_dhaka` for every org.
  'GET /v1/delivery-zones/for-area': () => ({ url: '/v1/delivery-zones/for-area?districtId=47' }),

  'PUT /v1/delivery-zones': () => ({
    url: '/v1/delivery-zones',
    // A fixed code, because the write is an upsert on `(org_id, code)` — so every
    // admitted role succeeds and no run leaves a trail of junk zones behind it.
    body: {
      code: 'route_matrix',
      nameEn: 'Route matrix zone',
      chargePoisha: '9000',
    },
  }),
};

/** The manifest entries the integrator appends, derived from the fixtures. */
export const ORDERS_ROUTE_KEYS: readonly string[] = Object.keys(ORDERS_ROUTE_FIXTURES);
