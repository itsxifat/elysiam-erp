import { SEED_ORG_IDS } from '@elysium/db';

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

  prepared = {
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
    url: `/v1/orders/${await freshOrder('pending')}/assign`,
    body: { assignedTo: FIXTURE_USER },
  }),

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
    // A fresh number per call: the unique index on `(org_id, phone_e164)` would make the
    // second admitted role's create a 400 about a buyer that already exists.
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
